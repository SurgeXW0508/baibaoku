import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

const BEGIN_MARKER = '// baibaoku world info tokenizer bridge:start';
const END_MARKER = '// baibaoku world info tokenizer bridge:end';
const BRIDGE_BLOCK_PATTERN = new RegExp(
    String.raw`[ \t]*${escapeRegExp(BEGIN_MARKER)}[\s\S]*?${escapeRegExp(END_MARKER)}[ \t]*(?:\r?\n)?`,
    'g',
);

export function installWorldInfoTokenizerBridge() {
    const worldInfoPath = getWorldInfoPath();

    try {
        const originalSource = fs.readFileSync(worldInfoPath, 'utf8');
        const patchedSource = patchWorldInfoJs(originalSource);

        if (patchedSource === originalSource) {
            if (hasWorldInfoTokenizerBridge(originalSource)) {
                console.log('[baibaoku] World Info tokenizer bridge is already installed in public/scripts/world-info.js.');
            } else {
                console.warn('[baibaoku] World Info tokenizer bridge was not installed: public/scripts/world-info.js did not match known anchors.');
            }
            return { changed: false, path: worldInfoPath };
        }

        writeFileAtomicSync(worldInfoPath, patchedSource, 'utf8');
        console.log('[baibaoku] Installed World Info tokenizer bridge into public/scripts/world-info.js.');

        return { changed: true, path: worldInfoPath };
    } catch (error) {
        console.warn('[baibaoku] Failed to install World Info tokenizer bridge into public/scripts/world-info.js:', error.message);
        return { changed: false, path: worldInfoPath, error };
    }
}

export function unpatchWorldInfoJs(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const originalAnchor = [
        '        let newContent = \'\';',
        '        const textToScanTokens = await getTokenCountAsync(allActivatedText);',
        '',
        '        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);',
    ].join(newline);
    const legacyReorderedAnchor = [
        '        let newContent = \'\';',
        '',
        '        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);',
        '',
        '        const textToScanTokens = await getTokenCountAsync(allActivatedText);',
    ].join(newline);

    return source
        .replace(BRIDGE_BLOCK_PATTERN, '')
        .replace(legacyReorderedAnchor, originalAnchor)
        .replace(
            '            entry.content = baibaokuWorldInfoBudgetContent.get(entry) ?? substituteParams(entry.content);',
            '            entry.content = substituteParams(entry.content);',
        );
}

export function patchWorldInfoJs(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const cleanedSource = unpatchWorldInfoJs(source);
    const anchor = [
        '        let newContent = \'\';',
        '        const textToScanTokens = await getTokenCountAsync(allActivatedText);',
        '',
        '        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);',
    ].join(newline);

    if (!cleanedSource.includes('export async function getWorldInfoPrompt')
        || !cleanedSource.includes('async function checkWorldInfo')
        || !cleanedSource.includes(anchor)) {
        return hasWorldInfoTokenizerBridge(source) ? source : cleanedSource;
    }

    const bridgeBlock = [
        `        ${BEGIN_MARKER}`,
        '        const baibaokuWorldInfoTokenizerBridge = globalThis.__baibaokuTokenizerBulkBridge;',
        '        if (typeof baibaokuWorldInfoTokenizerBridge?.prepareWorldInfoBudgetCounts === \'function\'',
        '            && baibaokuWorldInfoTokenizerBridge?.isEnabled?.() !== false) {',
        '            await Promise.resolve(baibaokuWorldInfoTokenizerBridge.prepareWorldInfoBudgetCounts({',
        '                version: 1,',
        '                textToScan: \'\',',
        '                entries: newEntries.map(entry => {',
        '                    const content = typeof entry?.content === \'string\' ? entry.content : \'\';',
        '                    return {',
        '                        content,',
        '                        hasMacros: content.includes(\'{{\') || /<(?:USER|CHAR|BOT)>/i.test(content),',
        '                        ignoreBudget: Boolean(entry?.ignoreBudget),',
        '                        maySkip: Boolean(entry?.useProbability && entry?.probability !== 100 && !timedEffects.isEffectActive(\'sticky\', entry)),',
        '                    };',
        '                }),',
        "            })).catch(error => console.debug('[baibaoku] World Info tokenizer bridge prepare failed', error));",
        '        }',
        `        ${END_MARKER}`,
    ].join(newline);

    return cleanedSource.replace(anchor, `${anchor}${newline}${bridgeBlock}`);
}

function getWorldInfoPath() {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const sillyTavernRoot = path.resolve(pluginDir, '..', '..', '..');

    return path.join(sillyTavernRoot, 'public', 'scripts', 'world-info.js');
}

function hasWorldInfoTokenizerBridge(source) {
    return source.includes(BEGIN_MARKER) && source.includes(END_MARKER);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
