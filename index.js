/**
 * Better Vectors — Enhanced Vector Storage for SillyTavern
 *
 * Minimal hook: intercepts the fetch response from /api/vector/query-multi
 * that the ORIGINAL Vector Storage already makes, captures per-file chunk data,
 * then reformats the Data Bank prompt with file headers and grouping.
 *
 * Does NOT reimplement any vectorization, querying, or API logic.
 *
 * @author your insomnia & claude code
 * @version 1.1.0
 */
import {
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParamsExtended,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { getDataBankAttachments } from '../../../chats.js';
import { getStringHash as calculateHash, onlyUnique } from '../../../utils.js';

// ─── Constants ──────────────────────────────────────────────────────────────────
const MODULE_NAME = 'better-vectors';
const EXTENSION_PROMPT_TAG_DB = '4_vectors_data_bank';
const LOG = '[BetterVectors]';

// ─── Default Settings ───────────────────────────────────────────────────────────
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

// ─── Captured data from the original's fetch call ───────────────────────────────
let capturedQueryMultiResult = null;

// ─── Hash helper (mirrors original) ─────────────────────────────────────────────
const hashCache = new Map();
function getStringHash(str) {
    if (hashCache.has(str)) return hashCache.get(str);
    const h = calculateHash(str);
    hashCache.set(str, h);
    return h;
}

function getFileCollectionId(fileUrl) {
    return `file_${getStringHash(fileUrl)}`;
}

// ─── Date Parsing ───────────────────────────────────────────────────────────────
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

// ─── Fetch Interceptor ─────────────────────────────────────────────────────────
const originalFetch = window.fetch.bind(window);

async function interceptedFetch(input, init) {
    const response = await originalFetch(input, init);
    const s = getSettings();

    // Only intercept if we're enabled
    if (!s.enabled) return response;

    // Check if this is the query-multi call
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/vector/query-multi')) return response;

    try {
        // Clone response so original consumer still gets data
        const cloned = response.clone();
        const data = await cloned.json();
        capturedQueryMultiResult = data;

        if (s.debug_log) {
            console.debug(`${LOG} Captured query-multi response:`, Object.keys(data));
        }
    } catch (e) {
        console.warn(`${LOG} Failed to capture query-multi response`, e);
    }

    return response;
}

// ─── File metadata map ──────────────────────────────────────────────────────────
function buildFileMetadataMap() {
    const dataBank = getDataBankAttachments(false);
    const map = new Map();
    for (const file of dataBank) {
        const cid = getFileCollectionId(file.url);
        const { dateStr, cleanName } = parseDateFromFilename(file.name, file.created);
        map.set(cid, { name: file.name, dateStr, cleanName });
    }
    return map;
}

// ─── Format header ──────────────────────────────────────────────────────────────
function formatFileHeader(meta) {
    const s = getSettings();
    if (!s.inject_file_headers) return '';

    let header = s.header_format;
    const datePart = (s.parse_dates && meta.dateStr) ? `${meta.dateStr} | ` : '';
    header = header.replace('{{date}}', datePart);
    header = header.replace('{{filename}}', meta.cleanName || meta.name);
    return header;
}

// ─── Build the enhanced prompt from captured data ───────────────────────────────
function buildEnhancedPrompt() {
    const s = getSettings();

    if (!capturedQueryMultiResult) {
        if (s.debug_log) console.debug(`${LOG} No captured data to enhance`);
        return null;
    }

    const fileMetaMap = buildFileMetadataMap();
    const fileSections = [];

    for (const [collectionId, result] of Object.entries(capturedQueryMultiResult)) {
        if (!result?.metadata) continue;

        const chunks = result.metadata
            .filter(x => x.text)
            .sort((a, b) => a.index - b.index)
            .map(x => x.text)
            .filter(onlyUnique);

        if (chunks.length === 0) continue;

        const meta = fileMetaMap.get(collectionId);

        // If we don't have metadata for this collection, it's a per-message file
        // attachment (not Data Bank) — skip, let original handle it
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

// ─── Monkey-patch rearrangeChat ─────────────────────────────────────────────────
let originalRearrangeChat = null;

async function betterRearrangeChat(chat, contextSize, abort, type) {
    const s = getSettings();

    // Reset captured data before original runs
    capturedQueryMultiResult = null;

    // Let the original do ALL the work — vectorization, querying, injection
    if (typeof originalRearrangeChat === 'function') {
        await originalRearrangeChat(chat, contextSize, abort, type);
    }

    // If disabled or quiet, stop here — original result stands
    if (!s.enabled || type === 'quiet') return;

    try {
        // Build enhanced prompt from the data we captured during original's fetch
        const enhanced = buildEnhancedPrompt();

        if (enhanced) {
            // Read injection position from the original's settings
            const vs = extension_settings.vectors || {};
            setExtensionPrompt(
                EXTENSION_PROMPT_TAG_DB,
                enhanced,
                vs.file_position_db,
                vs.file_depth_db,
                vs.include_wi,
                vs.file_depth_role_db,
            );

            if (s.debug_log) {
                console.log(`${LOG} Overwrote Data Bank prompt with enhanced formatting`);
            }
        }
    } catch (error) {
        // If anything fails, original injection is still in place
        console.error(`${LOG} Enhancement failed, original prompt preserved`, error);
    }
}

// ─── Settings ───────────────────────────────────────────────────────────────────
function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = Object.assign({}, defaultSettings);
    }
    return extension_settings[MODULE_NAME];
}

function saveSettings() {
    Object.assign(extension_settings[MODULE_NAME], getSettings());
    saveSettingsDebounced();
}

async function loadSettingsUI() {
    const s = getSettings();
    const html = await renderExtensionTemplateAsync(`third-party/${MODULE_NAME}`, 'settings');
    $('#extensions_settings').append(html);

    // -- Checkboxes --
    const checkboxes = {
        '#bv_enabled': 'enabled',
        '#bv_inject_file_headers': 'inject_file_headers',
        '#bv_parse_dates': 'parse_dates',
        '#bv_sort_by_date': 'sort_by_date',
        '#bv_debug_log': 'debug_log',
    };

    for (const [sel, key] of Object.entries(checkboxes)) {
        $(sel).prop('checked', s[key]).on('change', function () {
            s[key] = !!$(this).prop('checked');
            saveSettings();
            if (key === 'enabled') updateStatusIndicator();
        });
    }

    // -- Text inputs --
    const textInputs = {
        '#bv_header_format': 'header_format',
        '#bv_section_template': 'section_template',
        '#bv_wrapper_template': 'wrapper_template',
    };

    for (const [sel, key] of Object.entries(textInputs)) {
        $(sel).val(s[key]).on('input', function () {
            s[key] = String($(this).val());
            saveSettings();
            updatePreview();
        });
    }

    updateStatusIndicator();
    updatePreview();
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

function updatePreview() {
    const s = getSettings();
    const sampleMeta = { name: '2024-06-15_tavern_battle.txt', dateStr: '2024-06-15', cleanName: 'tavern_battle' };
    const header = formatFileHeader(sampleMeta);

    let section = s.section_template;
    section = section.replace('{{header}}', header);
    section = section.replace('{{chunks}}', 'The heroes fought bravely in the tavern...');

    let wrapper = s.wrapper_template;
    wrapper = wrapper.replace('{{sections}}', section.trim());
    $('#bv_preview_output').text(wrapper);
}

// ─── Init ───────────────────────────────────────────────────────────────────────
jQuery(async () => {
    await loadSettingsUI();

    // Install fetch interceptor
    window.fetch = interceptedFetch;
    console.log(`${LOG} Fetch interceptor installed`);

    // Wait for the original Vector Storage to register its rearrangeChat
    const deadline = Date.now() + 15000;
    while (!globalThis.vectors_rearrangeChat && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
    }

    if (typeof globalThis.vectors_rearrangeChat === 'function') {
        originalRearrangeChat = globalThis.vectors_rearrangeChat;
        globalThis.vectors_rearrangeChat = betterRearrangeChat;
        console.log(`${LOG} Hooked into Vector Storage (rearrangeChat)`);
    } else {
        console.warn(`${LOG} Vector Storage not found — extension inactive`);
        toastr.warning(
            'Better Vectors requires the built-in Vector Storage extension. Enable it first.',
            'Better Vectors',
            { timeOut: 8000 },
        );
    }
});
