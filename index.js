/**
 * Better Vectors v1.3.0 — File metadata injection for SillyTavern
 *
 * Zero fetch interception. Zero API calls. Zero risk.
 *
 * What it does:
 * 1. Hooks vectors_rearrangeChat (the original runs fully untouched)
 * 2. After original finishes, reads Data Bank file list
 * 3. Injects a SEPARATE metadata block with filenames + parsed dates
 *    so the AI knows what sources the chunks come from
 *
 * The original Vector Storage prompt is NEVER touched or overwritten.
 * This extension only ADDS a second prompt block.
 *
 * @author your insomnia & claude code
 */
(function () {
    'use strict';

    const MODULE_NAME = 'better-vectors';
    const LOG = '[BetterVectors]';

    // Our own unique prompt tag — does NOT conflict with Vector Storage tags
    const BV_PROMPT_TAG = '3_better_vectors_meta';

    const defaultSettings = {
        enabled: true,
        parse_dates: true,
        sort_by_date: true,
        meta_template: '[Data Bank file context — use this to understand the source and timeline of injected memories]\n{{file_list}}',
        file_line_format: '- {{date}}{{filename}} ({{size}})',
        inject_depth: 3,
        debug_log: false,
    };

    // ─── Safe ST context access ─────────────────────────────────────────────
    function ctx() {
        try {
            return SillyTavern.getContext();
        } catch (e) {
            return null;
        }
    }

    function getSettings() {
        try {
            const c = ctx();
            if (!c) return Object.assign({}, defaultSettings);
            if (!c.extensionSettings[MODULE_NAME]) {
                c.extensionSettings[MODULE_NAME] = Object.assign({}, defaultSettings);
            }
            return c.extensionSettings[MODULE_NAME];
        } catch (e) {
            return Object.assign({}, defaultSettings);
        }
    }

    function saveSettings() {
        try { ctx()?.saveSettingsDebounced(); } catch (e) { /* */ }
    }

    // ─── Date Parsing ───────────────────────────────────────────────────────
    function parseDateFromFilename(filename, createdTimestamp) {
        const base = filename.replace(/\.[^.]+$/, '');

        const iso = base.match(/(\d{4})[-._](\d{1,2})[-._](\d{1,2})/);
        if (iso) {
            const [full, y, m, d] = iso;
            return {
                dateStr: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
                cleanName: base.replace(full, '').replace(/^[-_.\s]+|[-_.\s]+$/g, '').trim() || base,
            };
        }

        const eu = base.match(/(\d{1,2})[-._](\d{1,2})[-._](\d{4})/);
        if (eu) {
            const [full, d, m, y] = eu;
            return {
                dateStr: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
                cleanName: base.replace(full, '').replace(/^[-_.\s]+|[-_.\s]+$/g, '').trim() || base,
            };
        }

        if (createdTimestamp) {
            const dt = new Date(createdTimestamp);
            if (!isNaN(dt.getTime())) {
                return { dateStr: dt.toISOString().split('T')[0], cleanName: base };
            }
        }

        return { dateStr: null, cleanName: base };
    }

    // ─── Get Data Bank files safely ─────────────────────────────────────────
    function getDataBankFiles() {
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
            } catch (e) { /* */ }

            return [...globalAtt, ...chatAtt, ...charAtt].filter(x => !x.disabled);
        } catch (e) {
            return [];
        }
    }

    // ─── Format human-readable file size ────────────────────────────────────
    function formatSize(bytes) {
        if (!bytes) return '?';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // ─── Build the metadata prompt ──────────────────────────────────────────
    function buildMetadataPrompt() {
        const s = getSettings();
        const files = getDataBankFiles();

        if (files.length === 0) return null;

        // Parse metadata for each file
        let fileMetas = files.map(f => {
            const { dateStr, cleanName } = parseDateFromFilename(f.name, f.created);
            return { name: f.name, dateStr, cleanName, size: f.size };
        });

        // Sort by date if enabled
        if (s.sort_by_date) {
            fileMetas.sort((a, b) => {
                if (a.dateStr && b.dateStr) return a.dateStr.localeCompare(b.dateStr);
                if (a.dateStr) return -1;
                if (b.dateStr) return 1;
                return a.name.localeCompare(b.name);
            });
        }

        // Format each file line
        const lines = fileMetas.map(m => {
            let line = s.file_line_format;
            const datePart = (s.parse_dates && m.dateStr) ? `[${m.dateStr}] ` : '';
            line = line.replace('{{date}}', datePart);
            line = line.replace('{{filename}}', m.cleanName || m.name);
            line = line.replace('{{size}}', formatSize(m.size));
            return line;
        });

        // Build final text
        const fileList = lines.join('\n');
        return s.meta_template.replace('{{file_list}}', fileList);
    }

    // ─── Hook rearrangeChat ─────────────────────────────────────────────────
    let originalRearrangeChat = null;

    async function betterRearrangeChat(chat, contextSize, abort, type) {
        // === ALWAYS call original first, re-throw errors ===
        if (typeof originalRearrangeChat === 'function') {
            await originalRearrangeChat(chat, contextSize, abort, type);
        }

        // === Our enhancement — fully wrapped, can never break original ===
        try {
            const s = getSettings();
            if (!s.enabled || type === 'quiet') return;

            const c = ctx();
            if (!c || typeof c.setExtensionPrompt !== 'function') return;

            // Clear our prompt tag first
            c.setExtensionPrompt(BV_PROMPT_TAG, '', 0, s.inject_depth);

            // Only inject if file vectorization is enabled in the original
            const vs = c.extensionSettings?.vectors || {};
            if (!vs.enabled_files) return;

            const metaPrompt = buildMetadataPrompt();
            if (!metaPrompt) return;

            // Inject as a separate prompt block (never overwrites original)
            c.setExtensionPrompt(
                BV_PROMPT_TAG,
                metaPrompt,
                vs.file_position_db ?? 0,     // same position as original DB prompt
                s.inject_depth,                // at configured depth
                vs.include_wi ?? false,
            );

            if (s.debug_log) {
                console.log(LOG, 'Metadata prompt injected:\n', metaPrompt);
            }
        } catch (e) {
            if (getSettings().debug_log) {
                console.warn(LOG, 'Enhancement failed (non-fatal):', e);
            }
        }
    }

    function hookRearrangeChat() {
        if (typeof globalThis.vectors_rearrangeChat !== 'function') return false;
        if (originalRearrangeChat) return true; // Already hooked

        originalRearrangeChat = globalThis.vectors_rearrangeChat;
        globalThis.vectors_rearrangeChat = betterRearrangeChat;
        console.log(LOG, 'Hooked into Vector Storage');
        return true;
    }

    // ─── Settings UI ────────────────────────────────────────────────────────
    async function loadSettingsUI() {
        const s = getSettings();

        // Always use inline HTML — no file loading that could fail
        const html = `
        <div class="better-vectors-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Better Vectors</b>
                    <span id="bv_status" class="bv-status-badge">...</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="flex-container flexFlowColumn">
                        <small style="color:var(--SmartThemeQuoteColor);margin-bottom:6px;">
                            Adds a metadata block with filenames &amp; parsed dates alongside the Vector Storage injection. Does not replace or modify the original — only adds context.
                        </small>
                        <hr style="border:none;border-top:1px solid var(--SmartThemeBorderColor);margin:6px 0;">
                        <label class="checkbox_label" for="bv_enabled">
                            <input id="bv_enabled" type="checkbox" class="checkbox">
                            <span>Enable</span>
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
                            <span>Debug log (F12 console)</span>
                        </label>
                        <hr style="border:none;border-top:1px solid var(--SmartThemeBorderColor);margin:6px 0;">
                        <label for="bv_inject_depth">Injection depth</label>
                        <input id="bv_inject_depth" class="text_pole" type="number" min="0" max="999" step="1">
                        <label for="bv_meta_template">
                            Metadata template
                            <small style="color:var(--SmartThemeQuoteColor);display:block;">Variable: <code>{{file_list}}</code></small>
                        </label>
                        <textarea id="bv_meta_template" class="text_pole" rows="3"></textarea>
                        <label for="bv_file_line_format">
                            File line format
                            <small style="color:var(--SmartThemeQuoteColor);display:block;">Variables: <code>{{date}}</code> <code>{{filename}}</code> <code>{{size}}</code></small>
                        </label>
                        <input id="bv_file_line_format" class="text_pole" type="text">
                    </div>
                </div>
            </div>
        </div>`;

        $('#extensions_settings').append(html);

        // Bind checkboxes
        const checks = {
            '#bv_enabled': 'enabled',
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

        // Bind text inputs
        $('#bv_inject_depth').val(s.inject_depth).on('input', function () {
            getSettings().inject_depth = Number($(this).val()) || 3;
            saveSettings();
        });
        $('#bv_meta_template').val(s.meta_template).on('input', function () {
            getSettings().meta_template = String($(this).val());
            saveSettings();
        });
        $('#bv_file_line_format').val(s.file_line_format).on('input', function () {
            getSettings().file_line_format = String($(this).val());
            saveSettings();
        });

        updateStatus();
    }

    function updateStatus() {
        const $el = $('#bv_status');
        if (getSettings().enabled) {
            $el.text('ON').css({ color: '#4CAF50', fontSize: '0.75em', marginLeft: '6px' });
        } else {
            $el.text('OFF').css({ color: '#ef5350', fontSize: '0.75em', marginLeft: '6px' });
        }
    }

    // ─── Init ───────────────────────────────────────────────────────────────
    function init() {
        console.log(LOG, 'Initializing...');

        loadSettingsUI().catch(e => console.warn(LOG, 'UI error:', e));

        if (hookRearrangeChat()) {
            console.log(LOG, 'Ready');
            return;
        }

        // Poll for Vector Storage
        let n = 0;
        const poll = setInterval(() => {
            if (hookRearrangeChat() || ++n >= 60) {
                clearInterval(poll);
                if (n >= 60) console.warn(LOG, 'Vector Storage not found');
                else console.log(LOG, 'Ready');
            }
        }, 250);
    }

    $(document).ready(() => setTimeout(init, 100));
})();
