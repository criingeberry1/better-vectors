/**
 * Better Vectors v1.2.0 — Enhanced Data Bank injection for SillyTavern
 * IIFE pattern — zero ES imports, hooks into existing Vector Storage safely.
 *
 * @author your insomnia & claude code
 */
(function () {
    'use strict';

    const MODULE_NAME = 'better-vectors';
    const EXTENSION_PROMPT_TAG_DB = '4_vectors_data_bank';
    const LOG = '[BetterVectors]';

    // ─── Default Settings ───────────────────────────────────────────────────
    const defaultSettings = {
        enabled: true,
        inject_file_headers: true,
        parse_dates: true,
        sort_by_date: false,
        header_format: '--- {{date}}{{filename}} ---',
        section_template: '{{header}}\n{{chunks}}',
        wrapper_template: '[Relevant Lore]\n\n{{sections}}',
        debug_log: false,
    };

    // ─── Captured data from original's fetch ────────────────────────────────
    let capturedQueryMultiResult = null;
    let context = null;

    // ─── Safe context getter ────────────────────────────────────────────────
    function ctx() {
        try {
            if (!context) context = SillyTavern.getContext();
            return context;
        } catch (e) {
            console.error(LOG, 'Failed to get ST context', e);
            return null;
        }
    }

    // ─── Settings ───────────────────────────────────────────────────────────
    function getSettings() {
        const c = ctx();
        if (!c) return Object.assign({}, defaultSettings);
        if (!c.extensionSettings[MODULE_NAME]) {
            c.extensionSettings[MODULE_NAME] = Object.assign({}, defaultSettings);
        }
        return c.extensionSettings[MODULE_NAME];
    }

    function saveSettings() {
        try {
            const c = ctx();
            if (c) c.saveSettingsDebounced();
        } catch (e) {
            console.warn(LOG, 'Failed to save settings', e);
        }
    }

    // ─── Date Parsing ───────────────────────────────────────────────────────
    function parseDateFromFilename(filename, createdTimestamp) {
        const base = filename.replace(/\.[^.]+$/, '');

        // YYYY-MM-DD / YYYY.MM.DD / YYYY_MM_DD
        const iso = base.match(/(\d{4})[-._](\d{1,2})[-._](\d{1,2})/);
        if (iso) {
            const [full, y, m, d] = iso;
            const dateStr = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
            const clean = base.replace(full, '').replace(/^[-_.\s]+|[-_.\s]+$/g, '').trim();
            return { dateStr, cleanName: clean || base };
        }

        // DD-MM-YYYY / DD.MM.YYYY
        const eu = base.match(/(\d{1,2})[-._](\d{1,2})[-._](\d{4})/);
        if (eu) {
            const [full, d, m, y] = eu;
            const dateStr = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
            const clean = base.replace(full, '').replace(/^[-_.\s]+|[-_.\s]+$/g, '').trim();
            return { dateStr, cleanName: clean || base };
        }

        // Fallback: file creation timestamp
        if (createdTimestamp) {
            const dt = new Date(createdTimestamp);
            if (!isNaN(dt.getTime())) {
                return { dateStr: dt.toISOString().split('T')[0], cleanName: base };
            }
        }

        return { dateStr: null, cleanName: base };
    }

    // ─── File Metadata ──────────────────────────────────────────────────────
    function getStringHash(str) {
        try {
            const c = ctx();
            if (c && typeof c.getStringHash === 'function') {
                return c.getStringHash(str);
            }
            // Fallback: djb2
            let hash = 5381;
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xFFFFFFFF;
            }
            return hash;
        } catch (e) {
            return 0;
        }
    }

    function getFileCollectionId(fileUrl) {
        return `file_${getStringHash(fileUrl)}`;
    }

    /**
     * Safely access Data Bank attachments without ES imports.
     */
    function getDataBankAttachmentsSafe() {
        try {
            const c = ctx();
            if (!c) return [];

            const globalAtt = c.extensionSettings?.attachments ?? [];
            const chatAtt = c.chatMetadata?.attachments ?? [];

            let charAtt = [];
            try {
                const avatar = c.characters?.[c.characterId]?.avatar;
                if (avatar) {
                    charAtt = c.extensionSettings?.character_attachments?.[avatar] ?? [];
                }
            } catch (e) { /* ignore */ }

            const all = [...globalAtt, ...chatAtt, ...charAtt];
            return all.filter(x => !x.disabled);
        } catch (e) {
            console.warn(LOG, 'Failed to get Data Bank attachments', e);
            return [];
        }
    }

    function buildFileMetadataMap() {
        const map = new Map();
        try {
            const attachments = getDataBankAttachmentsSafe();
            for (const file of attachments) {
                const cid = getFileCollectionId(file.url);
                const { dateStr, cleanName } = parseDateFromFilename(file.name, file.created);
                map.set(cid, { name: file.name, dateStr, cleanName });
            }
        } catch (e) {
            console.warn(LOG, 'Failed to build metadata map', e);
        }
        return map;
    }

    // ─── Format header ──────────────────────────────────────────────────────
    function formatFileHeader(meta) {
        const s = getSettings();
        if (!s.inject_file_headers) return '';

        let header = s.header_format;
        const datePart = (s.parse_dates && meta.dateStr) ? `${meta.dateStr} | ` : '';
        header = header.replace('{{date}}', datePart);
        header = header.replace('{{filename}}', meta.cleanName || meta.name);
        return header;
    }

    // ─── Build enhanced prompt from captured data ───────────────────────────
    function buildEnhancedPrompt() {
        const s = getSettings();

        if (!capturedQueryMultiResult) {
            if (s.debug_log) console.debug(LOG, 'No captured query-multi data');
            return null;
        }

        const fileMetaMap = buildFileMetadataMap();
        if (fileMetaMap.size === 0) {
            if (s.debug_log) console.debug(LOG, 'No file metadata available');
            return null;
        }

        const fileSections = [];

        for (const [collectionId, result] of Object.entries(capturedQueryMultiResult)) {
            if (!result?.metadata) continue;

            const chunks = result.metadata
                .filter(x => x.text)
                .sort((a, b) => a.index - b.index)
                .map(x => x.text)
                .filter((v, i, a) => a.indexOf(v) === i);

            if (chunks.length === 0) continue;

            const meta = fileMetaMap.get(collectionId);
            if (!meta) continue;

            const header = formatFileHeader(meta);
            const chunkText = chunks.join('\n');

            let section = s.section_template;
            section = section.replace('{{header}}', header);
            section = section.replace('{{chunks}}', chunkText);

            fileSections.push({
                section: section.trim(),
                dateStr: meta.dateStr,
                name: meta.name,
            });
        }

        if (fileSections.length === 0) return null;

        if (s.sort_by_date) {
            fileSections.sort((a, b) => {
                if (a.dateStr && b.dateStr) return a.dateStr.localeCompare(b.dateStr);
                if (a.dateStr) return -1;
                if (b.dateStr) return 1;
                return a.name.localeCompare(b.name);
            });
        }

        const sectionsText = fileSections.map(x => x.section).join('\n\n');
        return s.wrapper_template.replace('{{sections}}', sectionsText);
    }

    // ─── Fetch Interceptor ──────────────────────────────────────────────────
    let fetchPatched = false;
    const nativeFetch = window.fetch.bind(window);

    function patchFetch() {
        if (fetchPatched) return;

        window.fetch = async function (input, init) {
            // ALWAYS call original first
            const response = await nativeFetch(input, init);

            try {
                const s = getSettings();
                if (!s.enabled) return response;

                const url = typeof input === 'string' ? input
                    : (input instanceof Request) ? input.url
                    : '';

                if (url.includes('/api/vector/query-multi')) {
                    const cloned = response.clone();
                    capturedQueryMultiResult = await cloned.json();

                    if (s.debug_log) {
                        console.debug(LOG, 'Intercepted query-multi:', Object.keys(capturedQueryMultiResult));
                    }
                }
            } catch (e) {
                // Never break original flow
            }

            return response;
        };

        fetchPatched = true;
        console.log(LOG, 'Fetch interceptor installed');
    }

    // ─── Hook rearrangeChat ─────────────────────────────────────────────────
    let originalRearrangeChat = null;

    async function betterRearrangeChat(chat, contextSize, abort, type) {
        capturedQueryMultiResult = null;

        // ALWAYS call original — re-throw its errors untouched
        if (typeof originalRearrangeChat === 'function') {
            await originalRearrangeChat(chat, contextSize, abort, type);
        }

        // Enhancement layer — fully wrapped, cannot break anything
        try {
            const s = getSettings();
            if (!s.enabled || type === 'quiet') return;

            const enhanced = buildEnhancedPrompt();
            if (!enhanced) return;

            const c = ctx();
            if (!c || typeof c.setExtensionPrompt !== 'function') return;

            const vs = c.extensionSettings?.vectors || {};

            c.setExtensionPrompt(
                EXTENSION_PROMPT_TAG_DB,
                enhanced,
                vs.file_position_db,
                vs.file_depth_db,
                vs.include_wi,
                vs.file_depth_role_db,
            );

            if (s.debug_log) {
                console.log(LOG, 'Data Bank prompt enhanced');
            }
        } catch (e) {
            console.warn(LOG, 'Enhancement failed (non-fatal):', e.message);
        }
    }

    function hookRearrangeChat() {
        if (typeof globalThis.vectors_rearrangeChat !== 'function') return false;

        originalRearrangeChat = globalThis.vectors_rearrangeChat;
        globalThis.vectors_rearrangeChat = betterRearrangeChat;
        console.log(LOG, 'Hooked into vectors_rearrangeChat');
        return true;
    }

    // ─── Settings UI ────────────────────────────────────────────────────────
    async function loadSettingsUI() {
        let html;
        try {
            const resp = await nativeFetch(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            html = await resp.text();
        } catch (e) {
            console.warn(LOG, 'Settings HTML not found, using inline fallback');
            html = `
            <div class="better-vectors-settings">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>Better Vectors</b>
                        <span id="bv_status" class="bv-status-badge">...</span>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <div class="flex-container flexFlowColumn">
                            <label class="checkbox_label" for="bv_enabled">
                                <input id="bv_enabled" type="checkbox" class="checkbox">
                                <span>Enable Better Vectors</span>
                            </label>
                            <label class="checkbox_label" for="bv_inject_file_headers">
                                <input id="bv_inject_file_headers" type="checkbox" class="checkbox">
                                <span>Inject file headers</span>
                            </label>
                            <label class="checkbox_label" for="bv_parse_dates">
                                <input id="bv_parse_dates" type="checkbox" class="checkbox">
                                <span>Parse dates from filenames</span>
                            </label>
                            <label class="checkbox_label" for="bv_sort_by_date">
                                <input id="bv_sort_by_date" type="checkbox" class="checkbox">
                                <span>Sort by date</span>
                            </label>
                            <label class="checkbox_label" for="bv_debug_log">
                                <input id="bv_debug_log" type="checkbox" class="checkbox">
                                <span>Debug log</span>
                            </label>
                            <hr>
                            <label for="bv_header_format">Header format <small>({{date}} {{filename}})</small></label>
                            <input id="bv_header_format" class="text_pole" type="text">
                            <label for="bv_section_template">Section template <small>({{header}} {{chunks}})</small></label>
                            <textarea id="bv_section_template" class="text_pole" rows="2"></textarea>
                            <label for="bv_wrapper_template">Wrapper template <small>({{sections}})</small></label>
                            <textarea id="bv_wrapper_template" class="text_pole" rows="3"></textarea>
                        </div>
                    </div>
                </div>
            </div>`;
        }

        $('#extensions_settings').append(html);

        const s = getSettings();

        const checks = {
            '#bv_enabled': 'enabled',
            '#bv_inject_file_headers': 'inject_file_headers',
            '#bv_parse_dates': 'parse_dates',
            '#bv_sort_by_date': 'sort_by_date',
            '#bv_debug_log': 'debug_log',
        };
        for (const [sel, key] of Object.entries(checks)) {
            $(sel).prop('checked', s[key]).on('change', function () {
                s[key] = !!$(this).prop('checked');
                saveSettings();
                if (key === 'enabled') updateStatusIndicator();
            });
        }

        const texts = {
            '#bv_header_format': 'header_format',
            '#bv_section_template': 'section_template',
            '#bv_wrapper_template': 'wrapper_template',
        };
        for (const [sel, key] of Object.entries(texts)) {
            $(sel).val(s[key]).on('input', function () {
                s[key] = String($(this).val());
                saveSettings();
            });
        }

        updateStatusIndicator();
    }

    function updateStatusIndicator() {
        const s = getSettings();
        const $el = $('#bv_status');
        if (s.enabled) {
            $el.text('Active').removeClass('bv-inactive').addClass('bv-active');
        } else {
            $el.text('Inactive').removeClass('bv-active').addClass('bv-inactive');
        }
    }

    // ─── Init ───────────────────────────────────────────────────────────────
    function init() {
        try {
            patchFetch();
            loadSettingsUI().catch(e => console.warn(LOG, 'UI load failed:', e.message));

            if (hookRearrangeChat()) return;

            // Poll for Vector Storage to appear
            let attempts = 0;
            const poll = setInterval(() => {
                attempts++;
                if (hookRearrangeChat() || attempts >= 60) {
                    clearInterval(poll);
                    if (attempts >= 60) {
                        console.warn(LOG, 'Vector Storage not detected after 15s');
                    }
                }
            }, 250);
        } catch (e) {
            console.error(LOG, 'Init failed:', e);
        }
    }

    // Start with a small delay to let built-in extensions register first
    $(document).ready(() => setTimeout(init, 300));
})();
