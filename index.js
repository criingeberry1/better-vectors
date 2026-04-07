/**
 * Better Vectors v1.4.1
 * IIFE pattern. Intercepts query-multi response to reformat Data Bank prompt
 * with per-file grouping and headers (dates, filenames).
 *
 * @author your insomnia & claude code
 */
(function () {
    'use strict';

    const MODULE_NAME = 'better-vectors';
    const EXTENSION_PROMPT_TAG_DB = '4_vectors_data_bank';
    const LOG = '[BetterVectors]';

    const defaultSettings = {
        enabled: true,
        inject_file_headers: true,
        parse_dates: true,
        sort_by_date: true,
        header_format: '--- {{date}}{{filename}} ---',
        section_template: '{{header}}\n{{chunks}}',
        wrapper_template: '[Relevant Lore]\n\n{{sections}}',
        debug_log: false,
    };

    let capturedQueryMultiResult = null;
    let originalRearrangeChat = null;
    let hooked = false;

    // ─── Context ────────────────────────────────────────────────────────────
    function ctx() {
        try { return SillyTavern.getContext(); }
        catch (e) { return null; }
    }

    function getSettings() {
        try {
            const c = ctx();
            if (!c) return Object.assign({}, defaultSettings);
            if (!c.extensionSettings[MODULE_NAME]) {
                c.extensionSettings[MODULE_NAME] = Object.assign({}, defaultSettings);
            }
            return c.extensionSettings[MODULE_NAME];
        } catch (e) { return Object.assign({}, defaultSettings); }
    }

    function saveSettings() {
        try { ctx()?.saveSettingsDebounced(); } catch (e) { /* */ }
    }

    // ─── Date Parsing ───────────────────────────────────────────────────────
    function parseDateFromFilename(filename, created) {
        const base = filename.replace(/\.[^.]+$/, '');

        const iso = base.match(/(\d{4})[-._](\d{1,2})[-._](\d{1,2})/);
        if (iso) {
            const [full, y, m, d] = iso;
            const ds = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
            const clean = base.replace(full, '').replace(/^[-_.\s]+|[-_.\s]+$/g, '').trim();
            return { dateStr: ds, cleanName: clean || base };
        }

        const eu = base.match(/(\d{1,2})[-._](\d{1,2})[-._](\d{4})/);
        if (eu) {
            const [full, d, m, y] = eu;
            const ds = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
            const clean = base.replace(full, '').replace(/^[-_.\s]+|[-_.\s]+$/g, '').trim();
            return { dateStr: ds, cleanName: clean || base };
        }

        if (created) {
            const dt = new Date(created);
            if (!isNaN(dt.getTime())) {
                return { dateStr: dt.toISOString().split('T')[0], cleanName: base };
            }
        }

        return { dateStr: null, cleanName: base };
    }

    // ─── File Metadata (from Data Bank attachments via context) ─────────────
    // Must match ST's getStringHash from utils.js exactly (MurmurHash3 variant)
    function getStringHash(str, seed) {
        if (typeof str !== 'string') return 0;
        seed = seed || 0;
        let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    function getFileCollectionId(url) {
        return `file_${getStringHash(url)}`;
    }

    function getDataBankFiles() {
        try {
            const c = ctx();
            if (!c) return [];
            const g = c.extensionSettings?.attachments ?? [];
            const ch = c.chatMetadata?.attachments ?? [];
            let ca = [];
            try {
                const av = c.characters?.[c.characterId]?.avatar;
                if (av) ca = c.extensionSettings?.character_attachments?.[av] ?? [];
            } catch (e) { /* */ }
            return [...g, ...ch, ...ca].filter(x => !x.disabled);
        } catch (e) { return []; }
    }

    function buildFileMetadataMap() {
        const map = new Map();
        for (const f of getDataBankFiles()) {
            const cid = getFileCollectionId(f.url);
            const { dateStr, cleanName } = parseDateFromFilename(f.name, f.created);
            map.set(cid, { name: f.name, dateStr, cleanName });
        }
        return map;
    }

    // ─── Format ─────────────────────────────────────────────────────────────
    function formatFileHeader(meta) {
        const s = getSettings();
        if (!s.inject_file_headers) return '';
        let h = s.header_format;
        const dp = (s.parse_dates && meta.dateStr) ? `${meta.dateStr} | ` : '';
        h = h.replace('{{date}}', dp);
        h = h.replace('{{filename}}', meta.cleanName || meta.name);
        return h;
    }

    function buildEnhancedPrompt() {
        const s = getSettings();
        if (!capturedQueryMultiResult) return null;

        const fileMetaMap = buildFileMetadataMap();
        if (fileMetaMap.size === 0) {
            if (s.debug_log) console.debug(LOG, 'No file metadata');
            return null;
        }

        const sections = [];
        for (const [cid, result] of Object.entries(capturedQueryMultiResult)) {
            if (!result?.metadata) continue;
            const chunks = result.metadata
                .filter(x => x.text)
                .sort((a, b) => a.index - b.index)
                .map(x => x.text)
                .filter((v, i, a) => a.indexOf(v) === i);
            if (!chunks.length) continue;

            const meta = fileMetaMap.get(cid);
            if (!meta) continue;

            const header = formatFileHeader(meta);
            let sec = s.section_template
                .replace('{{header}}', header)
                .replace('{{chunks}}', chunks.join('\n'));

            sections.push({ section: sec.trim(), dateStr: meta.dateStr, name: meta.name });
        }

        if (!sections.length) return null;

        if (s.sort_by_date) {
            sections.sort((a, b) => {
                if (a.dateStr && b.dateStr) return a.dateStr.localeCompare(b.dateStr);
                if (a.dateStr) return -1;
                if (b.dateStr) return 1;
                return a.name.localeCompare(b.name);
            });
        }

        const text = sections.map(x => x.section).join('\n\n');
        return s.wrapper_template.replace('{{sections}}', text);
    }

    // ─── Fetch Intercept ────────────────────────────────────────────────────
    // Save a direct reference to the REAL fetch ONCE at load time
    const _realFetch = window.fetch;

    function installFetchIntercept() {
        window.fetch = function betterVectorsFetch(input, init) {
            // ALWAYS use the real fetch — never recurse
            const promise = _realFetch.apply(window, arguments);

            // Only attempt interception if enabled
            try {
                const s = getSettings();
                if (!s.enabled) return promise;

                const url = typeof input === 'string' ? input
                    : (input instanceof Request) ? input.url : '';

                if (url.includes('/api/vector/query-multi')) {
                    // Return a chained promise that captures the response
                    return promise.then(function (response) {
                        // Clone BEFORE anyone reads the body
                        const cloned = response.clone();
                        // Read clone in background — don't await, don't block
                        cloned.json().then(function (data) {
                            capturedQueryMultiResult = data;
                            if (s.debug_log) {
                                console.debug(LOG, 'Captured query-multi:', Object.keys(data));
                            }
                        }).catch(function () { /* silent */ });
                        // Return original untouched
                        return response;
                    });
                }
            } catch (e) {
                // Never break fetch
            }

            return promise;
        };

        console.log(LOG, 'Fetch intercept installed');
    }

    // ─── Hook rearrangeChat ─────────────────────────────────────────────────
    async function betterRearrangeChat(chat, contextSize, abort, type) {
        capturedQueryMultiResult = null;

        // ALWAYS call original — re-throw errors
        if (typeof originalRearrangeChat === 'function') {
            await originalRearrangeChat(chat, contextSize, abort, type);
        }

        // Our enhancement — fully wrapped
        try {
            const s = getSettings();
            if (!s.enabled || type === 'quiet') return;

            const enhanced = buildEnhancedPrompt();
            if (!enhanced) {
                if (s.debug_log) console.debug(LOG, 'No enhanced prompt built');
                return;
            }

            const c = ctx();
            if (!c || typeof c.setExtensionPrompt !== 'function') return;

            const vs = c.extensionSettings?.vectors || {};
            c.setExtensionPrompt(
                EXTENSION_PROMPT_TAG_DB,
                enhanced,
                vs.file_position_db ?? 0,
                vs.file_depth_db ?? 4,
                vs.include_wi ?? false,
                vs.file_depth_role_db ?? 0,
            );

            if (s.debug_log) {
                console.log(LOG, 'Enhanced DB prompt injected:\n', enhanced.substring(0, 500));
            }
        } catch (e) {
            console.warn(LOG, 'Enhancement failed (non-fatal):', e.message);
        }
    }

    function tryHook() {
        if (hooked) return true;
        if (typeof globalThis.vectors_rearrangeChat !== 'function') return false;

        originalRearrangeChat = globalThis.vectors_rearrangeChat;
        globalThis.vectors_rearrangeChat = betterRearrangeChat;
        hooked = true;
        console.log(LOG, 'Hooked into vectors_rearrangeChat');
        return true;
    }

    // ─── Settings UI ────────────────────────────────────────────────────────
    function loadUI() {
        const s = getSettings();
        const html = `
        <div class="better-vectors-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Better Vectors</b>
                    <span id="bv_status" style="font-size:0.75em;margin-left:6px;">...</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="flex-container flexFlowColumn">
                        <small style="color:var(--SmartThemeQuoteColor);margin-bottom:6px;">
                            Groups Data Bank chunks by source file with headers (filename + date). Hooks into Vector Storage — does not replace it.
                        </small>
                        <hr style="border:none;border-top:1px solid var(--SmartThemeBorderColor);margin:6px 0;">
                        <label class="checkbox_label"><input id="bv_enabled" type="checkbox" class="checkbox"><span>Enable</span></label>
                        <label class="checkbox_label"><input id="bv_inject_file_headers" type="checkbox" class="checkbox"><span>Inject file headers</span></label>
                        <label class="checkbox_label"><input id="bv_parse_dates" type="checkbox" class="checkbox"><span>Parse dates from filenames</span></label>
                        <label class="checkbox_label"><input id="bv_sort_by_date" type="checkbox" class="checkbox"><span>Sort by date</span></label>
                        <label class="checkbox_label"><input id="bv_debug_log" type="checkbox" class="checkbox"><span>Debug log (console)</span></label>
                        <hr style="border:none;border-top:1px solid var(--SmartThemeBorderColor);margin:6px 0;">
                        <label>Header format <small style="color:var(--SmartThemeQuoteColor);">({{date}} {{filename}})</small></label>
                        <input id="bv_header_format" class="text_pole" type="text">
                        <label>Section template <small style="color:var(--SmartThemeQuoteColor);">({{header}} {{chunks}})</small></label>
                        <textarea id="bv_section_template" class="text_pole" rows="2"></textarea>
                        <label>Wrapper template <small style="color:var(--SmartThemeQuoteColor);">({{sections}})</small></label>
                        <textarea id="bv_wrapper_template" class="text_pole" rows="3"></textarea>
                    </div>
                </div>
            </div>
        </div>`;

        $('#extensions_settings').append(html);

        const checks = {
            '#bv_enabled': 'enabled',
            '#bv_inject_file_headers': 'inject_file_headers',
            '#bv_parse_dates': 'parse_dates',
            '#bv_sort_by_date': 'sort_by_date',
            '#bv_debug_log': 'debug_log',
        };
        for (const [sel, key] of Object.entries(checks)) {
            $(sel).prop('checked', s[key]).on('change', function () {
                getSettings()[key] = !!$(this).prop('checked');
                saveSettings();
                if (key === 'enabled') updateStatus();
            });
        }

        const texts = { '#bv_header_format': 'header_format', '#bv_section_template': 'section_template', '#bv_wrapper_template': 'wrapper_template' };
        for (const [sel, key] of Object.entries(texts)) {
            $(sel).val(s[key]).on('input', function () {
                getSettings()[key] = String($(this).val());
                saveSettings();
            });
        }

        updateStatus();
    }

    function updateStatus() {
        const $el = $('#bv_status');
        if (getSettings().enabled) {
            $el.text('ON').css('color', '#4CAF50');
        } else {
            $el.text('OFF').css('color', '#ef5350');
        }
    }

    // ─── Init ───────────────────────────────────────────────────────────────
    function init() {
        console.log(LOG, 'v1.4.1 init');
        installFetchIntercept();
        loadUI();

        if (tryHook()) return;
        let n = 0;
        const poll = setInterval(() => {
            if (tryHook() || ++n >= 60) {
                clearInterval(poll);
                if (n >= 60) console.warn(LOG, 'Vector Storage not found');
            }
        }, 250);
    }

    $(document).ready(() => setTimeout(init, 100));
})();
