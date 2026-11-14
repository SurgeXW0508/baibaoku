import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bytes from 'bytes';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { parse } from '../../../src/character-card-parser.js';
import { PUBLIC_DIRECTORIES, SETTINGS_FILE } from '../../../src/constants.js';
import { generateTimestamp, getVersion, removeOldBackups } from '../../../src/util.js';
import { PLUGIN_ID } from './constants.js';
import {
    getTiktokenTokenizer,
    getTokenizerModel,
    countWebTokenizerTokens,
    getSentencepiceTokenizer,
    getWebTokenizer,
} from '../../../src/endpoints/tokenizers.js';
import {
    closeSaveGenerateJobs,
    registerSaveGenerateEndpoints,
} from './save-generate.js';
import { getThemeBridgeStatus } from './theme-bridge-installer.js';
import { setSafeHeader } from './header-utils.js';

const FAST_CHARACTER_CACHE_DATABASE = 'baibaoku.internal';
const FAST_CHARACTER_CACHE_STORE = 'character-fast-all';
const FAST_CHARACTER_CACHE_VERSION = 1;
export const FAST_CHARACTER_CACHE_SCHEMA = 3;
const FAST_CHARACTER_CACHE_PAGE_SIZE = 1000;
const SETTINGS_FAST_CONFIG_DATABASE = 'baibaoku.internal';
const SETTINGS_FAST_CONFIG_STORE = 'fast-config';
const SETTINGS_FAST_CONFIG_KEY = 'global';
const DEFAULT_SETTINGS_ACCELERATION_ENABLED = true;
const DEFAULT_LAZY_THEME_LOADING_ENABLED = true;
const DEFAULT_CHARACTER_LIST_ACCELERATION_ENABLED = true;
const DEFAULT_RECENT_CHAT_LIST_ACCELERATION_ENABLED = true;
const DEFAULT_PROGRESSIVE_CHAT_LOADING_ENABLED = false;
const DEFAULT_TOKENIZER_BULK_COUNT_ENABLED = true;
const DEFAULT_EXTENSION_MANIFEST_BUNDLE_ENABLED = true;
const DEFAULT_VERSION_ACCELERATION_ENABLED = true;
const DEFAULT_CHAT_KEYBOARD_SCAN_REDUCTION_ENABLED = false;
const SETTINGS_AUTOSAVE_INTERVAL = 10 * 60 * 1000;
const FAST_RECENT_CHAT_READ_BUFFER_SIZE = 1024 * 1024;
const FAST_SEARCH_FILE_CONCURRENCY = 4;
const FAST_SEARCH_PREVIEW_LENGTH = 400;
const FAST_SEARCH_FORBIDDEN_REGEXP = path.sep === '/' ? /[/\x00]/ : /[/\x00\\]/;
// Reuse the same internal database/version as fast-all (independent store).
const FAST_SEARCH_CACHE_DATABASE = FAST_CHARACTER_CACHE_DATABASE;
const FAST_SEARCH_CACHE_VERSION = FAST_CHARACTER_CACHE_VERSION;
const FAST_SEARCH_CACHE_STORE = 'chats-fast-search';
const FAST_SEARCH_CACHE_PAGE_SIZE = FAST_CHARACTER_CACHE_PAGE_SIZE;
// Bump when the cached result object shape changes, to invalidate stale entries.
const FAST_SEARCH_CACHE_SCHEMA = 3;
const CHAT_BACKUP_CACHE_DATABASE = FAST_CHARACTER_CACHE_DATABASE;
const CHAT_BACKUP_CACHE_VERSION = FAST_CHARACTER_CACHE_VERSION;
const CHAT_BACKUP_CACHE_STORE = 'chat-backups-fast-list';
const CHAT_BACKUP_CACHE_PAGE_SIZE = FAST_CHARACTER_CACHE_PAGE_SIZE;
const CHAT_BACKUP_CACHE_SCHEMA = 3;
const CHAT_BACKUP_FILE_CONCURRENCY = 16;
const CHAT_BACKUP_FILE_PREFIX = 'chat_';
const CHAT_BACKUP_FILE_EXTENSION = '.jsonl';
const SETTINGS_TEXT_PERSIST_VERSION = 1;
const SETTINGS_TEXT_PERSIST_FILE = 'settings-text-v1.json';
const SETTINGS_PAYLOAD_PERSIST_VERSION = 2;
const SETTINGS_PAYLOAD_PERSIST_FILE = 'settings-payload-v1.json';
const SETTINGS_RESPONSE_PERSIST_VERSION = 1;
const SETTINGS_RESPONSE_META_FILE = 'settings-response-v1.json';
const SETTINGS_RESPONSE_BODY_FILE = 'settings-response-v1.body';
const SETTINGS_THEME_MODE_FULL = 'full';
const SETTINGS_THEME_MODE_LAZY = 'lazy';
const SETTINGS_LAZY_THEME_MARKER = '__baibaokuLazyTheme';
const SETTINGS_THEME_INDEX_CACHE_VERSION = 1;
// Orphaned atomic-write temp files (`*.tmp`) can leak in the cache directory when
// a rename is interrupted (process kill, AV/sync locking the file on Windows).
// They are never read back, so any temp file older than this is safe to delete.
const CACHE_TMP_ORPHAN_MAX_AGE_MS = 60 * 1000;
// Throttle the opportunistic sweep so frequent writes don't each scan the dir.
const CACHE_TMP_SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;
// Map<cacheDirectory, lastSweepAtMs> to throttle sweeps per directory.
const cacheTmpSweepTimestamps = new Map();

// Cache structure: Map<userHandle, Map<filename, { mtime: number, size: number, data: Object }>>
const userCaches = new Map();
// Fast-search per-file result cache, persisted per user (like fast-all).
// Cache structure: Map<userHandle, Map<filePath, { mtime, size, result }>>
const fastSearchUserCaches = new Map();
// Lock structure: Map<userHandle, Promise<Map>> to dedupe concurrent loads.
const fastSearchLoadLocks = new Map();
// Cache structure: Map<userHandle, Map<filename, { mtime, size, chatItems }>>
const chatBackupUserCaches = new Map();
// Lock structure: Map<userHandle, Promise<Map>>
const chatBackupLoadLocks = new Map();
// Lock structure: Map<userHandle, Promise<{ data, metrics }>>
const chatBackupUpdateLocks = new Map();
// Lock structure: Map<userHandle, Promise<void>>
const updateLocks = new Map();
// Cache structure: Map<userHandle, { sections: Map<string, Map<filename, CachedFile>> }>
const settingsUserCaches = new Map();
// Lock structure: Map<userHandle, Promise<Object>>
const settingsUpdateLocks = new Map();
// Cache structure: Map<userHandle, { path: string, text: string, mtime: number, size: number, contentHash: string, updatedAt: number }>
const settingsFileCaches = new Map();
// Lock structure: Map<userHandle, Promise<Object>>
const settingsSaveLocks = new Map();
// Monotonic client save sequence guard: Map<userHandle, Map<clientEpoch, number>>
const settingsClientSaveSeqs = new Map();
const MAX_CLIENT_SAVE_EPOCHS_PER_USER = 32;
// Cache structure: Map<userHandle, { key: string, text: string }>
const settingsResponseCaches = new Map();
// Scheduler structure: Map<userHandle, { lastBackupAt: number, timer: Timeout|null, pendingPayload: Object|null }>
const settingsBackupSchedulers = new Map();
// Cache structure: Map<userHandle, string> (content hash of the last backed-up settings)
const lastBackupHashes = new Map();
const tokenizerLoadPromises = new WeakMap();
let staticSettingsPayload = null;
const EARLY_BRIDGE_VERSION = '1.0';
let fastVersionCache = null;
let fastVersionPromise = null;

/**
 * Gets a humanized date time string for default chat names.
 * Mirrors newer SillyTavern's util format without requiring that export.
 */
function humanizedDateTime(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const dt = {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        millisecond: date.getMilliseconds(),
    };

    for (const key in dt) {
        const padLength = key === 'millisecond' ? 3 : 2;
        dt[key] = String(dt[key]).padStart(padLength, '0');
    }

    return `${dt.year}-${dt.month}-${dt.day}@${dt.hour}h${dt.minute}m${dt.second}s${dt.millisecond}ms`;
}

function normalizeTagList(rawTags) {
    if (typeof rawTags === 'string') {
        return rawTags.split(',').map(x => x.trim()).filter(x => x);
    }
    return Array.isArray(rawTags) ? rawTags : [];
}

/**
 * Normalizes tags from V1/V2 char data structure, matching ST's `readFromV2` / `convertToV2` precedence.
 */
function extractTags(data, hasV2Data = false) {
    if (hasV2Data) {
        const rawTags = data?.data?.tags !== undefined ? data.data.tags : data?.tags;
        return normalizeTagList(rawTags);
    }
    return normalizeTagList(data?.tags);
}

function normalizeCharacterFav(rawFav) {
    return rawFav === true || rawFav === 'true';
}

function buildV2DataForSizeCalculation(charData, name, tags, fav) {
    const baseData = (charData?.data && typeof charData.data === 'object' && !Array.isArray(charData.data))
        ? { ...charData.data }
        : {};
    const alternateGreetings = Array.isArray(charData?.alternate_greetings)
        ? charData.alternate_greetings
        : (typeof charData?.alternate_greetings === 'string'
            ? [charData.alternate_greetings]
            : (Array.isArray(baseData.alternate_greetings) ? baseData.alternate_greetings : []));

    const v2Data = {
        ...baseData,
        name,
        description: charData?.description || '',
        personality: charData?.personality || '',
        scenario: charData?.scenario || '',
        first_mes: charData?.first_mes || '',
        mes_example: charData?.mes_example || '',
        creator_notes: charData?.creatorcomment || '',
        system_prompt: '',
        post_history_instructions: '',
        tags,
        creator: charData?.creator || '',
        character_version: '',
        alternate_greetings: alternateGreetings,
        extensions: {
            ...(baseData.extensions && typeof baseData.extensions === 'object' ? baseData.extensions : {}),
            talkativeness: charData?.talkativeness || 0.5,
            fav,
            world: '',
        },
    };

    return v2Data;
}

function calculateCharacterDataSize(data) {
    return (data && typeof data === 'object' && !Array.isArray(data))
        ? Object.values(data).reduce((acc, val) => acc + String(val).length, 0)
        : 0;
}

function createEmptyCharacterChatStats() {
    return {
        chatSize: 0,
        dateLastChat: 0,
        chatDirMtime: 0,
        files: {},
    };
}

/**
 * Calculate chat statistics for a character
 */
async function calculateCharacterChatStats(chatsDir, filename, cachedStats) {
    if (!chatsDir) {
        return createEmptyCharacterChatStats();
    }

    const charDirName = filename.replace('.png', '');
    const charChatDir = path.join(chatsDir, charDirName);

    let chatSize = 0;
    let dateLastChat = 0;
    let chatDirStat = null;

    // Try to get chat directory stats
    try {
        chatDirStat = await fs.promises.stat(charChatDir);
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
            return createEmptyCharacterChatStats();
        }
        throw e;
    }

    if (!chatDirStat.isDirectory()) {
        return createEmptyCharacterChatStats();
    }

    // Fast path: if directory mtime hasn't changed, use cached stats
    if (cachedStats?.chatDirMtime === chatDirStat.mtimeMs && cachedStats.files) {
        return cachedStats;
    }

    // Directory changed, need to check files
    let files = [];
    try {
        files = await fs.promises.readdir(charChatDir);
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
            return createEmptyCharacterChatStats();
        }
        throw e;
    }

    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    const fileStats = {};
    const cachedFiles = cachedStats?.files || {};

    // Check each file
    for (const file of jsonlFiles) {
        const filePath = path.join(charChatDir, file);
        let stat;
        try {
            stat = await fs.promises.stat(filePath);
        } catch (e) {
            if (e.code === 'ENOENT') {
                continue;
            }
            throw e;
        }
        const cached = cachedFiles[file];

        // Use cached data if file hasn't changed
        if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
            fileStats[file] = cached;
            chatSize += cached.size;
            dateLastChat = Math.max(dateLastChat, cached.mtime);
        } else {
            // File is new or changed
            fileStats[file] = {
                size: stat.size,
                mtime: stat.mtimeMs,
            };
            chatSize += stat.size;
            dateLastChat = Math.max(dateLastChat, stat.mtimeMs);
        }
    }

    return {
        chatSize,
        dateLastChat,
        chatDirMtime: chatDirStat.mtimeMs,
        files: fileStats,
    };
}

/**
 * Formats a character with strict parity to ST's `processCharacter` + `toShallow`.
 * Returns `null` when JSON is unparseable, non-object, or resolves an empty/nameless card.
 */
export async function formatShallowCharacter(filename, stat, rawDataStr, chatsDir, cachedChatStats) {
    if (typeof rawDataStr !== 'string' || !rawDataStr) {
        return null;
    }

    let charData;
    try {
        charData = JSON.parse(rawDataStr);
    } catch {
        console.warn(`[baibaoku] Failed to parse JSON for character card: ${filename}`);
        return null;
    }

    if (!charData || typeof charData !== 'object' || Array.isArray(charData)) {
        return null;
    }

    const isV2 = charData.spec !== undefined;
    if (isV2 && charData.data !== undefined && (!charData.data || typeof charData.data !== 'object' || Array.isArray(charData.data))) {
        return null;
    }
    const hasV2Data = isV2 && charData.data !== undefined;

    const candidateName = hasV2Data
        ? (charData.data.name !== undefined ? charData.data.name : charData.name)
        : charData.name;
    const rawName = typeof candidateName === 'string' ? candidateName : '';

    if (!rawName || !rawName.trim()) {
        return null;
    }
    const name = rawName;

    const rawFav = isV2
        ? (hasV2Data
            ? (charData.data?.extensions?.fav !== undefined ? charData.data.extensions.fav : false)
            : (charData.fav !== undefined ? charData.fav : false))
        : (charData.fav !== undefined ? charData.fav : false);
    const fav = normalizeCharacterFav(rawFav);
    const extensionFav = hasV2Data ? fav : (isV2 ? false : fav);

    const tags = extractTags(charData, hasV2Data);
    const v2DataForSize = isV2
        ? (hasV2Data ? charData.data : undefined)
        : buildV2DataForSizeCalculation(charData, name, tags, fav);
    const dataSize = calculateCharacterDataSize(v2DataForSize);

    // Get real chat statistics
    const chatStats = await calculateCharacterChatStats(chatsDir, filename, cachedChatStats);

    const chatField = (isV2 && !hasV2Data)
        ? charData.chat
        : (charData.chat ?? `${name} - ${humanizedDateTime()}`);
    const createDate = charData.create_date || new Date(Math.round(stat.ctimeMs)).toISOString();

    return {
        shallow: true,
        name,
        avatar: filename,
        chat: chatField,
        fav,
        date_added: stat.ctimeMs,
        create_date: createDate,
        date_last_chat: chatStats.dateLastChat,
        chat_size: chatStats.chatSize,
        data_size: dataSize,
        tags,
        data: {
            name: hasV2Data ? (charData.data.name !== undefined ? charData.data.name : '') : (isV2 ? '' : name),
            character_version: hasV2Data ? (charData.data.character_version !== undefined ? charData.data.character_version : '') : '',
            creator: hasV2Data ? (charData.data.creator !== undefined ? charData.data.creator : '') : (isV2 ? '' : (charData.creator || '')),
            creator_notes: hasV2Data ? (charData.data.creator_notes !== undefined ? charData.data.creator_notes : '') : (isV2 ? '' : (charData.creatorcomment || '')),
            tags: hasV2Data ? (charData.data.tags !== undefined ? normalizeTagList(charData.data.tags) : []) : (isV2 ? [] : tags),
            extensions: {
                fav: extensionFav,
                world: hasV2Data ? (charData.data.extensions?.world !== undefined ? charData.data.extensions.world : '') : '',
            },
        },
        // Internal: store chat stats for future incremental updates
        _chatStats: chatStats,
    };
}

async function updateCacheForUser(req, manager, userHandle, charactersDir) {
    // 1. Get or create the cache for this user
    if (!userCaches.has(userHandle)) {
        userCaches.set(userHandle, await loadPersistentCache(req, manager));
    }
    const cache = userCaches.get(userHandle);
    const chatsDir = req.user?.directories?.chats;

    let charactersDirStat = null;
    try {
        charactersDirStat = await fs.promises.stat(charactersDir);
    } catch (e) {
        if (e.code === 'ENOENT') return cache;
        throw e;
    }

    const charactersChanged = cache.charactersDirMtime !== charactersDirStat.mtimeMs;
    const updatedItems = [];
    const deletedFilenames = [];
    const reparsedFilenames = new Set();

    const evictCachedCharacter = (filename) => {
        if (cache.has(filename)) {
            cache.delete(filename);
            deletedFilenames.push(filename);
        }
    };

    // 2. Handle characters directory changes
    if (charactersChanged) {
        let files = [];
        try {
            files = await fs.promises.readdir(charactersDir);
        } catch (e) {
            if (e.code === 'ENOENT') return cache;
            throw e;
        }
        const pngFiles = files.filter(f => f.endsWith('.png'));

        // Batch stat all png files to get mtime
        const statPromises = pngFiles.map(async (filename) => {
            try {
                const stat = await fs.promises.stat(path.join(charactersDir, filename));
                return { filename, stat };
            } catch (e) {
                return { filename, error: e };
            }
        });
        const statResults = await Promise.all(statPromises);

        // Garbage Collection: Remove deleted files from cache
        const currentFileSet = new Set(pngFiles);
        for (const cachedFilename of cache.keys()) {
            if (!currentFileSet.has(cachedFilename)) {
                evictCachedCharacter(cachedFilename);
            }
        }

        // Parse changed/new files
        const parsePromises = [];
        for (const result of statResults) {
            if (result.error) {
                if (result.error.code === 'ENOENT') {
                    evictCachedCharacter(result.filename);
                }
                continue;
            }

            const { filename, stat } = result;
            const cachedItem = cache.get(filename);

            // If not in cache, or file metadata differs
            if (!cachedItem || stat.mtimeMs !== cachedItem.mtime || stat.size !== cachedItem.size) {
                reparsedFilenames.add(filename);
                const filePath = path.join(charactersDir, filename);
                const parseTask = async () => {
                    try {
                        const rawDataStr = await parse(filePath, 'png');
                        const shallowData = rawDataStr
                            ? await formatShallowCharacter(filename, stat, rawDataStr, chatsDir, cachedItem?.data?._chatStats)
                            : null;
                        if (shallowData) {
                            const item = {
                                mtime: stat.mtimeMs,
                                size: stat.size,
                                data: shallowData,
                            };
                            cache.set(filename, item);
                            updatedItems.push({ filename, item });
                        } else {
                            evictCachedCharacter(filename);
                        }
                    } catch (e) {
                        console.warn(`[baibaoku] Failed to parse character ${filename}:`, e.message);
                        evictCachedCharacter(filename);
                    }
                };
                parsePromises.push(parseTask());
            }
        }

        await Promise.all(parsePromises);
    }

    // 3. Always check per-character chats/<charName> directory mtime across cached characters.
    // On POSIX/Linux, atomic writes inside chats/<charName>/<file>.jsonl update chats/<charName>/ mtimeMs,
    // never top-level chats/ mtimeMs. Treat ENOENT as mtime 0 so deleted chat folders reset stats to 0.
    if (chatsDir && cache.size > 0) {
        const chatUpdatePromises = [];
        for (const [avatarFilename, cachedItem] of cache.entries()) {
            if (reparsedFilenames.has(avatarFilename) || !cachedItem?.data) {
                continue;
            }

            const charName = avatarFilename.replace('.png', '');
            const chatSubDir = path.join(chatsDir, charName);
            const updateTask = async () => {
                let currentChatDirMtime = 0;
                try {
                    const chatDirStat = await fs.promises.stat(chatSubDir);
                    if (chatDirStat.isDirectory()) {
                        currentChatDirMtime = chatDirStat.mtimeMs;
                    }
                } catch (e) {
                    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
                        console.warn(`[baibaoku] Failed to stat chat directory for ${avatarFilename}:`, e.message);
                        return;
                    }
                    currentChatDirMtime = 0;
                }

                const cachedChatStats = cachedItem.data._chatStats;
                const previousChatDirMtime = cachedChatStats?.chatDirMtime ?? -1;
                const needsResetForMissingDir = currentChatDirMtime === 0
                    && (cachedItem.data.date_last_chat !== 0 || cachedItem.data.chat_size !== 0);

                if (previousChatDirMtime !== currentChatDirMtime || needsResetForMissingDir) {
                    const newChatStats = currentChatDirMtime === 0
                        ? createEmptyCharacterChatStats()
                        : await calculateCharacterChatStats(chatsDir, avatarFilename, cachedChatStats);
                    cachedItem.data.date_last_chat = newChatStats.dateLastChat;
                    cachedItem.data.chat_size = newChatStats.chatSize;
                    cachedItem.data._chatStats = newChatStats;
                    updatedItems.push({ filename: avatarFilename, item: cachedItem });
                }
            };
            chatUpdatePromises.push(updateTask());
        }

        await Promise.all(chatUpdatePromises);
    }

    // 4. Persist changes if anything changed
    if (updatedItems.length || deletedFilenames.length) {
        await persistCacheChanges(req, manager, updatedItems, deletedFilenames);
    }

    // 5. Update characters directory mtime in cache
    cache.charactersDirMtime = charactersDirStat.mtimeMs;

    return cache;
}

async function loadPersistentCache(req, manager) {
    const cache = new Map();
    if (!manager) {
        return cache;
    }

    try {
        await manager.openForRequest(req, FAST_CHARACTER_CACHE_DATABASE, {
            displayName: '柏宝库内部缓存',
            version: FAST_CHARACTER_CACHE_VERSION,
        });

        const staleFilenames = [];
        let offset = 0;
        while (true) {
            const result = await manager.entries(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, {
                prefix: '',
                limit: FAST_CHARACTER_CACHE_PAGE_SIZE,
                offset,
            });

            const entries = result.entries || [];
            for (const entry of entries) {
                const item = normalizePersistentCacheItem(entry.value);
                if (item) {
                    cache.set(entry.key, item);
                } else {
                    staleFilenames.push(entry.key);
                }
            }

            if (entries.length < FAST_CHARACTER_CACHE_PAGE_SIZE) {
                break;
            }
            offset += FAST_CHARACTER_CACHE_PAGE_SIZE;
        }

        for (let index = 0; index < staleFilenames.length; index += FAST_CHARACTER_CACHE_PAGE_SIZE) {
            const batch = staleFilenames.slice(index, index + FAST_CHARACTER_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to load persistent character cache:', error.message);
    }

    return cache;
}

async function persistCacheChanges(req, manager, updatedItems, deletedFilenames) {
    if (!manager) {
        return;
    }

    try {
        for (let index = 0; index < updatedItems.length; index += FAST_CHARACTER_CACHE_PAGE_SIZE) {
            const batch = updatedItems.slice(index, index + FAST_CHARACTER_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.setMany(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, batch.map(({ filename, item }) => ({
                    key: filename,
                    value: {
                        schema: FAST_CHARACTER_CACHE_SCHEMA,
                        ...item,
                    },
                })));
            }
        }

        for (let index = 0; index < deletedFilenames.length; index += FAST_CHARACTER_CACHE_PAGE_SIZE) {
            const batch = deletedFilenames.slice(index, index + FAST_CHARACTER_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, FAST_CHARACTER_CACHE_DATABASE, FAST_CHARACTER_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to persist character cache changes:', error.message);
    }
}

function normalizePersistentCacheItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    if (value.schema !== FAST_CHARACTER_CACHE_SCHEMA) {
        return null;
    }

    if (!Number.isFinite(value.mtime) || !value.data || typeof value.data !== 'object') {
        return null;
    }

    if (typeof value.data.name !== 'string' || !value.data.name.trim()) {
        return null;
    }

    return {
        mtime: value.mtime,
        size: Number.isFinite(value.size) ? value.size : undefined,
        data: value.data,
    };
}

async function getFastRecentChats(req) {
    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const startedAt = Date.now();
    const pinnedChats = Array.isArray(req.body?.pinned) ? req.body.pinned : [];
    const max = normalizeRecentMax(req.body?.max) + pinnedChats.length;
    const withMetadata = Boolean(req.body?.metadata);
    const allChatFiles = [];
    const metrics = {
        characterFiles: 0,
        groupFiles: 0,
        rootFiles: 0,
        invalidFiles: 0,
        selectedFiles: 0,
        totalMs: 0,
    };

    await Promise.allSettled([
        collectFastRecentCharacterChatFiles(req, allChatFiles, metrics),
        collectFastRecentGroupChatFiles(req, allChatFiles, metrics),
        collectFastRecentRootChatFiles(req, allChatFiles, metrics),
    ]);

    const recentChats = allChatFiles.sort((a, b) => {
        const isAPinned = isPinnedRecentChat(a, pinnedChats);
        const isBPinned = isPinnedRecentChat(b, pinnedChats);

        if (isAPinned && !isBPinned) return -1;
        if (!isAPinned && isBPinned) return 1;

        return b.mtime - a.mtime;
    }).slice(0, max);
    metrics.selectedFiles = recentChats.length;

    const chatData = await Promise.allSettled(recentChats.map(file => getFastRecentChatInfo(file, withMetadata)));
    const validFiles = [];
    for (const result of chatData) {
        if (result.status === 'fulfilled' && result.value?.file_name) {
            validFiles.push(result.value);
        } else if (result.status === 'rejected') {
            metrics.invalidFiles += 1;
        }
    }

    metrics.totalMs = Date.now() - startedAt;
    return { data: validFiles, metrics };
}

function normalizeRecentMax(value) {
    const max = parseInt(value ?? Number.MAX_SAFE_INTEGER);
    return Number.isFinite(max) && max > 0 ? max : Number.MAX_SAFE_INTEGER;
}

async function collectFastRecentCharacterChatFiles(req, allChatFiles, metrics) {
    const directories = req.user?.directories || {};
    const charactersDir = directories.characters;
    const chatsDir = directories.chats;

    if (!charactersDir || !chatsDir) {
        return;
    }

    const characterDirents = await fs.promises.readdir(charactersDir, { withFileTypes: true });
    const avatarSet = new Set(characterDirents
        .filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.png')
        .map(dirent => dirent.name));
    const chatDirents = await fs.promises.readdir(chatsDir, { withFileTypes: true });

    for (const dirent of chatDirents) {
        if (!dirent.isDirectory()) {
            continue;
        }

        const pngFile = `${dirent.name}.png`;
        if (!avatarSet.has(pngFile)) {
            continue;
        }

        const pathToChats = path.join(chatsDir, dirent.name);
        const chatFiles = await fs.promises.readdir(pathToChats, { withFileTypes: true });
        const jsonlFiles = chatFiles.filter(file => file.isFile() && path.extname(file.name) === '.jsonl');

        for (const file of jsonlFiles) {
            const filePath = path.join(pathToChats, file.name);
            const stats = await fs.promises.stat(filePath);
            allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
            metrics.characterFiles += 1;
        }
    }
}

async function collectFastRecentGroupChatFiles(req, allChatFiles, metrics) {
    const directories = req.user?.directories || {};
    const groupsDir = directories.groups;
    const groupChatsDir = directories.groupChats;

    if (!groupsDir || !groupChatsDir) {
        return;
    }

    const groupDirents = await fs.promises.readdir(groupsDir, { withFileTypes: true });
    const groups = groupDirents.filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.json');

    for (const group of groups) {
        try {
            const groupPath = path.join(groupsDir, group.name);
            const groupData = JSON.parse(await fs.promises.readFile(groupPath, 'utf8'));

            if (!Array.isArray(groupData.chats)) {
                continue;
            }

            for (const chat of groupData.chats) {
                const filePath = path.join(groupChatsDir, `${chat}.jsonl`);
                if (!fs.existsSync(filePath)) {
                    continue;
                }

                const stats = await fs.promises.stat(filePath);
                allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                metrics.groupFiles += 1;
            }
        } catch {
            continue;
        }
    }
}

async function collectFastRecentRootChatFiles(req, allChatFiles, metrics) {
    const chatsDir = req.user?.directories?.chats;
    if (!chatsDir) {
        return;
    }

    const dirents = await fs.promises.readdir(chatsDir, { withFileTypes: true });
    const chatFiles = dirents.filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.jsonl');

    for (const file of chatFiles) {
        const filePath = path.join(chatsDir, file.name);
        const stats = await fs.promises.stat(filePath);
        allChatFiles.push({ filePath, mtime: stats.mtimeMs });
        metrics.rootFiles += 1;
    }
}

function isPinnedRecentChat(chatFile, pinnedChats) {
    return pinnedChats.some(pinned => {
        return pinned?.file_name === path.basename(chatFile.filePath)
            && (pinned.avatar === chatFile.pngFile || pinned.group === chatFile.groupId);
    });
}

async function getFastRecentChatInfo(chatFile, withMetadata = false) {
    const parsedPath = path.parse(chatFile.filePath);
    let stats;
    try {
        stats = await fs.promises.stat(chatFile.filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }

    const chatData = {
        file_id: parsedPath.name,
        file_name: parsedPath.base,
        file_size: bytes.format(stats.size) ?? '',
        chat_items: 0,
        mes: '[The chat is empty]',
        last_mes: stats.mtimeMs,
    };

    if (chatFile.groupId) {
        chatData.group = chatFile.groupId;
    } else if (chatFile.pngFile) {
        chatData.avatar = chatFile.pngFile;
    }

    if (stats.size === 0) {
        return chatData;
    }

    let fileHandle;
    try {
        fileHandle = await fs.promises.open(chatFile.filePath, 'r');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }

    try {
        const scan = await scanJsonlLineInfo(fileHandle, stats.size);

        if (withMetadata && scan.firstLineLength > 0) {
            const firstLine = await readFileRangeAsUtf8(fileHandle, scan.firstLineStart, scan.firstLineLength);
            const firstJson = parseJsonLine(firstLine);
            if (firstJson?.chat_metadata && typeof firstJson.chat_metadata === 'object') {
                chatData.chat_metadata = firstJson.chat_metadata;
            }
        }

        const rawLastLine = scan.lastLineLength > 0
            ? await readFileRangeAsUtf8(fileHandle, scan.lastLineStart, scan.lastLineLength)
            : '';
        const tail = summarizeScannedChatTail(
            scan,
            rawLastLine,
            stats.mtimeMs,
            chatFile.filePath,
            '[baibaoku] Found an invalid or corrupted last line in a chat file:',
        );
        chatData.chat_items = tail.chatItems;
        chatData.mes = tail.mes;
        chatData.last_mes = tail.lastMes;
        return chatData;
    } finally {
        await fileHandle.close();
    }
}

async function scanJsonlLineInfo(fileHandle, fileSize) {
    const buffer = Buffer.allocUnsafe(FAST_RECENT_CHAT_READ_BUFFER_SIZE);
    let lineCounter = 0;
    let position = 0;
    let previousLineStart = 0;
    let lastLineStart = 0;
    let firstLineEnd = -1;
    let lastByte = null;

    while (position < fileSize) {
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
            break;
        }

        const chunk = buffer.subarray(0, bytesRead);
        let searchOffset = 0;
        let newlineOffset;

        while ((newlineOffset = chunk.indexOf(10, searchOffset)) !== -1) {
            const absoluteOffset = position + newlineOffset;
            if (firstLineEnd === -1) {
                firstLineEnd = absoluteOffset;
            }
            lineCounter += 1;
            previousLineStart = lastLineStart;
            lastLineStart = absoluteOffset + 1;
            searchOffset = newlineOffset + 1;
        }

        lastByte = chunk[bytesRead - 1];
        position += bytesRead;
    }

    if (position > 0 && lastByte !== 10) {
        lineCounter += 1;
    }

    const firstLineLength = firstLineEnd === -1 ? position : firstLineEnd;
    const lastLineStartOffset = lastByte === 10 ? previousLineStart : lastLineStart;
    const lastLineEndOffset = lastByte === 10 ? Math.max(0, position - 1) : position;

    return {
        lineCounter,
        firstLineStart: 0,
        firstLineLength,
        lastLineStart: lastLineStartOffset,
        lastLineLength: Math.max(0, lastLineEndOffset - lastLineStartOffset),
    };
}

async function readFileRangeAsUtf8(fileHandle, start, length) {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
}

function parseJsonLine(line) {
    try {
        return JSON.parse(String(line ?? '').replace(/\r$/, ''));
    } catch {
        return null;
    }
}

function summarizeScannedChatTail(scan, rawLastLine, mtimeMs, filePath, warnMessage) {
    const normalizedLastLine = typeof rawLastLine === 'string' ? rawLastLine.replace(/\r$/, '') : '';
    if (!normalizedLastLine) {
        return {
            chatItems: 0,
            mes: '[The chat is empty]',
            lastMes: mtimeMs,
        };
    }

    const jsonData = parseJsonLine(normalizedLastLine);
    if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
        return {
            chatItems: Math.max(0, scan.lineCounter - 1),
            mes: jsonData.mes || '[The message is empty]',
            lastMes: jsonData.send_date || new Date(Math.round(mtimeMs)).toISOString(),
        };
    }

    console.warn(warnMessage, filePath);
    return {
        chatItems: Math.max(scan.lineCounter - 2, 0),
        mes: '[The message is empty]',
        lastMes: mtimeMs,
    };
}

function getFastSearchPreviewMessage(lastMessage) {
    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > FAST_SEARCH_PREVIEW_LENGTH
        ? '...' + lastMessage.substring(lastMessage.length - FAST_SEARCH_PREVIEW_LENGTH)
        : lastMessage;
}

function getFastSearchFragments(query) {
    return String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

async function mapFastSearchLimited(items, limit, mapper) {
    if (items.length === 0) {
        return [];
    }

    const results = new Array(items.length);
    const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            try {
                results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

/**
 * Scans a chat file and returns search metadata, mirroring ST's getChatInfo degraded preview
 * behavior so corrupted/blank trailing lines never hide an existing chat file.
 */
async function computeFastSearchResult(chatFilePath, stats) {
    const parsedPath = path.parse(chatFilePath);
    const result = {
        file_name: parsedPath.name,
        file_size: bytes.format(stats.size) ?? '',
        message_count: 0,
        last_mes: stats.mtimeMs,
        preview_message: '[The chat is empty]',
    };

    if (stats.size === 0) {
        return result;
    }

    const fileHandle = await fs.promises.open(chatFilePath, 'r');

    try {
        const scan = await scanJsonlLineInfo(fileHandle, stats.size);
        const rawLastLine = scan.lastLineLength > 0
            ? await readFileRangeAsUtf8(fileHandle, scan.lastLineStart, scan.lastLineLength)
            : '';
        const tail = summarizeScannedChatTail(
            scan,
            rawLastLine,
            stats.mtimeMs,
            chatFilePath,
            '[baibaoku] Found an invalid or corrupted last line in a chat file:',
        );
        result.message_count = tail.chatItems;
        result.preview_message = getFastSearchPreviewMessage(tail.mes);
        result.last_mes = tail.lastMes;
        return result;
    } finally {
        await fileHandle.close();
    }
}

function normalizeFastSearchCacheEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    if (value.schema !== FAST_SEARCH_CACHE_SCHEMA) {
        return null;
    }

    if (!Number.isFinite(value.mtime) || !Number.isFinite(value.size)) {
        return null;
    }

    if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
        return null;
    }

    if (typeof value.result.file_name !== 'string' || !value.result.file_name) {
        return null;
    }

    return { mtime: value.mtime, size: value.size, result: value.result };
}

async function loadFastSearchCache(req, manager) {
    const cache = new Map();
    if (!manager) {
        return cache;
    }

    try {
        await manager.openForRequest(req, FAST_SEARCH_CACHE_DATABASE, {
            displayName: '柏宝库内部缓存',
            version: FAST_SEARCH_CACHE_VERSION,
        });

        const staleKeys = [];
        let offset = 0;
        while (true) {
            const result = await manager.entries(req, FAST_SEARCH_CACHE_DATABASE, FAST_SEARCH_CACHE_STORE, {
                prefix: '',
                limit: FAST_SEARCH_CACHE_PAGE_SIZE,
                offset,
            });

            const entries = result.entries || [];
            for (const entry of entries) {
                const item = normalizeFastSearchCacheEntry(entry.value);
                if (item) {
                    cache.set(entry.key, item);
                } else {
                    staleKeys.push(entry.key);
                }
            }

            if (entries.length < FAST_SEARCH_CACHE_PAGE_SIZE) {
                break;
            }
            offset += FAST_SEARCH_CACHE_PAGE_SIZE;
        }

        for (let index = 0; index < staleKeys.length; index += FAST_SEARCH_CACHE_PAGE_SIZE) {
            const batch = staleKeys.slice(index, index + FAST_SEARCH_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, FAST_SEARCH_CACHE_DATABASE, FAST_SEARCH_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to load persistent fast-search cache:', error.message);
    }

    return cache;
}

async function getFastSearchUserCache(req, manager, userHandle) {
    if (fastSearchUserCaches.has(userHandle)) {
        return fastSearchUserCaches.get(userHandle);
    }

    // Dedupe concurrent first-loads for the same user.
    if (!fastSearchLoadLocks.has(userHandle)) {
        const loadPromise = loadFastSearchCache(req, manager)
            .then((cache) => {
                fastSearchUserCaches.set(userHandle, cache);
                return cache;
            })
            .finally(() => fastSearchLoadLocks.delete(userHandle));
        fastSearchLoadLocks.set(userHandle, loadPromise);
    }

    return fastSearchLoadLocks.get(userHandle);
}

async function persistFastSearchChanges(req, manager, updatedEntries, deletedKeys) {
    if (!manager) {
        return;
    }

    try {
        for (let index = 0; index < updatedEntries.length; index += FAST_SEARCH_CACHE_PAGE_SIZE) {
            const batch = updatedEntries.slice(index, index + FAST_SEARCH_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.setMany(req, FAST_SEARCH_CACHE_DATABASE, FAST_SEARCH_CACHE_STORE, batch.map(({ key, item }) => ({
                    key,
                    value: { schema: FAST_SEARCH_CACHE_SCHEMA, ...item },
                })));
            }
        }

        for (let index = 0; index < deletedKeys.length; index += FAST_SEARCH_CACHE_PAGE_SIZE) {
            const batch = deletedKeys.slice(index, index + FAST_SEARCH_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, FAST_SEARCH_CACHE_DATABASE, FAST_SEARCH_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to persist fast-search cache changes:', error.message);
    }
}

function normalizeChatBackupCacheEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    if (value.schema !== CHAT_BACKUP_CACHE_SCHEMA) {
        return null;
    }

    if (!Number.isFinite(value.mtime) || !Number.isFinite(value.size)) {
        return null;
    }

    if (!Number.isInteger(value.chatItems) || value.chatItems < 0) {
        return null;
    }

    const validLastMes = (typeof value.lastMes === 'string' && value.lastMes.length > 0)
        || Number.isFinite(value.lastMes);
    if (typeof value.mes !== 'string' || !validLastMes) {
        return null;
    }

    return {
        mtime: value.mtime,
        size: value.size,
        chatItems: value.chatItems,
        mes: value.mes,
        lastMes: value.lastMes,
    };
}

async function loadChatBackupCache(req, manager) {
    const cache = new Map();
    if (!manager) {
        return cache;
    }

    try {
        await manager.openForRequest(req, CHAT_BACKUP_CACHE_DATABASE, {
            displayName: 'BaiBaoKu internal cache',
            version: CHAT_BACKUP_CACHE_VERSION,
        });

        const staleKeys = [];
        let offset = 0;
        while (true) {
            const result = await manager.entries(req, CHAT_BACKUP_CACHE_DATABASE, CHAT_BACKUP_CACHE_STORE, {
                prefix: '',
                limit: CHAT_BACKUP_CACHE_PAGE_SIZE,
                offset,
            });
            const entries = result.entries || [];

            for (const entry of entries) {
                const item = normalizeChatBackupCacheEntry(entry.value);
                if (item) {
                    cache.set(entry.key, item);
                } else {
                    staleKeys.push(entry.key);
                }
            }

            if (entries.length < CHAT_BACKUP_CACHE_PAGE_SIZE) {
                break;
            }
            offset += CHAT_BACKUP_CACHE_PAGE_SIZE;
        }

        for (let index = 0; index < staleKeys.length; index += CHAT_BACKUP_CACHE_PAGE_SIZE) {
            const batch = staleKeys.slice(index, index + CHAT_BACKUP_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, CHAT_BACKUP_CACHE_DATABASE, CHAT_BACKUP_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to load persistent chat backup cache:', error.message);
    }

    return cache;
}

async function getChatBackupUserCache(req, manager, userHandle) {
    if (chatBackupUserCaches.has(userHandle)) {
        return chatBackupUserCaches.get(userHandle);
    }

    if (!chatBackupLoadLocks.has(userHandle)) {
        const loadPromise = loadChatBackupCache(req, manager)
            .then((cache) => {
                chatBackupUserCaches.set(userHandle, cache);
                return cache;
            })
            .finally(() => chatBackupLoadLocks.delete(userHandle));
        chatBackupLoadLocks.set(userHandle, loadPromise);
    }

    return chatBackupLoadLocks.get(userHandle);
}

async function persistChatBackupChanges(req, manager, updatedEntries, deletedKeys) {
    if (!manager) {
        return;
    }

    try {
        for (let index = 0; index < updatedEntries.length; index += CHAT_BACKUP_CACHE_PAGE_SIZE) {
            const batch = updatedEntries.slice(index, index + CHAT_BACKUP_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.setMany(req, CHAT_BACKUP_CACHE_DATABASE, CHAT_BACKUP_CACHE_STORE, batch.map(({ key, item }) => ({
                    key,
                    value: { schema: CHAT_BACKUP_CACHE_SCHEMA, ...item },
                })));
            }
        }

        for (let index = 0; index < deletedKeys.length; index += CHAT_BACKUP_CACHE_PAGE_SIZE) {
            const batch = deletedKeys.slice(index, index + CHAT_BACKUP_CACHE_PAGE_SIZE);
            if (batch.length) {
                await manager.deleteMany(req, CHAT_BACKUP_CACHE_DATABASE, CHAT_BACKUP_CACHE_STORE, batch);
            }
        }
    } catch (error) {
        console.warn('[baibaoku] Failed to persist chat backup cache changes:', error.message);
    }
}

async function computeChatBackupSummary(filePath, stats) {
    if (stats.size <= 0) {
        return {
            chatItems: 0,
            mes: '[The chat is empty]',
            lastMes: stats.mtimeMs,
        };
    }

    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
        const scan = await scanJsonlLineInfo(fileHandle, stats.size);
        const rawLastLine = scan.lastLineLength > 0
            ? await readFileRangeAsUtf8(fileHandle, scan.lastLineStart, scan.lastLineLength)
            : '';
        return summarizeScannedChatTail(
            scan,
            rawLastLine,
            stats.mtimeMs,
            filePath,
            '[baibaoku] Found an invalid or corrupted last line in a chat backup file:',
        );
    } finally {
        await fileHandle.close();
    }
}

async function getFastChatBackupList(req, manager) {
    const userHandle = req.user?.profile?.handle;
    const backupDirectory = req.user?.directories?.backups;
    if (!userHandle || !backupDirectory) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const startedAt = Date.now();
    const dirents = await fs.promises.readdir(backupDirectory, { withFileTypes: true });
    const backupFiles = dirents
        .filter(dirent => dirent.isFile()
            && dirent.name.startsWith(CHAT_BACKUP_FILE_PREFIX)
            && path.extname(dirent.name) === CHAT_BACKUP_FILE_EXTENSION)
        .map(dirent => dirent.name);
    const currentFiles = new Set(backupFiles);
    const cache = await getChatBackupUserCache(req, manager, userHandle);
    const updatedEntries = [];
    let cacheHits = 0;
    let cacheMisses = 0;

    const settled = await mapFastSearchLimited(
        backupFiles,
        CHAT_BACKUP_FILE_CONCURRENCY,
        async (fileName) => {
            const filePath = path.join(backupDirectory, fileName);
            const stats = await fs.promises.stat(filePath);
            const cached = cache.get(fileName);
            let summary;

            if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
                cacheHits += 1;
                summary = cached;
            } else {
                cacheMisses += 1;
                const computed = await computeChatBackupSummary(filePath, stats);
                summary = {
                    mtime: stats.mtimeMs,
                    size: stats.size,
                    chatItems: computed.chatItems,
                    mes: computed.mes,
                    lastMes: computed.lastMes,
                };
                cache.set(fileName, summary);
                updatedEntries.push({ key: fileName, item: summary });
            }

            return {
                file_id: path.parse(fileName).name,
                file_name: fileName,
                file_size: bytes.format(stats.size) ?? '',
                chat_items: summary.chatItems,
                mes: summary.mes,
                last_mes: summary.lastMes,
            };
        },
    );

    const data = [];
    let invalidFiles = 0;
    for (const item of settled) {
        if (item.status === 'fulfilled') {
            data.push(item.value);
        } else {
            invalidFiles += 1;
            console.warn('[baibaoku] Failed to read chat backup metadata:', item.reason);
        }
    }

    const deletedKeys = [];
    for (const key of cache.keys()) {
        if (!currentFiles.has(key)) {
            cache.delete(key);
            deletedKeys.push(key);
        }
    }

    await persistChatBackupChanges(req, manager, updatedEntries, deletedKeys);

    return {
        data,
        metrics: {
            totalMs: Date.now() - startedAt,
            totalFiles: backupFiles.length,
            validFiles: data.length,
            invalidFiles,
            cacheHits,
            cacheMisses,
            cacheGc: deletedKeys.length,
        },
    };
}

/**
 * Returns fast-search metadata for a chat file, reusing a cached result when the
 * file's mtime and size are unchanged so the full file scan can be skipped.
 */
async function getFastSearchResult(chatFilePath, cache, updatedEntries) {
    const stats = await fs.promises.stat(chatFilePath);
    const cached = cache.get(chatFilePath);

    if (cached && cached.result && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
        return cached.result;
    }

    const result = await computeFastSearchResult(chatFilePath, stats);
    if (result) {
        const item = { mtime: stats.mtimeMs, size: stats.size, result };
        cache.set(chatFilePath, item);
        updatedEntries.push({ key: chatFilePath, item });
    }
    return result;
}

function createInvalidAvatarUrlError() {
    const error = new Error('Invalid avatar_url');
    error.status = 400;
    return error;
}

function resolveSafeFastSearchCharacterDir(req, avatarUrl) {
    if (typeof avatarUrl !== 'string' || !avatarUrl || FAST_SEARCH_FORBIDDEN_REGEXP.test(avatarUrl)) {
        throw createInvalidAvatarUrlError();
    }

    const characterName = avatarUrl.replace('.png', '');
    if (
        !characterName
        || characterName === '.'
        || characterName === '..'
        || FAST_SEARCH_FORBIDDEN_REGEXP.test(characterName)
    ) {
        throw createInvalidAvatarUrlError();
    }

    const chatsDir = req.user?.directories?.chats;
    if (!chatsDir) {
        return null;
    }

    const resolvedChatsRoot = path.resolve(chatsDir);
    const resolvedCharDir = path.resolve(resolvedChatsRoot, characterName);
    if (!resolvedCharDir.startsWith(resolvedChatsRoot + path.sep)) {
        throw createInvalidAvatarUrlError();
    }

    return path.join(chatsDir, characterName);
}

async function collectFastSearchCharacterFiles(req, avatarUrl) {
    const directoryPath = resolveSafeFastSearchCharacterDir(req, avatarUrl);
    if (!directoryPath || !fs.existsSync(directoryPath)) {
        return [];
    }

    const dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    return dirents
        .filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.jsonl')
        .map(dirent => path.join(directoryPath, dirent.name));
}

function getFastSearchCharacterDirPrefix(req, avatarUrl) {
    const directoryPath = resolveSafeFastSearchCharacterDir(req, avatarUrl);
    if (!directoryPath) {
        return null;
    }
    // Mirror the join used in collectFastSearchCharacterFiles so cache keys match.
    return directoryPath + path.sep;
}

function getFastSearchGroupChatsDirPrefix(req) {
    const groupChatsDir = req.user?.directories?.groupChats;
    if (!groupChatsDir) {
        return null;
    }

    return path.join(groupChatsDir) + path.sep;
}

async function collectFastSearchGroupFiles(req, groupId) {
    const groupsDir = req.user?.directories?.groups;
    const groupChatsDir = req.user?.directories?.groupChats;
    if (!groupsDir || !groupChatsDir || typeof groupId !== 'string' || !groupId) {
        return [];
    }

    const groupDirents = await fs.promises.readdir(groupsDir, { withFileTypes: true });
    const groupFiles = groupDirents.filter(dirent => dirent.isFile() && path.extname(dirent.name) === '.json');

    let targetGroup = null;
    for (const groupFile of groupFiles) {
        try {
            const groupData = JSON.parse(await fs.promises.readFile(path.join(groupsDir, groupFile.name), 'utf8'));
            if (groupData.id === groupId) {
                targetGroup = groupData;
                break;
            }
        } catch (error) {
            console.warn('[baibaoku] Group file is corrupted:', groupFile.name, error.message);
        }
    }

    if (!Array.isArray(targetGroup?.chats)) {
        return [];
    }

    const resolvedGroupChatsRoot = path.resolve(groupChatsDir);
    const validFiles = [];
    for (const chatId of targetGroup.chats) {
        if (typeof chatId !== 'string' || !chatId || FAST_SEARCH_FORBIDDEN_REGEXP.test(chatId)) {
            continue;
        }
        const filePath = path.join(groupChatsDir, `${chatId}.jsonl`);
        if (!path.resolve(filePath).startsWith(resolvedGroupChatsRoot + path.sep)) {
            continue;
        }
        if (fs.existsSync(filePath)) {
            validFiles.push(filePath);
        }
    }
    return validFiles;
}

async function getFastSearch(req, manager) {
    const userHandle = req.user?.profile?.handle;
    if (!userHandle) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
    }

    const startedAt = Date.now();
    const query = req.body?.query;
    const avatarUrl = req.body?.avatar_url;
    const groupId = req.body?.group_id;

    // This fast path only handles the empty-query listing. Text queries fall back
    // to ST's original /api/chats/search on the frontend.
    if (getFastSearchFragments(query).length !== 0) {
        const error = new Error('fast-search only supports empty queries');
        error.status = 409;
        throw error;
    }

    // Manual path-traversal guard (the plugin router has no validateAvatarUrlMiddleware).
    if (!groupId) {
        resolveSafeFastSearchCharacterDir(req, avatarUrl);
    } else if (avatarUrl !== undefined && avatarUrl !== null && avatarUrl !== '') {
        if (typeof avatarUrl !== 'string' || FAST_SEARCH_FORBIDDEN_REGEXP.test(avatarUrl)) {
            throw createInvalidAvatarUrlError();
        }
    }

    const chatFiles = groupId
        ? await collectFastSearchGroupFiles(req, groupId)
        : await collectFastSearchCharacterFiles(req, avatarUrl);

    const cache = await getFastSearchUserCache(req, manager, userHandle);
    const updatedEntries = [];

    const settled = await mapFastSearchLimited(
        chatFiles,
        FAST_SEARCH_FILE_CONCURRENCY,
        chatFile => getFastSearchResult(chatFile, cache, updatedEntries),
    );
    const data = [];
    let invalidFiles = 0;
    for (const item of settled) {
        if (item.status === 'rejected') {
            if (item.reason?.code !== 'ENOENT') {
                invalidFiles += 1;
                console.warn('[baibaoku] Failed to read fast-search metadata:', item.reason);
            }
            continue;
        }
        if (item.value) {
            data.push(item.value);
        }
    }

    const deletedKeys = [];
    const presentKeys = new Set(chatFiles);
    if (!groupId) {
        const dirPrefix = getFastSearchCharacterDirPrefix(req, avatarUrl);
        if (dirPrefix) {
            for (const key of cache.keys()) {
                if (key.startsWith(dirPrefix) && !presentKeys.has(key)) {
                    cache.delete(key);
                    deletedKeys.push(key);
                }
            }
        }
    } else {
        const groupChatsDirPrefix = getFastSearchGroupChatsDirPrefix(req);
        if (groupChatsDirPrefix) {
            for (const key of cache.keys()) {
                if (key.startsWith(groupChatsDirPrefix) && !presentKeys.has(key) && !fs.existsSync(key)) {
                    cache.delete(key);
                    deletedKeys.push(key);
                }
            }
        }
    }

    if (updatedEntries.length || deletedKeys.length) {
        await persistFastSearchChanges(req, manager, updatedEntries, deletedKeys);
    }

    return {
        data,
        metrics: {
            totalMs: Date.now() - startedAt,
            totalFiles: chatFiles.length,
            validFiles: data.length,
            invalidFiles,
            cacheMisses: updatedEntries.length,
            cacheGc: deletedKeys.length,
        },
    };
}

function getSettingsPath(req) {
    return path.join(req.user.directories.root, SETTINGS_FILE);
}

function shouldUseLazyThemeSettingsPayload(req) {
    return String(req.get('x-baibaoku-lazy-themes') || '') === '1';
}

const LAZY_THEME_TOOLKIT_SCAN_TTL_MS = 30_000;
const lazyThemeToolkitDirCache = new Map();

function scanExtensionBaseForToolkitFolders(baseDir, now) {
    let dirExists = false;
    let mtimeMs = 0;
    try {
        const stat = fs.statSync(baseDir);
        if (stat.isDirectory()) {
            dirExists = true;
            mtimeMs = stat.mtimeMs;
        }
    } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
            throw error;
        }
    }

    const cached = lazyThemeToolkitDirCache.get(baseDir);
    if (cached && cached.exists === dirExists && cached.mtimeMs === mtimeMs && now < cached.expiresAt) {
        return cached.entries;
    }

    if (!dirExists) {
        const emptyEntries = [];
        lazyThemeToolkitDirCache.set(baseDir, {
            exists: false,
            mtimeMs: 0,
            entries: emptyEntries,
            expiresAt: now + LAZY_THEME_TOOLKIT_SCAN_TTL_MS,
        });
        return emptyEntries;
    }

    const dirents = fs.readdirSync(baseDir, { withFileTypes: true });
    const entries = [];
    for (const dirent of dirents) {
        const folder = dirent.name;
        if (!folder || folder.startsWith('.baibaoku-')) {
            continue;
        }
        const folderPath = path.join(baseDir, folder);
        let isDir = dirent.isDirectory();
        if (!isDir && dirent.isSymbolicLink()) {
            try {
                isDir = fs.statSync(folderPath).isDirectory();
            } catch {
                isDir = false;
            }
        }
        if (!isDir || !hasExtensionManifest(baseDir, folder)) {
            continue;
        }

        let isToolkit = folder === 'ST-BaiBai-Tools' || folder === 'SillyTavern-Mobile-Resize-Guard';
        if (!isToolkit) {
            try {
                const manifest = JSON.parse(fs.readFileSync(path.join(folderPath, 'manifest.json'), 'utf8'));
                isToolkit = manifest?.display_name === '柏宝箱';
            } catch (error) {
                if (error instanceof SyntaxError || error?.code === 'ENOENT') {
                    isToolkit = false;
                } else {
                    throw error;
                }
            }
        }
        entries.push({ folder, isToolkit });
    }

    lazyThemeToolkitDirCache.set(baseDir, {
        exists: true,
        mtimeMs,
        entries,
        expiresAt: now + LAZY_THEME_TOOLKIT_SCAN_TTL_MS,
    });
    return entries;
}

export function hasActiveLazyThemeHydrator(req, settingsText, {
    globalExtensionsDir = PUBLIC_DIRECTORIES.globalExtensions,
    powerUserPath,
    themeBridgeInstalled,
    extensionsEnabled = true,
    now = Date.now(),
} = {}) {
    if (extensionsEnabled === false) {
        return false;
    }

    const bridgeInstalled = typeof themeBridgeInstalled === 'boolean'
        ? themeBridgeInstalled
        : (powerUserPath ? getThemeBridgeStatus({ powerUserPath }) : getThemeBridgeStatus());
    if (!bridgeInstalled) {
        return false;
    }

    try {
        const parsedSettings = settingsText ? JSON.parse(settingsText) : {};
        const disabledList = Array.isArray(parsedSettings?.extension_settings?.disabledExtensions)
            ? parsedSettings.extension_settings.disabledExtensions
            : [];
        const disabledSet = new Set(disabledList.map(item => String(item || '').trim()));

        const userExtensionsDir = req?.user?.directories?.extensions;
        const candidateBases = [userExtensionsDir, globalExtensionsDir].filter(Boolean);
        const seenFolders = new Set();

        for (const baseDir of candidateBases) {
            const entries = scanExtensionBaseForToolkitFolders(baseDir, now);
            for (const { folder, isToolkit } of entries) {
                if (seenFolders.has(folder)) {
                    continue;
                }
                seenFolders.add(folder);

                const extId = `third-party/${folder}`;
                if (disabledSet.has(extId) || disabledSet.has(folder)) {
                    continue;
                }
                if (isToolkit) {
                    return true;
                }
            }
        }

        return false;
    } catch {
        return false;
    }
}

function getCurrentThemeNameFromSettingsText(text) {
    try {
        const settings = JSON.parse(text || '{}');
        return typeof settings?.power_user?.theme === 'string' ? settings.power_user.theme : '';
    } catch {
        return '';
    }
}

function getSettingsUpdateLockKey(userHandle, payloadOptions) {
    const options = getSettingsPayloadOptions(payloadOptions);
    return [
        userHandle,
        options.themeMode,
        options.currentThemeName,
    ].join('\0');
}

function getBaibaokuCacheDirectory(req) {
    return path.join(req.user.directories.root, 'baibaoku', 'cache');
}

function getSettingsTextPersistPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_TEXT_PERSIST_FILE);
}

function getSettingsPayloadPersistPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_PAYLOAD_PERSIST_FILE);
}

function getSettingsResponseMetaPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_RESPONSE_META_FILE);
}

function getSettingsResponseBodyPath(req) {
    return path.join(getBaibaokuCacheDirectory(req), SETTINGS_RESPONSE_BODY_FILE);
}

function cacheSettingsText(userHandle, settingsPath, text, stat) {
    settingsFileCaches.set(userHandle, {
        path: settingsPath,
        text,
        mtime: stat.mtimeMs,
        size: stat.size,
        contentHash: hashSettingsFileContent(text),
        updatedAt: Date.now(),
    });
    settingsResponseCaches.delete(userHandle);
}

function schedulePersistSettingsText(req, userHandle) {
    setTimeout(() => {
        void persistSettingsTextToDisk(req, userHandle)
            .catch((error) => {
                console.warn('[baibaoku] Failed to persist settings text cache:', error.message);
            });
    }, 0);
}

async function persistSettingsTextToDisk(req, userHandle) {
    const cached = settingsFileCaches.get(userHandle);
    if (!cached) {
        return false;
    }

    const payload = {
        version: SETTINGS_TEXT_PERSIST_VERSION,
        savedAt: Date.now(),
        path: cached.path,
        mtime: cached.mtime,
        size: cached.size,
        contentHash: cached.contentHash,
        updatedAt: cached.updatedAt,
        text: cached.text,
    };

    await writeFileAtomicAsync(getSettingsTextPersistPath(req), JSON.stringify(payload));
    return true;
}

async function restoreSettingsTextFromDisk(req, userHandle, settingsPath, stat) {
    let persisted;

    try {
        persisted = JSON.parse(await fs.promises.readFile(getSettingsTextPersistPath(req), 'utf8'));
    } catch {
        return null;
    }

    if (
        persisted?.version !== SETTINGS_TEXT_PERSIST_VERSION
        || persisted.path !== settingsPath
        || persisted.mtime !== stat.mtimeMs
        || persisted.size !== stat.size
        || typeof persisted.contentHash !== 'string'
        || typeof persisted.text !== 'string'
    ) {
        return null;
    }

    const currentText = await fs.promises.readFile(settingsPath, 'utf8');
    const currentHash = hashSettingsFileContent(currentText);
    if (currentHash !== persisted.contentHash) {
        return null;
    }

    settingsFileCaches.set(userHandle, {
        path: settingsPath,
        text: currentText,
        mtime: stat.mtimeMs,
        size: stat.size,
        contentHash: currentHash,
        updatedAt: Number(persisted.updatedAt) || Date.now(),
    });

    return {
        ...settingsFileCaches.get(userHandle),
        cacheHit: true,
        cacheStatus: 'persistent-hit',
    };
}

function getFreshSettingsTextCache(userHandle, settingsPath, stat) {
    const cached = settingsFileCaches.get(userHandle);

    if (
        !cached
        || cached.path !== settingsPath
        || cached.mtime !== stat.mtimeMs
        || cached.size !== stat.size
        || typeof cached.contentHash !== 'string'
    ) {
        return null;
    }

    return cached;
}

async function readSettingsTextWithCache(req, userHandle) {
    const settingsPath = getSettingsPath(req);
    const stat = await fs.promises.stat(settingsPath);

    const cached = getFreshSettingsTextCache(userHandle, settingsPath, stat);
    if (cached) {
        return {
            ...cached,
            cacheHit: true,
            cacheStatus: 'hit',
        };
    }

    const persisted = await restoreSettingsTextFromDisk(req, userHandle, settingsPath, stat);
    if (persisted) {
        return persisted;
    }

    const text = await fs.promises.readFile(settingsPath, 'utf8');
    cacheSettingsText(userHandle, settingsPath, text, stat);
    schedulePersistSettingsText(req, userHandle);

    return {
        ...settingsFileCaches.get(userHandle),
        cacheHit: false,
        cacheStatus: 'miss',
    };
}

function queueSettingsSave(userHandle, task) {
    const previous = settingsSaveLocks.get(userHandle) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tracked = run.finally(() => {
        if (settingsSaveLocks.get(userHandle) === tracked) {
            settingsSaveLocks.delete(userHandle);
        }
    });

    settingsSaveLocks.set(userHandle, tracked);
    return tracked;
}

async function waitForPendingSettingsSave(userHandle) {
    const pendingSave = settingsSaveLocks.get(userHandle);

    if (pendingSave) {
        await pendingSave.catch(() => {});
    }
}

function parseSettingsSaveSeqHeader(rawHeader) {
    if (typeof rawHeader !== 'string' || !rawHeader) {
        return null;
    }
    const separatorIndex = rawHeader.lastIndexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= rawHeader.length - 1) {
        return null;
    }
    const epoch = rawHeader.slice(0, separatorIndex).trim();
    const seqText = rawHeader.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(epoch) || !/^\d{1,15}$/.test(seqText)) {
        return null;
    }
    const seq = Number(seqText);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
        return null;
    }
    return { epoch, seq };
}

function isSupersededClientSaveSeq(userHandle, token) {
    const epochMap = settingsClientSaveSeqs.get(userHandle);
    if (!epochMap) {
        return false;
    }
    const committedSeq = epochMap.get(token.epoch) || 0;
    return token.seq < committedSeq;
}

function recordCommittedClientSaveSeq(userHandle, token) {
    let epochMap = settingsClientSaveSeqs.get(userHandle);
    if (!epochMap) {
        epochMap = new Map();
        settingsClientSaveSeqs.set(userHandle, epochMap);
    }
    const previousSeq = epochMap.get(token.epoch) || 0;
    if (token.seq < previousSeq) {
        return;
    }
    // Refresh insertion order for LRU/FIFO bounding across page reloads.
    epochMap.delete(token.epoch);
    epochMap.set(token.epoch, token.seq);
    while (epochMap.size > MAX_CLIENT_SAVE_EPOCHS_PER_USER) {
        const oldestEpoch = epochMap.keys().next().value;
        epochMap.delete(oldestEpoch);
    }
}

async function saveSettingsWithCache(req, userHandle) {
    const rawSaveSeqHeader = typeof req?.get === 'function'
        ? req.get('x-baibaoku-save-seq')
        : req?.headers?.['x-baibaoku-save-seq'];
    const saveSeqToken = parseSettingsSaveSeqHeader(rawSaveSeqHeader);
    if (saveSeqToken && isSupersededClientSaveSeq(userHandle, saveSeqToken)) {
        return { result: 'ok', skipped: true, superseded: true };
    }

    const settingsPath = getSettingsPath(req);
    const text = JSON.stringify(req.body ?? {}, null, 4);
    let currentStat = null;

    try {
        currentStat = await fs.promises.stat(settingsPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    if (currentStat) {
        const cached = getFreshSettingsTextCache(userHandle, settingsPath, currentStat);
        const currentText = cached ? cached.text : await fs.promises.readFile(settingsPath, 'utf8');

        if (currentText === text) {
            if (saveSeqToken) {
                recordCommittedClientSaveSeq(userHandle, saveSeqToken);
            }
            return { result: 'ok', skipped: true };
        }
    }

    writeFileAtomicSync(settingsPath, text, 'utf8');

    if (saveSeqToken) {
        recordCommittedClientSaveSeq(userHandle, saveSeqToken);
    }

    const stat = await fs.promises.stat(settingsPath);
    cacheSettingsText(userHandle, settingsPath, text, stat);
    schedulePersistSettingsText(req, userHandle);

    return { result: 'ok' };
}

function getSettingsBackupFilePrefix(userHandle) {
    return `settings_${userHandle}_`;
}

function getSettingsBackupPayload(req, userHandle) {
    const directories = req.user?.directories;
    if (!directories?.backups || !directories?.root) {
        return null;
    }

    return {
        userHandle,
        backupDir: directories.backups,
        settingsPath: path.join(directories.root, SETTINGS_FILE),
    };
}

function getSettingsBackupScheduler(userHandle) {
    if (!settingsBackupSchedulers.has(userHandle)) {
        settingsBackupSchedulers.set(userHandle, {
            lastBackupAt: 0,
            timer: null,
            pendingPayload: null,
        });
    }

    return settingsBackupSchedulers.get(userHandle);
}

function scheduleSettingsAutoBackup(req, userHandle) {
    const payload = getSettingsBackupPayload(req, userHandle);
    if (!payload) {
        return;
    }

    const scheduler = getSettingsBackupScheduler(userHandle);
    const now = Date.now();
    const elapsed = now - scheduler.lastBackupAt;

    if (!scheduler.timer && elapsed >= SETTINGS_AUTOSAVE_INTERVAL) {
        scheduler.lastBackupAt = now;
        scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle, payload), 0);
        return;
    }

    scheduler.pendingPayload = payload;

    if (!scheduler.timer) {
        const delay = Math.max(0, SETTINGS_AUTOSAVE_INTERVAL - elapsed);
        scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle), delay);
    }
}

async function runScheduledSettingsBackup(userHandle, immediatePayload = null) {
    const scheduler = settingsBackupSchedulers.get(userHandle);
    if (!scheduler) {
        return;
    }

    scheduler.timer = null;

    const payload = immediatePayload || scheduler.pendingPayload;
    if (!immediatePayload) {
        scheduler.pendingPayload = null;
    }

    if (!payload) {
        return;
    }

    scheduler.lastBackupAt = Date.now();

    try {
        await backupSettingsIfChanged(payload);
    } catch (error) {
        console.warn('[baibaoku] Settings backup failed:', error.message);
    } finally {
        if (scheduler.pendingPayload && !scheduler.timer) {
            scheduler.timer = setTimeout(() => runScheduledSettingsBackup(userHandle), SETTINGS_AUTOSAVE_INTERVAL);
        }
    }
}

async function backupSettingsIfChanged(payload) {
    const { backupDir, settingsPath, userHandle } = payload;
    const cached = settingsFileCaches.get(userHandle);
    if (cached?.path !== settingsPath || typeof cached.text !== 'string') {
        return;
    }

    // Compare by content hash instead of the full text so we don't keep a second
    // copy of (potentially very large) settings resident in memory just to detect
    // changes. The hash is already computed when the settings text is cached.
    const contentHash = typeof cached.contentHash === 'string'
        ? cached.contentHash
        : hashSettingsFileContent(cached.text);
    if (lastBackupHashes.get(userHandle) === contentHash) {
        return;
    }

    await fs.promises.mkdir(backupDir, { recursive: true });

    const backupFile = path.join(backupDir, `${getSettingsBackupFilePrefix(userHandle)}${generateTimestamp()}.json`);
    await fs.promises.copyFile(settingsPath, backupFile);
    removeOldBackups(backupDir, `settings_${userHandle}`);
    lastBackupHashes.set(userHandle, contentHash);
}

function getSettingsUserCache(userHandle) {
    if (!settingsUserCaches.has(userHandle)) {
        settingsUserCaches.set(userHandle, {
            userHandle,
            sections: new Map(),
            payload: null,
            payloadDirty: true,
            payloadDirtyReason: 'initial',
            payloadDirtyAt: Date.now(),
            payloadBuiltAt: 0,
            payloadCacheKey: '',
            payloadThemeMode: SETTINGS_THEME_MODE_FULL,
            payloadThemeCurrentName: '',
            payloadPersistedBuiltAt: 0,
            payloadPersistPromise: null,
            payloadWatchers: new Map(),
            payloadWatchAttempted: false,
        });
    }

    return settingsUserCaches.get(userHandle);
}

function getSettingsPayloadWatchTargets(directories) {
    return [
        { directoryPath: directories.koboldAI_Settings, sectionName: 'koboldai_settings' },
        { directoryPath: directories.novelAI_Settings, sectionName: 'novelai_settings' },
        { directoryPath: directories.openAI_Settings, sectionName: 'openai_settings' },
        { directoryPath: directories.textGen_Settings, sectionName: 'textgenerationwebui_presets' },
        { directoryPath: directories.worlds, sectionName: null },
        { directoryPath: directories.themes, sectionName: 'themes' },
        { directoryPath: directories.movingUI, sectionName: 'movingUIPresets' },
        { directoryPath: directories.quickreplies, sectionName: 'quickReplyPresets' },
        { directoryPath: directories.instruct, sectionName: 'instruct' },
        { directoryPath: directories.context, sectionName: 'context' },
        { directoryPath: directories.sysprompt, sectionName: 'sysprompt' },
        { directoryPath: directories.reasoning, sectionName: 'reasoning' },
    ].filter(target => target.directoryPath);
}

function markSettingsPayloadDirty(userCache, reason = 'unknown') {
    userCache.payloadDirty = true;
    userCache.payloadDirtyReason = reason;
    userCache.payloadDirtyAt = Date.now();
    settingsResponseCaches.delete(userCache.userHandle);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatSettingsWatchReason(target, eventType, filenameText) {
    return `watch:${eventType}:${target.directoryPath}${filenameText ? `/${filenameText}` : ''}`;
}

async function handleSettingsPayloadWatchEvent(userCache, target, eventType, filename) {
    const filenameText = filename ? String(filename) : '';
    const reason = formatSettingsWatchReason(target, eventType, filenameText);

    if (!filenameText) {
        markSettingsPayloadDirty(userCache, `${reason}:unknown-file`);
        return;
    }

    if (path.extname(filenameText).toLowerCase() !== '.json') {
        return;
    }

    if (!target.sectionName) {
        markSettingsPayloadDirty(userCache, reason);
        return;
    }

    await delay(75);

    const sectionCache = getSettingsSectionCache(userCache, target.sectionName);
    const cached = sectionCache.get(filenameText);
    const filePath = path.join(target.directoryPath, filenameText);
    let stat;
    let file;

    try {
        stat = await fs.promises.stat(filePath);
        file = await fs.promises.readFile(filePath, 'utf8');
    } catch {
        if (cached) {
            markSettingsPayloadDirty(userCache, `${reason}:missing`);
        }
        return;
    }

    const contentHash = hashSettingsFileContent(file);
    if (cached?.contentHash === contentHash) {
        cached.mtime = stat.mtimeMs;
        cached.size = stat.size;
        cached.contentHash = contentHash;
        return;
    }

    markSettingsPayloadDirty(userCache, reason);
}

function ensureSettingsPayloadWatchers(userCache, directories) {
    if (userCache.payloadWatchAttempted) {
        return;
    }

    userCache.payloadWatchAttempted = true;
    const targets = Array.from(new Map(
        getSettingsPayloadWatchTargets(directories).map(target => [target.directoryPath, target]),
    ).values());

    for (const target of targets) {
        try {
            const watcher = fs.watch(target.directoryPath, { persistent: false }, (eventType, filename) => {
                void handleSettingsPayloadWatchEvent(userCache, target, eventType, filename)
                    .catch((error) => {
                        const filenameText = filename ? String(filename) : '';
                        markSettingsPayloadDirty(userCache, `${formatSettingsWatchReason(target, eventType, filenameText)}:validate-error:${error.message}`);
                    });
            });

            watcher.on('error', (error) => {
                markSettingsPayloadDirty(userCache, `watch-error:${target.directoryPath}:${error.message}`);
                console.warn(`[baibaoku] Settings payload watcher failed for ${target.directoryPath}:`, error.message);
            });

            userCache.payloadWatchers.set(target.directoryPath, watcher);
        } catch (error) {
            markSettingsPayloadDirty(userCache, `watch-unavailable:${target.directoryPath}:${error.message}`);
            console.warn(`[baibaoku] Settings payload watcher unavailable for ${target.directoryPath}:`, error.message);
        }
    }
}

function normalizeSettingsThemeMode(mode) {
    return mode === SETTINGS_THEME_MODE_LAZY ? SETTINGS_THEME_MODE_LAZY : SETTINGS_THEME_MODE_FULL;
}

function getSettingsPayloadOptions(options = {}) {
    const themeMode = normalizeSettingsThemeMode(options.themeMode);
    return {
        themeMode,
        currentThemeName: themeMode === SETTINGS_THEME_MODE_LAZY ? String(options.currentThemeName || '') : '',
    };
}

function getCurrentSettingsPayloadOptions(userCache) {
    return getSettingsPayloadOptions({
        themeMode: userCache.payloadThemeMode,
        currentThemeName: userCache.payloadThemeCurrentName,
    });
}

function canUseCachedSettingsPayload(userCache, options = {}) {
    const payloadOptions = getSettingsPayloadOptions(options);

    return Boolean(
        userCache.payload
        && !userCache.payloadDirty
        && userCache.payloadThemeMode === payloadOptions.themeMode
        && userCache.payloadThemeCurrentName === payloadOptions.currentThemeName,
    );
}

function getSettingsSectionCache(userCache, sectionName) {
    if (!userCache.sections.has(sectionName)) {
        userCache.sections.set(sectionName, new Map());
    }

    return userCache.sections.get(sectionName);
}

async function readCachedPresetDirectory(userCache, sectionName, directoryPath) {
    const sectionCache = getSettingsSectionCache(userCache, sectionName);
    const entries = await updateCachedJsonDirectory(sectionCache, directoryPath, {
        sortMode: 'locale',
        valueMode: 'raw-json',
        removeFileExtension: true,
        warnInvalid: true,
    });

    return {
        fileContents: entries.map(entry => entry.value),
        fileNames: entries.map(entry => entry.name),
    };
}

async function readCachedParsedDirectory(userCache, sectionName, directoryPath) {
    const sectionCache = getSettingsSectionCache(userCache, sectionName);
    const entries = await updateCachedJsonDirectory(sectionCache, directoryPath, {
        sortMode: 'default',
        valueMode: 'parsed-json',
        removeFileExtension: false,
        warnInvalid: false,
    });

    return entries.map(entry => entry.value);
}

function hashSettingsFileContent(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

function hashSettingsJson(value) {
    return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function computeSettingsPayloadCacheKey(userCache, payload) {
    const sections = {};

    for (const [sectionName, sectionCache] of Array.from(userCache.sections.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        sections[sectionName] = Array.from(sectionCache.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([filename, entry]) => ({
                filename,
                name: entry.name,
                contentHash: entry.contentHash || null,
                size: entry.size,
                themeIndexVersion: entry.themeIndexVersion || null,
            }));
    }

    return hashSettingsJson({
        version: SETTINGS_PAYLOAD_PERSIST_VERSION,
        themeMode: userCache.payloadThemeMode || SETTINGS_THEME_MODE_FULL,
        themeCurrentName: userCache.payloadThemeCurrentName || '',
        sections,
        world_names: Array.isArray(payload?.world_names) ? payload.world_names : [],
    });
}

async function updateCachedJsonDirectory(sectionCache, directoryPath, options) {
    const {
        sortMode,
        valueMode,
        removeFileExtension,
        warnInvalid,
    } = options;

    const files = (await fs.promises.readdir(directoryPath))
        .filter(file => path.parse(file).ext === '.json')
        .sort(sortMode === 'locale' ? (a, b) => a.localeCompare(b) : undefined);
    const currentFiles = new Set(files);

    for (const cachedFile of sectionCache.keys()) {
        if (!currentFiles.has(cachedFile)) {
            sectionCache.delete(cachedFile);
        }
    }

    await Promise.all(files.map(async (filename) => {
        const filePath = path.join(directoryPath, filename);
        let stat;

        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            sectionCache.delete(filename);
            return;
        }

        const cached = sectionCache.get(filename);
        const cachedHasValue = valueMode === 'raw-json'
            ? typeof cached?.value === 'string'
            : cached?.value !== undefined;
        if (cached && cachedHasValue && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
            return;
        }

        try {
            const file = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(file);
            sectionCache.set(filename, {
                mtime: stat.mtimeMs,
                size: stat.size,
                contentHash: hashSettingsFileContent(file),
                name: removeFileExtension ? filename.replace(/\.[^/.]+$/, '') : filename,
                value: valueMode === 'raw-json' ? file : parsed,
            });
        } catch {
            sectionCache.delete(filename);
            if (warnInvalid) {
                console.warn(`${filename} is not a valid JSON`);
            }
        }
    }));

    return files
        .map(filename => sectionCache.get(filename))
        .filter(Boolean);
}

function getThemeFallbackName(filename) {
    return path.parse(filename).name;
}

function getThemeNameFromParsedFile(parsed, filename) {
    const name = typeof parsed?.name === 'string' && parsed.name.trim()
        ? parsed.name
        : getThemeFallbackName(filename);
    return name;
}

function makeLazyThemeStub(name) {
    return {
        name,
        [SETTINGS_LAZY_THEME_MARKER]: true,
    };
}

async function updateCachedThemeIndexDirectory(sectionCache, directoryPath) {
    const files = (await fs.promises.readdir(directoryPath))
        .filter(file => path.parse(file).ext === '.json')
        .sort();
    const currentFiles = new Set(files);

    for (const cachedFile of sectionCache.keys()) {
        if (!currentFiles.has(cachedFile)) {
            sectionCache.delete(cachedFile);
        }
    }

    await Promise.all(files.map(async (filename) => {
        const filePath = path.join(directoryPath, filename);
        let stat;

        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            sectionCache.delete(filename);
            return;
        }

        const cached = sectionCache.get(filename);
        if (
            cached
            && cached.mtime === stat.mtimeMs
            && cached.size === stat.size
            && typeof cached.name === 'string'
            && typeof cached.contentHash === 'string'
            && cached.themeIndexVersion === SETTINGS_THEME_INDEX_CACHE_VERSION
        ) {
            delete cached.value;
            return;
        }

        try {
            const file = await fs.promises.readFile(filePath, 'utf8');
            const parsed = JSON.parse(file);
            const next = {
                ...(cached || {}),
                mtime: stat.mtimeMs,
                size: stat.size,
                contentHash: hashSettingsFileContent(file),
                name: getThemeNameFromParsedFile(parsed, filename),
                themeIndexVersion: SETTINGS_THEME_INDEX_CACHE_VERSION,
            };
            delete next.value;
            sectionCache.set(filename, next);
        } catch {
            sectionCache.delete(filename);
        }
    }));

    const entries = files
        .map(filename => {
            const entry = sectionCache.get(filename);
            return entry ? { filename, ...entry } : null;
        })
        .filter(Boolean);
    const nameToFilename = new Map();

    for (const entry of entries) {
        if (!nameToFilename.has(entry.name)) {
            nameToFilename.set(entry.name, entry.filename);
        }
    }

    return { entries, nameToFilename };
}

async function readCachedThemeFile(sectionCache, directoryPath, filename) {
    const filePath = path.join(directoryPath, filename);
    const stat = await fs.promises.stat(filePath);
    const cached = sectionCache.get(filename);

    if (cached?.value && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        return cached.value;
    }

    const file = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(file);
    parsed.name = getThemeNameFromParsedFile(parsed, filename);
    sectionCache.set(filename, {
        ...(cached || {}),
        mtime: stat.mtimeMs,
        size: stat.size,
        contentHash: hashSettingsFileContent(file),
        name: parsed.name,
        themeIndexVersion: SETTINGS_THEME_INDEX_CACHE_VERSION,
        value: parsed,
    });
    return parsed;
}

async function readLazyThemeDirectory(userCache, directoryPath, currentThemeName) {
    const sectionCache = getSettingsSectionCache(userCache, 'themes');
    const { entries, nameToFilename } = await updateCachedThemeIndexDirectory(sectionCache, directoryPath);
    const namesToLoad = new Set();
    const firstThemeName = entries[0]?.name || '';

    if (firstThemeName) {
        namesToLoad.add(firstThemeName);
    }
    if (currentThemeName && nameToFilename.has(currentThemeName)) {
        namesToLoad.add(currentThemeName);
    }

    const fullThemesByName = new Map();
    await Promise.all(Array.from(namesToLoad).map(async (name) => {
        const filename = nameToFilename.get(name);
        if (!filename) {
            return;
        }
        fullThemesByName.set(name, await readCachedThemeFile(sectionCache, directoryPath, filename));
    }));

    return entries.map(entry => fullThemesByName.get(entry.name) || makeLazyThemeStub(entry.name));
}

async function readThemeByName(userCache, directoryPath, themeName) {
    const sectionCache = getSettingsSectionCache(userCache, 'themes');
    const { nameToFilename } = await updateCachedThemeIndexDirectory(sectionCache, directoryPath);
    let filename = nameToFilename.get(themeName);

    if (!filename) {
        const fallbackFilename = `${sanitize(themeName)}.json`;
        if (fallbackFilename && sectionCache.has(fallbackFilename)) {
            filename = fallbackFilename;
        }
    }

    if (!filename) {
        return null;
    }

    return {
        filename,
        theme: await readCachedThemeFile(sectionCache, directoryPath, filename),
    };
}

async function invalidateCachedSettingsPayloadIfThemeDirectoryChanged(userCache, directoryPath) {
    if (!userCache.payload || userCache.payloadDirty || !directoryPath) {
        return false;
    }

    const sectionCache = userCache.sections.get('themes');
    if (!sectionCache) {
        markSettingsPayloadDirty(userCache, 'theme-directory-signature-missing');
        return true;
    }

    const signature = await getJsonDirectorySignature(directoryPath);
    const currentFiles = Object.keys(signature).sort((a, b) => a.localeCompare(b));
    const cachedFiles = Array.from(sectionCache.keys()).sort((a, b) => a.localeCompare(b));
    const changed = currentFiles.length !== cachedFiles.length || currentFiles.some((filename, index) => {
        if (filename !== cachedFiles[index]) {
            return true;
        }

        const current = signature[filename];
        const cached = sectionCache.get(filename);
        return cached?.mtime !== current?.mtime || cached?.size !== current?.size;
    });

    if (changed) {
        markSettingsPayloadDirty(userCache, 'theme-directory-signature-changed');
    }

    return changed;
}

async function readWorldNames(directoryPath) {
    const worldFiles = (await fs.promises.readdir(directoryPath))
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b));

    return worldFiles.map(item => path.parse(item).name);
}

async function getJsonDirectorySignature(directoryPath, options = {}) {
    const caseInsensitiveExtension = options.caseInsensitiveExtension === true;
    const files = (await fs.promises.readdir(directoryPath))
        .filter((file) => {
            const extension = path.extname(file);
            return caseInsensitiveExtension ? extension.toLowerCase() === '.json' : extension === '.json';
        })
        .sort((a, b) => a.localeCompare(b));
    const signature = {};

    await Promise.all(files.map(async (filename) => {
        const stat = await fs.promises.stat(path.join(directoryPath, filename));
        signature[filename] = {
            mtime: stat.mtimeMs,
            size: stat.size,
        };
    }));

    return signature;
}

function sameDirectorySignature(left = {}, right = {}) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every((filename, index) => {
        const otherFilename = rightKeys[index];
        const leftFile = left[filename];
        const rightFile = right[otherFilename];

        return filename === otherFilename
            && leftFile?.mtime === rightFile?.mtime
            && leftFile?.size === rightFile?.size;
    });
}

function sameDirectoryFileNames(left = {}, right = {}) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();

    return leftKeys.length === rightKeys.length
        && leftKeys.every((filename, index) => filename === rightKeys[index]);
}

async function reconcilePersistedSectionSignature(directoryPath, persistedSection, state = {}) {
    const currentSignature = await getJsonDirectorySignature(directoryPath);
    const persistedSignature = persistedSection?.signature || {};
    const persistedFiles = persistedSection?.files || {};

    if (sameDirectorySignature(currentSignature, persistedSignature)) {
        return true;
    }

    if (!sameDirectoryFileNames(currentSignature, persistedSignature)) {
        return false;
    }

    for (const [filename, currentFile] of Object.entries(currentSignature)) {
        const persistedFile = persistedSignature[filename];
        if (persistedFile?.mtime === currentFile.mtime && persistedFile?.size === currentFile.size) {
            continue;
        }

        const persistedCacheEntry = persistedFiles[filename];
        if (!persistedCacheEntry?.contentHash) {
            return false;
        }

        const file = await fs.promises.readFile(path.join(directoryPath, filename), 'utf8');
        const contentHash = hashSettingsFileContent(file);
        if (contentHash !== persistedCacheEntry.contentHash) {
            return false;
        }

        state.reconciled = true;
        persistedSignature[filename] = currentFile;
        persistedCacheEntry.mtime = currentFile.mtime;
        persistedCacheEntry.size = currentFile.size;
        persistedCacheEntry.contentHash = contentHash;
    }

    return true;
}

async function writeFileAtomicAsync(filePath, data, options = 'utf8') {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const tempPath = `${filePath}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;

    try {
        await fs.promises.writeFile(tempPath, data, options);
        await fs.promises.rename(tempPath, filePath);
    } catch (error) {
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }

    // Opportunistically clean up orphaned temp files left behind by interrupted
    // renames. Throttled, non-blocking, and best-effort — failures are ignored.
    scheduleOrphanedCacheTmpSweep(directory);
}

function scheduleOrphanedCacheTmpSweep(directory) {
    const now = Date.now();
    const lastSweepAt = cacheTmpSweepTimestamps.get(directory) || 0;
    if (now - lastSweepAt < CACHE_TMP_SWEEP_MIN_INTERVAL_MS) {
        return;
    }
    cacheTmpSweepTimestamps.set(directory, now);

    setTimeout(() => {
        void sweepOrphanedCacheTmpFiles(directory).catch((error) => {
            console.warn('[baibaoku] Failed to sweep orphaned cache temp files:', error.message);
        });
    }, 0);
}

async function sweepOrphanedCacheTmpFiles(directory) {
    let entries;
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return;
        }
        throw error;
    }

    const now = Date.now();
    await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.tmp')) {
            return;
        }

        const tmpPath = path.join(directory, entry.name);
        try {
            const stat = await fs.promises.stat(tmpPath);
            if (now - stat.mtimeMs < CACHE_TMP_ORPHAN_MAX_AGE_MS) {
                return; // Possibly an in-flight write from a concurrent atomic save.
            }
            await fs.promises.unlink(tmpPath);
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                console.warn(`[baibaoku] Failed to remove orphaned temp file ${entry.name}:`, error.message);
            }
        }
    }));
}

function restorePersistedSectionCache(userCache, sectionName, persistedSection) {
    if (!persistedSection?.files || typeof persistedSection.files !== 'object') {
        return false;
    }

    const sectionCache = new Map();
    for (const [filename, entry] of Object.entries(persistedSection.files)) {
        sectionCache.set(filename, entry);
    }
    userCache.sections.set(sectionName, sectionCache);
    return true;
}

async function restoreSettingsPayloadFromDisk(req, userHandle, directories, options = {}) {
    const payloadOptions = getSettingsPayloadOptions(options);
    const persistPath = getSettingsPayloadPersistPath(req);
    let persisted;

    try {
        persisted = JSON.parse(await fs.promises.readFile(persistPath, 'utf8'));
    } catch {
        return false;
    }

    if (persisted?.version !== SETTINGS_PAYLOAD_PERSIST_VERSION || !persisted.payload || !persisted.sections) {
        return false;
    }

    const persistedThemeMode = normalizeSettingsThemeMode(persisted.themeMode);
    const persistedThemeCurrentName = persistedThemeMode === SETTINGS_THEME_MODE_LAZY
        ? String(persisted.themeCurrentName || '')
        : '';

    if (
        persistedThemeMode !== payloadOptions.themeMode
        || persistedThemeCurrentName !== payloadOptions.currentThemeName
    ) {
        if (payloadOptions.themeMode === SETTINGS_THEME_MODE_LAZY && persisted.sections?.themes) {
            restorePersistedSectionCache(getSettingsUserCache(userHandle), 'themes', persisted.sections.themes);
        }
        return false;
    }

    const targets = getSettingsPayloadWatchTargets(directories);
    const restoreState = { reconciled: false };

    for (const target of targets) {
        if (target.sectionName) {
            const persistedSection = persisted.sections[target.sectionName];
            if (!persistedSection || !await reconcilePersistedSectionSignature(target.directoryPath, persistedSection, restoreState)) {
                return false;
            }
            continue;
        }

        const currentSignature = await getJsonDirectorySignature(target.directoryPath, {
            caseInsensitiveExtension: true,
        });
        if (!sameDirectorySignature(currentSignature, persisted.worlds?.signature)) {
            return false;
        }
    }

    const userCache = getSettingsUserCache(userHandle);
    userCache.sections.clear();

    for (const [sectionName, persistedSection] of Object.entries(persisted.sections)) {
        restorePersistedSectionCache(userCache, sectionName, persistedSection);
    }

    userCache.payload = persisted.payload;
    userCache.payloadDirty = false;
    userCache.payloadDirtyReason = '';
    userCache.payloadDirtyAt = 0;
    userCache.payloadThemeMode = payloadOptions.themeMode;
    userCache.payloadThemeCurrentName = payloadOptions.currentThemeName;
    userCache.payloadBuiltAt = Number(persisted.payloadBuiltAt) || Date.now();
    userCache.payloadCacheKey = persisted.payloadCacheKey || computeSettingsPayloadCacheKey(userCache, persisted.payload);
    userCache.payloadPersistedBuiltAt = restoreState.reconciled ? 0 : userCache.payloadBuiltAt;
    return true;
}

function ensureSettingsPayloadPersisted(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);
    const payloadOptions = getCurrentSettingsPayloadOptions(userCache);

    if (!canUseCachedSettingsPayload(userCache, payloadOptions)) {
        return null;
    }

    if (userCache.payloadPersistedBuiltAt === userCache.payloadBuiltAt) {
        return userCache.payloadPersistPromise;
    }

    if (userCache.payloadPersistPromise) {
        return userCache.payloadPersistPromise;
    }

    userCache.payloadPersistPromise = new Promise(resolve => setTimeout(resolve, 0))
        .then(() => persistSettingsPayloadToDisk(req, userHandle))
        .catch((error) => {
            console.warn('[baibaoku] Failed to persist settings payload cache:', error.message);
            return false;
        })
        .finally(() => {
            userCache.payloadPersistPromise = null;
        });

    return userCache.payloadPersistPromise;
}

async function persistSettingsPayloadToDisk(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);
    const payloadOptions = getCurrentSettingsPayloadOptions(userCache);

    if (!canUseCachedSettingsPayload(userCache, payloadOptions)) {
        return false;
    }

    const cachedPayload = userCache.payload;
    const payloadBuiltAt = userCache.payloadBuiltAt;
    const directories = req.user.directories;
    const sections = {};

    for (const target of getSettingsPayloadWatchTargets(directories)) {
        const signature = await getJsonDirectorySignature(target.directoryPath, {
            caseInsensitiveExtension: !target.sectionName,
        });

        if (!target.sectionName) {
            sections.__worlds__ = { signature };
            continue;
        }

        const sectionCache = getSettingsSectionCache(userCache, target.sectionName);
        sections[target.sectionName] = {
            signature,
            files: Object.fromEntries(sectionCache.entries()),
        };
    }

    const persistPayload = {
        version: SETTINGS_PAYLOAD_PERSIST_VERSION,
        savedAt: Date.now(),
        payloadBuiltAt,
        themeMode: payloadOptions.themeMode,
        themeCurrentName: payloadOptions.currentThemeName,
        payloadCacheKey: userCache.payloadCacheKey || computeSettingsPayloadCacheKey(userCache, cachedPayload),
        sections: Object.fromEntries(Object.entries(sections).filter(([sectionName]) => sectionName !== '__worlds__')),
        worlds: sections.__worlds__ || { signature: {} },
        payload: cachedPayload,
    };

    if (!canUseCachedSettingsPayload(userCache, payloadOptions) || userCache.payload !== cachedPayload || userCache.payloadBuiltAt !== payloadBuiltAt) {
        return false;
    }

    await writeFileAtomicAsync(getSettingsPayloadPersistPath(req), JSON.stringify(persistPayload));
    userCache.payloadPersistedBuiltAt = payloadBuiltAt;
    return true;
}

async function getFastSettingsPayload(req, userHandle, metrics = {}, options = {}) {
    const userCache = getSettingsUserCache(userHandle);
    const directories = req.user.directories;
    const payloadOptions = getSettingsPayloadOptions(options);

    ensureSettingsPayloadWatchers(userCache, directories);

    if (payloadOptions.themeMode === SETTINGS_THEME_MODE_LAZY) {
        await invalidateCachedSettingsPayloadIfThemeDirectoryChanged(userCache, directories.themes);
    }

    if (canUseCachedSettingsPayload(userCache, payloadOptions)) {
        metrics.payloadCache = 'hit';
        metrics.payloadThemeMode = payloadOptions.themeMode;
        return userCache.payload;
    }

    if (
        !userCache.payload
        || userCache.payloadThemeMode !== payloadOptions.themeMode
        || userCache.payloadThemeCurrentName !== payloadOptions.currentThemeName
    ) {
        try {
            if (await restoreSettingsPayloadFromDisk(req, userHandle, directories, payloadOptions)) {
                metrics.payloadCache = 'persistent-hit';
                metrics.payloadThemeMode = payloadOptions.themeMode;
                return userCache.payload;
            }
        } catch (error) {
            console.warn('[baibaoku] Failed to restore settings payload cache from disk:', error.message);
        }
    }

    metrics.payloadCache = userCache.payload ? 'stale' : 'miss';
    metrics.payloadThemeMode = payloadOptions.themeMode;
    metrics.payloadDirtyReason = userCache.payloadDirtyReason || '';
    metrics.payloadDirtyAgeMs = userCache.payloadDirtyAt ? Date.now() - userCache.payloadDirtyAt : 0;

    return buildFastSettingsPayload(req, userHandle, payloadOptions);
}

async function buildFastSettingsPayload(req, userHandle, options = {}) {
    const userCache = getSettingsUserCache(userHandle);
    const directories = req.user.directories;
    const payloadOptions = getSettingsPayloadOptions(options);
    const themesPromise = payloadOptions.themeMode === SETTINGS_THEME_MODE_LAZY
        ? readLazyThemeDirectory(userCache, directories.themes, payloadOptions.currentThemeName)
        : readCachedParsedDirectory(userCache, 'themes', directories.themes);

    const [
        kobold,
        novelai,
        openai,
        textgenerationwebui,
        worldNames,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
    ] = await Promise.all([
        readCachedPresetDirectory(userCache, 'koboldai_settings', directories.koboldAI_Settings),
        readCachedPresetDirectory(userCache, 'novelai_settings', directories.novelAI_Settings),
        readCachedPresetDirectory(userCache, 'openai_settings', directories.openAI_Settings),
        readCachedPresetDirectory(userCache, 'textgenerationwebui_presets', directories.textGen_Settings),
        readWorldNames(directories.worlds),
        themesPromise,
        readCachedParsedDirectory(userCache, 'movingUIPresets', directories.movingUI),
        readCachedParsedDirectory(userCache, 'quickReplyPresets', directories.quickreplies),
        readCachedParsedDirectory(userCache, 'instruct', directories.instruct),
        readCachedParsedDirectory(userCache, 'context', directories.context),
        readCachedParsedDirectory(userCache, 'sysprompt', directories.sysprompt),
        readCachedParsedDirectory(userCache, 'reasoning', directories.reasoning),
    ]);

    const payload = {
        koboldai_settings: kobold.fileContents,
        koboldai_setting_names: kobold.fileNames,
        world_names: worldNames,
        novelai_settings: novelai.fileContents,
        novelai_setting_names: novelai.fileNames,
        openai_settings: openai.fileContents,
        openai_setting_names: openai.fileNames,
        textgenerationwebui_presets: textgenerationwebui.fileContents,
        textgenerationwebui_preset_names: textgenerationwebui.fileNames,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
    };

    userCache.payload = payload;
    userCache.payloadDirty = false;
    userCache.payloadDirtyReason = '';
    userCache.payloadDirtyAt = 0;
    userCache.payloadThemeMode = payloadOptions.themeMode;
    userCache.payloadThemeCurrentName = payloadOptions.currentThemeName;
    userCache.payloadBuiltAt = Date.now();
    userCache.payloadCacheKey = computeSettingsPayloadCacheKey(userCache, payload);
    ensureSettingsPayloadPersisted(req, userHandle);

    return payload;
}

async function getStaticSettingsPayload() {
    if (staticSettingsPayload) {
        return staticSettingsPayload;
    }

    const { getConfigValue } = await import('../../../src/util.js');
    const enableRequestCompression = !!getConfigValue('performance.requestCompression.enabled', false, 'boolean');

    staticSettingsPayload = {
        enable_extensions: !!getConfigValue('extensions.enabled', true, 'boolean'),
        enable_extensions_auto_update: !!getConfigValue('extensions.autoUpdate', true, 'boolean'),
        enable_accounts: !!getConfigValue('enableUserAccounts', false, 'boolean'),
        request_compression: {
            enabled: enableRequestCompression,
            minPayloadSize: bytes.parse(getConfigValue('performance.requestCompression.minPayloadSize', '256kb')) || 0,
            maxPayloadSize: bytes.parse(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb')) || 0,
            timeout: Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number')) || 0,
        },
    };

    return staticSettingsPayload;
}

function buildExtensionManifestBundle(req) {
    const userExtensionsDirectory = req.user?.directories?.extensions;

    if (!userExtensionsDirectory) {
        throw new Error('Current SillyTavern user extensions directory was not found.');
    }

    const builtInExtensions = readExtensionFolders(PUBLIC_DIRECTORIES.extensions)
        .filter(folder => folder !== 'third-party')
        .filter(folder => hasExtensionManifest(PUBLIC_DIRECTORIES.extensions, folder))
        .map(folder => ({ type: 'system', name: folder }));

    // 和酒馆原生 /discover 一致:没有 manifest.json 的目录(装到一半的残留)不算扩展,也不能挡住同名的全局扩展
    const userExtensions = readExtensionFolders(userExtensionsDirectory)
        .filter(folder => hasExtensionManifest(userExtensionsDirectory, folder))
        .map(folder => ({ type: 'local', name: `third-party/${folder}` }));

    const globalExtensions = readExtensionFolders(PUBLIC_DIRECTORIES.globalExtensions)
        .filter(folder => hasExtensionManifest(PUBLIC_DIRECTORIES.globalExtensions, folder))
        .map(folder => ({ type: 'global', name: `third-party/${folder}` }))
        .filter(extension => !userExtensions.some(userExtension => userExtension.name === extension.name));

    const extensions = [...builtInExtensions, ...userExtensions, ...globalExtensions];
    const manifests = {};
    const missing = {};
    const invalid = {};

    for (const extension of extensions) {
        const manifestPath = getExtensionManifestPath(req, extension);

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('Manifest is not a valid JSON object.');
            }
            manifests[extension.name] = manifest;
        } catch (error) {
            const bucket = error?.code === 'ENOENT' ? missing : invalid;
            bucket[extension.name] = {
                path: manifestPath,
                message: error?.message || String(error),
            };
        }
    }

    return {
        extensions,
        manifests,
        missing,
        invalid,
        generatedAt: Date.now(),
    };
}

function readExtensionFolders(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    return fs.readdirSync(directory)
        // 扩展管理安装时用的临时目录
        .filter(folder => !folder.startsWith('.baibaoku-'))
        .filter(folder => {
            try {
                return fs.statSync(path.join(directory, folder)).isDirectory();
            } catch {
                return false;
            }
        });
}

function hasExtensionManifest(directory, folder) {
    return fs.existsSync(path.join(directory, folder, 'manifest.json'));
}

function getExtensionManifestPath(req, extension) {
    switch (extension.type) {
        case 'system':
            return path.join(PUBLIC_DIRECTORIES.extensions, extension.name, 'manifest.json');
        case 'local':
            return path.join(req.user.directories.extensions, getThirdPartyExtensionFolder(extension.name), 'manifest.json');
        case 'global':
            return path.join(PUBLIC_DIRECTORIES.globalExtensions, getThirdPartyExtensionFolder(extension.name), 'manifest.json');
        default:
            throw new Error(`Unknown extension type: ${extension.type}`);
    }
}

function getThirdPartyExtensionFolder(name) {
    return String(name || '').replace(/^third-party[\\/]/, '');
}

async function getFastSettingsResponse(req, userHandle, settingsInfo, cachedPayload, staticPayload) {
    const key = getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload);
    const cached = settingsResponseCaches.get(userHandle);

    if (cached?.key === key && typeof cached.text === 'string') {
        return {
            cacheHit: true,
            cacheStatus: 'hit',
            encoding: 'identity',
            body: cached.text,
        };
    }

    return restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload);
}

async function restoreOrBuildFastSettingsResponseCache(req, userHandle, key, settingsInfo, cachedPayload, staticPayload) {
    const restored = await restoreFastSettingsResponseCache(req, userHandle, key);
    if (restored) {
        return {
            cacheHit: true,
            cacheStatus: 'persistent-hit',
            encoding: 'identity',
            body: restored.text,
        };
    }

    const nextCache = buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload);
    settingsResponseCaches.set(userHandle, nextCache);
    schedulePersistFastSettingsResponse(req, userHandle, nextCache);

    return {
        cacheHit: false,
        cacheStatus: 'miss',
        encoding: 'identity',
        body: nextCache.text,
    };
}

function getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload) {
    const userCache = getSettingsUserCache(userHandle);

    return [
        settingsInfo.path,
        settingsInfo.mtime,
        settingsInfo.size,
        settingsInfo.contentHash || '',
        userCache.payloadCacheKey || userCache.payloadBuiltAt,
        hashSettingsJson(staticPayload),
    ].join('\0');
}

function buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload) {
    const text = JSON.stringify({
        settings: settingsInfo.text,
        ...cachedPayload,
        ...staticPayload,
    });

    return { key, text };
}

async function restoreFastSettingsResponseCache(req, userHandle, key) {
    let meta;

    try {
        meta = JSON.parse(await fs.promises.readFile(getSettingsResponseMetaPath(req), 'utf8'));
    } catch {
        return null;
    }

    if (meta?.version !== SETTINGS_RESPONSE_PERSIST_VERSION || meta.key !== key) {
        return null;
    }

    try {
        const text = await fs.promises.readFile(getSettingsResponseBodyPath(req), 'utf8');
        const cache = { key, text };
        settingsResponseCaches.set(userHandle, cache);
        return cache;
    } catch {
        return null;
    }
}

function schedulePersistFastSettingsResponse(req, userHandle, responseCache) {
    setTimeout(() => {
        void persistFastSettingsResponseToDisk(req, userHandle, responseCache)
            .catch((error) => {
                console.warn('[baibaoku] Failed to persist settings response cache:', error.message);
            });
    }, 0);
}

async function persistFastSettingsResponseToDisk(req, userHandle, responseCache) {
    if (!responseCache?.key || typeof responseCache.text !== 'string') {
        return false;
    }

    if (settingsResponseCaches.get(userHandle)?.key !== responseCache.key) {
        return false;
    }

    await writeFileAtomicAsync(getSettingsResponseBodyPath(req), responseCache.text);
    await writeFileAtomicAsync(getSettingsResponseMetaPath(req), JSON.stringify({
        version: SETTINGS_RESPONSE_PERSIST_VERSION,
        savedAt: Date.now(),
        key: responseCache.key,
        hasBody: true,
        bodyFile: SETTINGS_RESPONSE_BODY_FILE,
    }));

    return true;
}

function sameSettingsInfo(left, right) {
    return Boolean(
        left
        && right
        && left.path === right.path
        && left.mtime === right.mtime
        && left.size === right.size
        && left.contentHash === right.contentHash
        && left.updatedAt === right.updatedAt,
    );
}

function scheduleSettingsResponseWarmup(req, userHandle, reason = 'unknown') {
    setTimeout(() => {
        void warmSettingsResponseCache(req, userHandle, reason)
            .catch((error) => {
                console.warn(`[baibaoku] Failed to warm settings response cache after ${reason}:`, error.message);
            });
    }, 0);
}

async function warmSettingsResponseCache(req, userHandle) {
    const userCache = getSettingsUserCache(userHandle);
    const payloadOptions = getCurrentSettingsPayloadOptions(userCache);

    if (payloadOptions.themeMode !== SETTINGS_THEME_MODE_FULL || !canUseCachedSettingsPayload(userCache, payloadOptions)) {
        return false;
    }

    const cachedPayload = userCache.payload;
    const payloadBuiltAt = userCache.payloadBuiltAt;
    const settingsInfo = await readSettingsTextWithCache(req, userHandle);

    if (!canUseCachedSettingsPayload(userCache, payloadOptions) || userCache.payload !== cachedPayload || userCache.payloadBuiltAt !== payloadBuiltAt) {
        return false;
    }

    const staticPayload = await getStaticSettingsPayload();
    const currentSettingsInfo = settingsFileCaches.get(userHandle);

    if (!sameSettingsInfo(settingsInfo, currentSettingsInfo)) {
        return false;
    }

    const key = getFastSettingsResponseKey(userHandle, settingsInfo, staticPayload);
    const nextCache = buildFastSettingsResponseCache(key, settingsInfo, cachedPayload, staticPayload);

    if (
        !canUseCachedSettingsPayload(userCache, payloadOptions)
        || userCache.payload !== cachedPayload
        || userCache.payloadBuiltAt !== payloadBuiltAt
        || !sameSettingsInfo(settingsInfo, settingsFileCaches.get(userHandle))
    ) {
        return false;
    }

    settingsResponseCaches.set(userHandle, nextCache);
    schedulePersistFastSettingsResponse(req, userHandle, nextCache);
    return true;
}

async function getSettingsFastConfig(req, manager) {
    const result = await manager.get(
        req,
        SETTINGS_FAST_CONFIG_DATABASE,
        SETTINGS_FAST_CONFIG_STORE,
        SETTINGS_FAST_CONFIG_KEY,
    );
    let value = result.exists && result.value && typeof result.value === 'object'
        ? result.value
        : null;

    if (!value) {
        const legacyResult = await manager.get(
            req,
            SETTINGS_FAST_CONFIG_DATABASE,
            'settings-fast-config',
            'settings',
        );
        value = legacyResult.exists && legacyResult.value && typeof legacyResult.value === 'object'
            ? legacyResult.value
            : {};
    }

    const settingsAccelerationEnabled = value.settingsAccelerationEnabled !== false;
    const lazyThemeLoadingEnabled = settingsAccelerationEnabled && value.lazyThemeLoadingEnabled !== false;

    return {
        settingsAccelerationEnabled,
        lazyThemeLoadingEnabled,
        characterListAccelerationEnabled: value.characterListAccelerationEnabled !== false,
        recentChatListAccelerationEnabled: value.recentChatListAccelerationEnabled !== false,
        progressiveChatLoadingEnabled: false,
        tokenizerBulkCountEnabled: value.tokenizerBulkCountEnabled !== false,
        extensionManifestBundleEnabled: value.extensionManifestBundleEnabled !== false,
        versionAccelerationEnabled: value.versionAccelerationEnabled !== false,
        chatKeyboardScanReductionEnabled: false,
    };
}

async function setSettingsFastConfig(req, manager) {
    const current = await getSettingsFastConfig(req, manager);
    const requestedLazyThemeLoadingEnabled = req.body?.lazyThemeLoadingEnabled === undefined
        ? current.lazyThemeLoadingEnabled !== false
        : req.body.lazyThemeLoadingEnabled !== false;
    const requestedSettingsAccelerationEnabled = req.body?.settingsAccelerationEnabled === undefined
        ? current.settingsAccelerationEnabled !== false
        : req.body.settingsAccelerationEnabled !== false;
    const settingsAccelerationEnabled = requestedLazyThemeLoadingEnabled
        ? true
        : requestedSettingsAccelerationEnabled;

    const next = {
        ...current,
        settingsAccelerationEnabled,
        lazyThemeLoadingEnabled: settingsAccelerationEnabled && requestedLazyThemeLoadingEnabled,
        characterListAccelerationEnabled: req.body?.characterListAccelerationEnabled === undefined
            ? current.characterListAccelerationEnabled !== false
            : req.body.characterListAccelerationEnabled !== false,
        recentChatListAccelerationEnabled: req.body?.recentChatListAccelerationEnabled === undefined
            ? current.recentChatListAccelerationEnabled !== false
            : req.body.recentChatListAccelerationEnabled !== false,
        progressiveChatLoadingEnabled: false,
        tokenizerBulkCountEnabled: req.body?.tokenizerBulkCountEnabled === undefined
            ? current.tokenizerBulkCountEnabled !== false
            : req.body.tokenizerBulkCountEnabled !== false,
        extensionManifestBundleEnabled: req.body?.extensionManifestBundleEnabled === undefined
            ? current.extensionManifestBundleEnabled !== false
            : req.body.extensionManifestBundleEnabled !== false,
        versionAccelerationEnabled: req.body?.versionAccelerationEnabled === undefined
            ? current.versionAccelerationEnabled !== false
            : req.body.versionAccelerationEnabled !== false,
        chatKeyboardScanReductionEnabled: false,
    };

    await manager.set(
        req,
        SETTINGS_FAST_CONFIG_DATABASE,
        SETTINGS_FAST_CONFIG_STORE,
        SETTINGS_FAST_CONFIG_KEY,
        next,
        { type: 'json' },
    );

    return next;
}

async function getSettingsFastConfigSafe(req, manager) {
    try {
        return await getSettingsFastConfig(req, manager);
    } catch (error) {
        console.warn('[baibaoku] Failed to read settings fast config; using defaults:', error.message);
        return {
            settingsAccelerationEnabled: DEFAULT_SETTINGS_ACCELERATION_ENABLED,
            lazyThemeLoadingEnabled: DEFAULT_LAZY_THEME_LOADING_ENABLED,
            characterListAccelerationEnabled: DEFAULT_CHARACTER_LIST_ACCELERATION_ENABLED,
            recentChatListAccelerationEnabled: DEFAULT_RECENT_CHAT_LIST_ACCELERATION_ENABLED,
            progressiveChatLoadingEnabled: DEFAULT_PROGRESSIVE_CHAT_LOADING_ENABLED,
            tokenizerBulkCountEnabled: DEFAULT_TOKENIZER_BULK_COUNT_ENABLED,
            extensionManifestBundleEnabled: DEFAULT_EXTENSION_MANIFEST_BUNDLE_ENABLED,
            versionAccelerationEnabled: DEFAULT_VERSION_ACCELERATION_ENABLED,
            chatKeyboardScanReductionEnabled: DEFAULT_CHAT_KEYBOARD_SCAN_REDUCTION_ENABLED,
        };
    }
}

async function getFastVersionPayload() {
    if (fastVersionCache) {
        return {
            payload: fastVersionCache.payload,
            source: 'hit',
            cacheAgeMs: Date.now() - fastVersionCache.cachedAt,
            sourceElapsedMs: fastVersionCache.sourceElapsedMs,
        };
    }

    const source = fastVersionPromise ? 'pending' : 'miss';

    if (!fastVersionPromise) {
        const startedAt = Date.now();
        fastVersionPromise = Promise.resolve()
            .then(() => getVersion())
            .then((payload) => {
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                    throw new Error('SillyTavern version payload is invalid.');
                }

                fastVersionCache = {
                    payload,
                    cachedAt: Date.now(),
                    sourceElapsedMs: Date.now() - startedAt,
                };
                return fastVersionCache;
            })
            .finally(() => {
                fastVersionPromise = null;
            });
    }

    const cache = await fastVersionPromise;
    return {
        payload: cache.payload,
        source,
        cacheAgeMs: Date.now() - cache.cachedAt,
        sourceElapsedMs: cache.sourceElapsedMs,
    };
}

function warmFastVersionCache() {
    getFastVersionPayload().catch((error) => {
        console.warn('[baibaoku] Failed to prewarm fast-version cache:', error.message);
    });
}

export const SETTINGS_CACHE_READONLY_PATHS = Object.freeze([
    '/api/worldinfo/get',
    '/api/worldinfo/list',
]);

export const SETTINGS_CACHE_INVALIDATE_PREFIXES = Object.freeze([
    '/api/worldinfo/',
    '/api/presets/',
    '/api/themes/',
    '/api/quick-replies/',
    '/api/moving-ui/',
]);

const READONLY_WORLDINFO_PATHS = new Set(SETTINGS_CACHE_READONLY_PATHS);

export function shouldInvalidateSettingsGetCachePath(pathname, method) {
    if (method !== 'POST' || typeof pathname !== 'string') {
        return false;
    }
    if (pathname === '/api/settings/save') {
        return true;
    }
    if (READONLY_WORLDINFO_PATHS.has(pathname)) {
        return false;
    }
    return SETTINGS_CACHE_INVALIDATE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export function makeEarlyBridgeScript(options = {}) {
    const apiPrefix = `/api/plugins/${PLUGIN_ID}`;
    const fastVersionPath = `${apiPrefix}/v1/fast-version`;
    const fastSettingsGetPath = `${apiPrefix}/v1/settings/fast-get`;
    const fastSettingsSavePath = `${apiPrefix}/v1/settings/fast-save`;
    const fastThemeGetPath = `${apiPrefix}/v1/themes/get`;
    const fastCharacterListPath = `${apiPrefix}/v1/characters/fast-all`;
    const fastRecentChatListPath = `${apiPrefix}/v1/chats/fast-recent`;
    const extensionManifestBundlePath = `${apiPrefix}/v1/extensions/manifest-bundle`;
    const settingsAccelerationEnabled = options.settingsAccelerationEnabled !== false;
    const lazyThemeLoadingEnabled = settingsAccelerationEnabled && options.lazyThemeLoadingEnabled !== false;
    const characterListAccelerationEnabled = options.characterListAccelerationEnabled !== false;
    const recentChatListAccelerationEnabled = options.recentChatListAccelerationEnabled !== false;
    const progressiveChatLoadingEnabled = false;
    const tokenizerBulkCountEnabled = options.tokenizerBulkCountEnabled !== false;
    const extensionManifestBundleEnabled = options.extensionManifestBundleEnabled !== false;
    const versionAccelerationEnabled = options.versionAccelerationEnabled !== false;
    const chatKeyboardScanReductionEnabled = false;
    const initialFastConfig = {
        ...options,
        settingsAccelerationEnabled,
        lazyThemeLoadingEnabled,
        characterListAccelerationEnabled,
        recentChatListAccelerationEnabled,
        progressiveChatLoadingEnabled,
        tokenizerBulkCountEnabled,
        extensionManifestBundleEnabled,
        versionAccelerationEnabled,
        chatKeyboardScanReductionEnabled,
    };

    return `/* baibaoku early bridge v${EARLY_BRIDGE_VERSION} */
(function () {
  'use strict';

  var FLAG = '__baibaokuEarlyBridge';
  var VERSION = ${JSON.stringify(String(EARLY_BRIDGE_VERSION))};
  var FAST_VERSION = ${JSON.stringify(fastVersionPath)};
  var FAST_SETTINGS_GET = ${JSON.stringify(fastSettingsGetPath)};
  var FAST_SETTINGS_SAVE = ${JSON.stringify(fastSettingsSavePath)};
  var FAST_THEME_GET = ${JSON.stringify(fastThemeGetPath)};
  var FAST_CHARACTER_LIST = ${JSON.stringify(fastCharacterListPath)};
  var FAST_RECENT_CHAT_LIST = ${JSON.stringify(fastRecentChatListPath)};
  var EXTENSION_MANIFEST_BUNDLE = ${JSON.stringify(extensionManifestBundlePath)};
  var LAZY_THEME_MARKER = ${JSON.stringify(SETTINGS_LAZY_THEME_MARKER)};
  var SETTINGS_ACCELERATION_ENABLED = ${JSON.stringify(settingsAccelerationEnabled)};
  var LAZY_THEME_LOADING_ENABLED = ${JSON.stringify(lazyThemeLoadingEnabled)};
  var CHARACTER_LIST_ACCELERATION_ENABLED = ${JSON.stringify(characterListAccelerationEnabled)};
  var RECENT_CHAT_LIST_ACCELERATION_ENABLED = ${JSON.stringify(recentChatListAccelerationEnabled)};
  var TOKENIZER_BULK_COUNT_ENABLED = ${JSON.stringify(tokenizerBulkCountEnabled)};
  var EXTENSION_MANIFEST_BUNDLE_ENABLED = ${JSON.stringify(extensionManifestBundleEnabled)};
  var VERSION_ACCELERATION_ENABLED = ${JSON.stringify(versionAccelerationEnabled)};
  var INITIAL_FAST_CONFIG = ${JSON.stringify(initialFastConfig)};
  var SETTINGS_CACHE_READONLY_PATHS = ${JSON.stringify(SETTINGS_CACHE_READONLY_PATHS)};
  var SETTINGS_CACHE_INVALIDATE_PREFIXES = ${JSON.stringify(SETTINGS_CACHE_INVALIDATE_PREFIXES)};

  if (window[FLAG] && window[FLAG].installed) {
    return;
  }

  var state = window[FLAG] = window[FLAG] || {};
  var rawFetch = window.fetch && window.fetch.bind(window);

  if (typeof rawFetch !== 'function') {
    state.installed = false;
    state.error = 'window.fetch is unavailable';
    return;
  }

  state.installed = true;
  state.version = VERSION;
  state.installedAt = Date.now();
  state.initialFastConfig = Object.assign({}, INITIAL_FAST_CONFIG);
  state.fastVersionPath = FAST_VERSION;
  state.fastGetPath = FAST_SETTINGS_GET;
  state.fastSavePath = FAST_SETTINGS_SAVE;
  state.fastThemeGetPath = FAST_THEME_GET;
  state.fastCharacterListPath = FAST_CHARACTER_LIST;
  state.fastRecentChatListPath = FAST_RECENT_CHAT_LIST;
  state.extensionManifestBundlePath = EXTENSION_MANIFEST_BUNDLE;
  state.requests = state.requests || { version: 0, get: 0, save: 0, themeGet: 0, characters: 0, recentChats: 0, extensionBundle: 0, extensionManifest: 0, extensionManifestRefresh: 0, settingsPrefetch: 0, fallback: 0, errors: 0, frontendCache: 0, invalidations: 0, saveFrontendCache: 0 };
  if (typeof state.requests.version !== 'number') state.requests.version = 0;
  if (typeof state.requests.saveFrontendCache !== 'number') state.requests.saveFrontendCache = 0;
  if (typeof state.requests.themeGet !== 'number') state.requests.themeGet = 0;
  if (typeof state.requests.recentChats !== 'number') state.requests.recentChats = 0;
  if (typeof state.requests.extensionBundle !== 'number') state.requests.extensionBundle = 0;
  if (typeof state.requests.extensionManifest !== 'number') state.requests.extensionManifest = 0;
  if (typeof state.requests.extensionManifestRefresh !== 'number') state.requests.extensionManifestRefresh = 0;
  if (typeof state.requests.settingsPrefetch !== 'number') state.requests.settingsPrefetch = 0;
  state.rawFetch = rawFetch;
  state.settingsGetCache = state.settingsGetCache || null;
  state.settingsGetPending = null;
  state.settingsGetCacheVersion = typeof state.settingsGetCacheVersion === 'number' ? state.settingsGetCacheVersion : 0;
  state.settingsSaveCache = null;
  state.settingsSavePending = null;
  state.settingsSaveSeq = Number(state.settingsSaveSeq) || 0;
  state.settingsSaveLastDispatchedSeq = Number(state.settingsSaveLastDispatchedSeq) || 0;
  state.settingsSaveLastDispatchedSettlement = null;
  state.settingsSaveDispatchQueue = null;
  state.settingsSaveClientEpoch = state.settingsSaveClientEpoch || (String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10));
  state.settingsRequestHeaders = state.settingsRequestHeaders || null;
  state.lazyThemesArray = state.lazyThemesArray || null;
  if (!state.lazyThemeFetchPending || typeof state.lazyThemeFetchPending !== 'object') {
    state.lazyThemeFetchPending = Object.create(null);
  }
  state.lazyThemeCurrentName = state.lazyThemeCurrentName || '';
  state.extensionManifestBundleCache = state.extensionManifestBundleCache || null;
  state.extensionManifestBundlePending = null;

  // SillyTavern Core (public/scripts/keyboard.js) natively owns selector joining,
  // scroll-reset WeakSet deduplication, and rAF mutation coalescing.
  // Never wrap window.MutationObserver; keep read-only compatibility stubs only.
  state.keyboardObserverCoalescingInstalled = false;
  state.chatKeyboardScanReductionEnabled = false;
  state.isChatKeyboardScanReductionEnabled = function () {
    return false;
  };
  state.setChatKeyboardScanReductionEnabled = function () {
    state.chatKeyboardScanReductionEnabled = false;
    return false;
  };

  function clearExtensionManifestBundleCache(reason) {
    state.extensionManifestBundleCache = null;
    state.extensionManifestBundlePending = null;
    state.lastExtensionManifestBundleInvalidationReason = reason || 'unknown';
    state.lastExtensionManifestBundleInvalidatedAt = Date.now();
  }

  function writeSettingsAccelerationEnabled(enabled) {
    var next = Boolean(enabled);
    state.settingsAccelerationEnabled = next;
    if (!next) {
      state.lazyThemeLoadingEnabled = false;
      clearSettingsGetCache('settings-acceleration-disabled');
    }
    return next;
  }

  state.isSettingsAccelerationEnabled = function () {
    return state.settingsAccelerationEnabled !== false;
  };
  state.setSettingsAccelerationEnabled = writeSettingsAccelerationEnabled;
  state.settingsAccelerationEnabled = SETTINGS_ACCELERATION_ENABLED;

  function writeLazyThemeLoadingEnabled(enabled) {
    var next = Boolean(enabled);
    state.lazyThemeLoadingEnabled = next;
    if (next) {
      writeSettingsAccelerationEnabled(true);
    } else {
      clearSettingsGetCache('lazy-theme-loading-disabled');
    }
    return next;
  }

  state.isLazyThemeLoadingEnabled = function () {
    return state.settingsAccelerationEnabled !== false && state.lazyThemeLoadingEnabled !== false;
  };
  state.setLazyThemeLoadingEnabled = writeLazyThemeLoadingEnabled;
  state.lazyThemeLoadingEnabled = LAZY_THEME_LOADING_ENABLED;

  function writeCharacterListAccelerationEnabled(enabled) {
    state.characterListAccelerationEnabled = Boolean(enabled);
    return state.characterListAccelerationEnabled;
  }

  state.isCharacterListAccelerationEnabled = function () {
    return state.characterListAccelerationEnabled !== false;
  };
  state.setCharacterListAccelerationEnabled = writeCharacterListAccelerationEnabled;
  state.characterListAccelerationEnabled = CHARACTER_LIST_ACCELERATION_ENABLED;

  function writeRecentChatListAccelerationEnabled(enabled) {
    state.recentChatListAccelerationEnabled = Boolean(enabled);
    return state.recentChatListAccelerationEnabled;
  }

  state.isRecentChatListAccelerationEnabled = function () {
    return state.recentChatListAccelerationEnabled !== false;
  };
  state.setRecentChatListAccelerationEnabled = writeRecentChatListAccelerationEnabled;
  state.recentChatListAccelerationEnabled = RECENT_CHAT_LIST_ACCELERATION_ENABLED;

  function writeTokenizerBulkCountEnabled(enabled) {
    state.tokenizerBulkCountEnabled = Boolean(enabled);
    return state.tokenizerBulkCountEnabled;
  }

  state.isTokenizerBulkCountEnabled = function () {
    return state.tokenizerBulkCountEnabled !== false;
  };
  state.setTokenizerBulkCountEnabled = writeTokenizerBulkCountEnabled;
  state.tokenizerBulkCountEnabled = TOKENIZER_BULK_COUNT_ENABLED;

  function writeExtensionManifestBundleEnabled(enabled) {
    state.extensionManifestBundleEnabled = Boolean(enabled);
    if (state.extensionManifestBundleEnabled === false) {
      clearExtensionManifestBundleCache('extension-manifest-bundle-disabled');
    }
    return state.extensionManifestBundleEnabled;
  }

  state.isExtensionManifestBundleEnabled = function () {
    return state.extensionManifestBundleEnabled !== false;
  };
  state.setExtensionManifestBundleEnabled = writeExtensionManifestBundleEnabled;
  state.extensionManifestBundleEnabled = EXTENSION_MANIFEST_BUNDLE_ENABLED;

  function writeVersionAccelerationEnabled(enabled) {
    state.versionAccelerationEnabled = Boolean(enabled);
    return state.versionAccelerationEnabled;
  }

  state.isVersionAccelerationEnabled = function () {
    return state.versionAccelerationEnabled !== false;
  };
  state.setVersionAccelerationEnabled = writeVersionAccelerationEnabled;
  state.versionAccelerationEnabled = VERSION_ACCELERATION_ENABLED;

  function toUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href);
      if (input instanceof URL) return new URL(input.href, location.href);
      if (input && typeof input.url === 'string') return new URL(input.url, location.href);
    } catch (_) {}
    return null;
  }

  function getMethod(input, init) {
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  function isLocalOrPrivateHost(hostname) {
    var host = normalizeHostname(hostname);

    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;

    var ipv4Parts = parseIpv4Address(host);
    if (ipv4Parts) return isLocalOrPrivateIpv4(ipv4Parts);

    return isLocalOrPrivateIpv6(host);
  }

  function normalizeHostname(hostname) {
    return String(hostname || '')
      .trim()
      .toLowerCase()
      .replace(/^\\[|\\]$/g, '')
      .replace(/\\.+$/g, '');
  }

  function parseIpv4Address(host) {
    var parts = host.split('.');

    if (parts.length !== 4) return null;

    var octets = [];
    for (var i = 0; i < parts.length; i += 1) {
      if (!/^\\d{1,3}$/.test(parts[i])) return null;

      var value = Number(parts[i]);
      if (!Number.isInteger(value) || value < 0 || value > 255) return null;

      octets.push(value);
    }

    return octets;
  }

  function isLocalOrPrivateIpv4(parts) {
    var first = parts[0];
    var second = parts[1];
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }

  function isLocalOrPrivateIpv6(host) {
    if (!host.includes(':')) return false;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

    if (host.startsWith('::ffff:')) {
      var ipv4Parts = parseIpv4Address(host.slice(7));
      return ipv4Parts ? isLocalOrPrivateIpv4(ipv4Parts) : false;
    }

    var firstGroup = host.split(':')[0];
    if (!/^[0-9a-f]{1,4}$/.test(firstGroup)) return false;

    var firstValue = parseInt(firstGroup, 16);
    return (firstValue & 0xfe00) === 0xfc00
      || (firstValue & 0xffc0) === 0xfe80;
  }

  function shouldIntercept(url, method) {
    if (!url || url.origin !== location.origin) return null;
    if (method === 'GET') {
      if (url.pathname === '/version') return { kind: 'version', fastPath: FAST_VERSION };
      if (url.pathname === '/api/extensions/discover') return { kind: 'extensionDiscover', fastPath: EXTENSION_MANIFEST_BUNDLE };
      var manifestName = getManifestRequestName(url);
      if (manifestName) return { kind: 'extensionManifest', name: manifestName };
      return null;
    }
    if (method !== 'POST') return null;
    if (url.pathname === '/api/settings/get') return { kind: 'get', fastPath: FAST_SETTINGS_GET };
    if (url.pathname === '/api/settings/save') return { kind: 'save', fastPath: FAST_SETTINGS_SAVE };
    if (url.pathname === '/api/characters/all') return { kind: 'characters', fastPath: FAST_CHARACTER_LIST };
    if (url.pathname === '/api/chats/recent') return { kind: 'recentChats', fastPath: FAST_RECENT_CHAT_LIST };
    return null;
  }

  function getManifestRequestName(url) {
    // 只认扩展根目录的 manifest.json(内置 <名字>、第三方 third-party/<名字>),扩展自己子目录里的同名文件(如 dist/manifest.json)不拦
    var match = /^\\/scripts\\/extensions\\/((?:third-party\\/)?[^/]+)\\/manifest\\.json$/i.exec(url.pathname || '');
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (_) {
      return match[1];
    }
  }

  function shouldInvalidateSettingsGetCache(url, method) {
    if (!url || url.origin !== location.origin || method !== 'POST') return false;
    if (url.pathname === '/api/settings/save') return true;
    if (SETTINGS_CACHE_READONLY_PATHS.indexOf(url.pathname) !== -1) return false;
    return SETTINGS_CACHE_INVALIDATE_PREFIXES.some(function (prefix) {
      return url.pathname.startsWith(prefix);
    });
  }

  function clearSettingsGetCache(reason) {
    if (state.settingsGetCache || state.settingsGetPending) {
      state.requests.invalidations += 1;
    }
    state.settingsGetCacheVersion += 1;
    state.settingsGetCache = null;
    state.settingsGetPending = null;
    state.lazyThemesArray = null;
    state.lastInvalidationReason = reason || 'unknown';
    state.lastInvalidatedAt = Date.now();
  }

  state.shouldInvalidateSettingsGetCache = shouldInvalidateSettingsGetCache;
  state.clearSettingsGetCache = clearSettingsGetCache;

  function clearSettingsSaveCache(reason) {
    state.settingsSaveCache = null;
    state.settingsSavePending = null;
    state.lastSaveInvalidationReason = reason || 'unknown';
    state.lastSaveInvalidatedAt = Date.now();
  }

  state.clearSettingsSaveCache = clearSettingsSaveCache;

  function makeCachedSettingsGetResponse(cache, source) {
    var headers = new Headers(cache.headers || undefined);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('x-baibaoku-frontend-cache', source || 'hit');
    headers.set('x-baibaoku-frontend-cache-age-ms', String(Date.now() - cache.savedAt));
    return decorateSettingsGetResponse(new Response(cache.text, {
      status: cache.status || 200,
      statusText: cache.statusText || 'OK',
      headers: headers,
    }), cache.text);
  }

  function rememberSettingsRequestHeaders(headers) {
    var next = {};
    try {
      new Headers(headers || undefined).forEach(function (value, key) {
        if (!/^content-length$/i.test(key) && !/^x-baibaoku-/i.test(key)) {
          next[key] = value;
        }
      });
      state.settingsRequestHeaders = next;
    } catch (_) {}
  }

  function getPluginJsonHeaders() {
    var headers = new Headers();
    try {
      var remembered = new Headers(state.settingsRequestHeaders || undefined);
      var csrf = remembered.get('x-csrf-token');
      if (csrf) {
        headers.set('x-csrf-token', csrf);
      }
    } catch (_) {}
    headers.set('content-type', 'application/json');
    return headers;
  }

  function startSettingsGetPrefetch(reason) {
    if (state.settingsAccelerationEnabled === false) return null;
    if (state.settingsGetCache || state.settingsGetPending) return state.settingsGetPending;

    var headers = getPluginJsonHeaders();
    if (!headers.get('x-csrf-token')) return null;

    if (state.lazyThemeLoadingEnabled !== false) {
      headers.set('x-baibaoku-lazy-themes', '1');
    }
    var cacheVersion = state.settingsGetCacheVersion;
    state.requests.settingsPrefetch += 1;
    state.lastSettingsGetPrefetchReason = reason || 'unknown';
    state.lastSettingsGetPrefetchStartedAt = Date.now();

    var pending = rawFetch(FAST_SETTINGS_GET, {
      method: 'POST',
      cache: 'no-store',
      headers: headers,
      body: '{}',
    }).then(function (response) {
      if (!response || !response.ok) {
        throw new Error('Settings prefetch failed: ' + (response ? response.status : 'no response'));
      }
      return cacheSettingsGetResponse(response, cacheVersion);
    }).then(function (cache) {
      if (cache) {
        state.lastSettingsGetPrefetchFinishedAt = Date.now();
      }
      return cache;
    }).catch(function (error) {
      state.requests.errors += 1;
      state.lastSettingsGetPrefetchError = error && error.message ? error.message : String(error);
      return null;
    }).finally(function () {
      if (state.settingsGetPending === pending) {
        state.settingsGetPending = null;
      }
    });

    state.settingsGetPending = pending;
    return pending;
  }

  state.prefetchSettingsGet = startSettingsGetPrefetch;

  async function handleCsrfTokenResponse(response) {
    var payload = await response.json().catch(function () { return null; });
    var token = payload && typeof payload.token === 'string' ? payload.token : '';
    if (!token) return null;

    rememberSettingsRequestHeaders({
      'content-type': 'application/json',
      'x-csrf-token': token,
    });
    return startSettingsGetPrefetch('csrf-token');
  }

  function getSettingsThemeNameFromPayload(data) {
    if (!data || typeof data.settings !== 'string') return '';
    var parsed = parseJsonOrNull(data.settings);
    return typeof (parsed && parsed.power_user && parsed.power_user.theme) === 'string'
      ? parsed.power_user.theme
      : '';
  }

  function captureSettingsGetPayload(data) {
    if (!data || typeof data !== 'object') return data;
    if (Array.isArray(data.themes)) {
      state.lazyThemesArray = data.themes;
      state.lazyThemeCurrentName = getSettingsThemeNameFromPayload(data) || state.lazyThemeCurrentName || '';
    }
    return data;
  }

  function decorateSettingsGetResponse(response, text) {
    if (!response || typeof text !== 'string') return response;
    var parsedPromise = null;
    response.json = function () {
      if (!parsedPromise) {
        parsedPromise = Promise.resolve().then(function () {
          var parsed = JSON.parse(text);
          return captureSettingsGetPayload(parsed);
        });
      }
      return parsedPromise;
    };
    return response;
  }

  function isLazyThemeObject(theme) {
    return Boolean(theme && typeof theme === 'object' && theme[LAZY_THEME_MARKER] === true);
  }

  function findThemeSlot(name) {
    var themes = Array.isArray(state.lazyThemesArray) ? state.lazyThemesArray : [];
    for (var i = 0; i < themes.length; i += 1) {
      var theme = themes[i];
      if (theme && theme.name === name) {
        return { theme: theme, index: i };
      }
    }
    return null;
  }

  function isThemeLoaded(name) {
    var slot = findThemeSlot(name);
    return Boolean(slot && !isLazyThemeObject(slot.theme));
  }

  function isThemeLazy(name) {
    var slot = findThemeSlot(name);
    return Boolean(slot && isLazyThemeObject(slot.theme));
  }

  async function ensureThemeLoaded(name) {
    name = String(name || '');
    if (!name) return null;

    var slot = findThemeSlot(name);
    if (!slot) return null;
    if (!isLazyThemeObject(slot.theme)) return slot.theme;

    if (state.lazyThemeFetchPending[name]) {
      return state.lazyThemeFetchPending[name];
    }

    state.requests.themeGet += 1;
    state.lazyThemeFetchPending[name] = rawFetch(FAST_THEME_GET, {
      method: 'POST',
      cache: 'no-store',
      headers: getPluginJsonHeaders(),
      body: JSON.stringify({ name: name }),
    }).then(async function (response) {
      if (!response || !response.ok) {
        throw new Error('Theme request failed: ' + (response ? response.status : 'no response'));
      }

      var payload = await response.json();
      var theme = payload && payload.data;
      if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
        throw new Error('Theme response payload is invalid');
      }

      if (typeof theme.name !== 'string' || !theme.name) {
        theme.name = name;
      }

      var currentSlot = findThemeSlot(name) || slot;
      Object.keys(currentSlot.theme).forEach(function (key) {
        delete currentSlot.theme[key];
      });
      Object.assign(currentSlot.theme, theme);
      delete currentSlot.theme[LAZY_THEME_MARKER];
      state.lazyThemeCurrentName = name;
      return currentSlot.theme;
    }).finally(function () {
      delete state.lazyThemeFetchPending[name];
    });

    return state.lazyThemeFetchPending[name];
  }

  state.ensureThemeLoaded = ensureThemeLoaded;
  state.isThemeLoaded = isThemeLoaded;
  state.isThemeLazy = isThemeLazy;

  function makeCachedSettingsSaveResponse(cache, source) {
    var headers = new Headers((cache && cache.headers) || undefined);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json; charset=utf-8');
    }
    headers.set('x-baibaoku-frontend-save-cache', source || 'hit');
    headers.set('x-baibaoku-frontend-save-cache-age-ms', String(Math.max(0, Date.now() - ((cache && cache.savedAt) || Date.now()))));
    var status = cache && typeof cache.status === 'number' && cache.status >= 200 && cache.status <= 599
      ? cache.status
      : 200;
    var statusText = cache && typeof cache.statusText === 'string'
      ? cache.statusText
      : (status >= 400 ? 'Error' : 'OK');
    return new Response(cache ? cache.text : '', {
      status: status,
      statusText: statusText,
      headers: headers,
    });
  }

  function makeJsonResponse(data, headers, status) {
    var responseHeaders = new Headers(headers || undefined);
    responseHeaders.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), {
      status: status || 200,
      statusText: status && status >= 400 ? 'Error' : 'OK',
      headers: responseHeaders,
    });
  }

  function makeTextResponse(text, status, headers) {
    var responseHeaders = new Headers(headers || undefined);
    responseHeaders.set('content-type', 'text/plain; charset=utf-8');
    return new Response(text || '', {
      status: status || 200,
      statusText: status && status >= 400 ? 'Error' : 'OK',
      headers: responseHeaders,
    });
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function normalizeExtensionManifestBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.extensions) || !bundle.manifests || typeof bundle.manifests !== 'object') {
      throw new Error('Extension manifest bundle payload is invalid');
    }

    bundle.missing = bundle.missing && typeof bundle.missing === 'object' ? bundle.missing : {};
    bundle.invalid = bundle.invalid && typeof bundle.invalid === 'object' ? bundle.invalid : {};
    return bundle;
  }

  async function fetchExtensionManifestBundle(force) {
    if (!force && state.extensionManifestBundleCache) {
      return state.extensionManifestBundleCache;
    }
    if (!force && state.extensionManifestBundlePending) {
      return state.extensionManifestBundlePending;
    }

    state.requests.extensionBundle += 1;
    state.extensionManifestBundlePending = rawFetch(EXTENSION_MANIFEST_BUNDLE, {
      method: 'GET',
      cache: 'no-store',
    }).then(async function (response) {
      if (!response || !response.ok) {
        throw new Error('Extension manifest bundle request failed: ' + (response ? response.status : 'no response'));
      }

      var bundle = normalizeExtensionManifestBundle(await response.json());
      state.extensionManifestBundleCache = bundle;
      state.lastExtensionManifestBundleAt = Date.now();
      return bundle;
    }).finally(function () {
      state.extensionManifestBundlePending = null;
    });

    return state.extensionManifestBundlePending;
  }

  async function makeExtensionDiscoverResponse() {
    var bundle = await fetchExtensionManifestBundle(false);
    return makeJsonResponse(bundle.extensions, {
      'x-baibaoku-extension-manifest-bundle': 'discover',
    });
  }

  async function makeExtensionManifestResponse(route) {
    var bundle = await fetchExtensionManifestBundle(false);
    var name = route && route.name;

    state.requests.extensionManifest += 1;
    if (hasOwn(bundle.manifests, name)) {
      return makeJsonResponse(bundle.manifests[name], {
        'x-baibaoku-extension-manifest-cache': 'hit',
        'x-baibaoku-extension-name': name,
      });
    }

    if (hasOwn(bundle.invalid, name)) {
      return makeTextResponse('Invalid manifest.json for ' + name, 500, {
        'x-baibaoku-extension-manifest-cache': 'invalid',
        'x-baibaoku-extension-name': name,
      });
    }

    // 缓存里没有就交还给酒馆原生静态路由,别自己造 404
    return null;
  }

  function normalizeThirdPartyExtensionName(value) {
    var name = String(value || '').replace(/\\\\/g, '/').trim();
    if (!name) return null;
    name = name.replace(/^\\/+/, '');
    if (name.indexOf('third-party/') === 0) return name;
    if (name === 'third-party') return null;
    if (name.indexOf('third-party') === 0) {
      name = name.slice('third-party'.length).replace(/^\\/+/, '');
    }
    return name ? 'third-party/' + name : null;
  }

  function encodeExtensionManifestPath(name) {
    return String(name || '')
      .split('/')
      .map(function (part) { return encodeURIComponent(part); })
      .join('/');
  }

  function addOrUpdateExtensionEntry(bundle, name, type) {
    if (!bundle || !name) return;
    var extensionType = type || 'local';
    var existing = bundle.extensions.find(function (extension) { return extension && extension.name === name; });
    if (existing) {
      existing.type = extensionType || existing.type;
      return;
    }
    bundle.extensions.push({ type: extensionType, name: name });
  }

  function removeExtensionEntry(bundle, name) {
    if (!bundle || !name) return;
    bundle.extensions = bundle.extensions.filter(function (extension) { return !extension || extension.name !== name; });
    delete bundle.manifests[name];
    delete bundle.invalid[name];
    bundle.missing[name] = {
      message: 'Extension was removed during this page session.',
      removedAt: Date.now(),
    };
  }

  async function refreshCachedExtensionManifest(name) {
    var bundle = state.extensionManifestBundleCache;
    if (!bundle || !name) return;

    state.requests.extensionManifestRefresh += 1;
    var url = '/scripts/extensions/' + encodeExtensionManifestPath(name) + '/manifest.json?baibaoku_refresh=' + Date.now();

    try {
      var response = await rawFetch(url, { method: 'GET', cache: 'no-store' });
      await updateCachedExtensionManifestFromResponse(bundle, name, response);
    } catch (error) {
      delete bundle.manifests[name];
      delete bundle.missing[name];
      bundle.invalid[name] = {
        message: error && error.message ? error.message : String(error),
        refreshedAt: Date.now(),
      };
    }
  }

  async function updateCachedExtensionManifestFromResponse(bundle, name, response) {
    delete bundle.manifests[name];
    delete bundle.missing[name];
    delete bundle.invalid[name];

    if (!response || !response.ok) {
      bundle.missing[name] = {
        status: response ? response.status : 0,
        statusText: response ? response.statusText : '',
        refreshedAt: Date.now(),
      };
      return;
    }

    try {
      var manifest = await response.json();
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Manifest is not a valid JSON object.');
      }
      bundle.manifests[name] = manifest;
    } catch (error) {
      bundle.invalid[name] = {
        message: error && error.message ? error.message : String(error),
        refreshedAt: Date.now(),
      };
    }
  }

  async function refreshExtensionManifestCacheAfterMutation(url, input, init, response) {
    if (!state.extensionManifestBundleCache || !response || !response.ok || !url || url.origin !== location.origin || getMethod(input, init) !== 'POST') {
      return;
    }

    var path = url.pathname;
    if (path !== '/api/extensions/install'
      && path !== '/api/extensions/delete'
      && path !== '/api/extensions/update'
      && path !== '/api/extensions/move'
      && path !== '/api/extensions/switch') {
      return;
    }

    var body = await readJsonBody(input, init) || {};
    var bundle = state.extensionManifestBundleCache;
    var name = normalizeThirdPartyExtensionName(body.extensionName);

    if (path === '/api/extensions/install') {
      var installPayload = await response.clone().json().catch(function () { return null; });
      name = normalizeThirdPartyExtensionName(installPayload && installPayload.folderName);
      if (name) {
        addOrUpdateExtensionEntry(bundle, name, body.global ? 'global' : 'local');
        await refreshCachedExtensionManifest(name);
      }
      return;
    }

    if (!name) return;

    if (path === '/api/extensions/delete') {
      removeExtensionEntry(bundle, name);
      return;
    }

    if (path === '/api/extensions/move') {
      addOrUpdateExtensionEntry(bundle, name, body.destination === 'global' ? 'global' : 'local');
      await refreshCachedExtensionManifest(name);
      return;
    }

    await refreshCachedExtensionManifest(name);
  }

  async function cacheSettingsGetResponse(response, cacheVersion) {
    var text = await response.clone().text();
    var headers = {};
    response.headers.forEach(function (value, key) {
      if (!/^content-encoding$/i.test(key) && !/^content-length$/i.test(key)) {
        headers[key] = value;
      }
    });
    var cache = {
      text: text,
      headers: headers,
      status: response.status,
      statusText: response.statusText,
      savedAt: Date.now(),
    };

    if (typeof cacheVersion === 'number' && cacheVersion !== state.settingsGetCacheVersion) {
      state.lastStaleSettingsGetCacheAt = Date.now();
      state.lastStaleSettingsGetCacheVersion = cacheVersion;
      state.lastStaleSettingsGetCurrentVersion = state.settingsGetCacheVersion;
      return null;
    }

    state.settingsGetCache = cache;
    return state.settingsGetCache;
  }

  async function snapshotSettingsSaveResponse(clonedResponse) {
    var text = await clonedResponse.text();
    var headers = {};
    clonedResponse.headers.forEach(function (value, key) {
      if (!/^content-encoding$/i.test(key) && !/^content-length$/i.test(key)) {
        headers[key] = value;
      }
    });
    return {
      text: text,
      headers: headers,
      status: clonedResponse.status,
      statusText: clonedResponse.statusText,
      ok: clonedResponse.ok,
      skipped: clonedResponse.headers.get('x-baibaoku-save-skipped') === 'true',
      savedAt: Date.now(),
    };
  }

  async function getReplayBody(input, init, method) {
    if (method === 'GET' || method === 'HEAD') return undefined;
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) return init.body;
    try {
      if (input instanceof Request) return await input.clone().arrayBuffer();
    } catch (_) {}
    return undefined;
  }

  function parseJsonOrNull(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function isAsyncBodySource(body) {
    return typeof Blob !== 'undefined' && body instanceof Blob;
  }

  function decodeBodyToTextSync(body) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return null;
  }

  async function bodyToText(body) {
    if (isAsyncBodySource(body)) return await body.text();
    return decodeBodyToTextSync(body);
  }

  async function gzipFastSaveInit(init, predecodedText) {
    var headers = new Headers(init.headers || undefined);
    if (isLocalOrPrivateHost(location.hostname)) return init;
    if (headers.has('content-encoding')) return init;
    if (typeof CompressionStream !== 'function') return init;

    var text = typeof predecodedText === 'string'
      ? predecodedText
      : await bodyToText(init.body);
    if (text === null || !text) return init;

    try {
      var encoded = new TextEncoder().encode(text);
      var compressed = await new Response(
        new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip'))
      ).arrayBuffer();

      if (!compressed || compressed.byteLength >= encoded.byteLength) {
        return init;
      }

      headers.set('content-encoding', 'gzip');
      headers.delete('content-length');
      state.lastFastSaveCompression = {
        encoding: 'gzip',
        originalBytes: encoded.byteLength,
        compressedBytes: compressed.byteLength,
        compressedAt: Date.now(),
      };

      return {
        ...init,
        headers: headers,
        body: compressed,
      };
    } catch (error) {
      state.lastFastSaveCompressionError = error && error.message ? error.message : String(error);
      return init;
    }
  }

  function isPlainEmptyObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  }

  async function readJsonBody(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      var body = init.body;
      if (typeof body === 'string') return parseJsonOrNull(body);
      if (body && typeof body.text === 'function') return parseJsonOrNull(await body.text());
      return null;
    }

    try {
      if (input instanceof Request && !input.bodyUsed && input.body) {
        return await input.clone().json().catch(function () { return null; });
      }
    } catch (_) {}
    return null;
  }

  async function shouldUseFastRoute(route, input, init) {
    if (!route) return false;
    if (route.kind === 'extensionDiscover' || route.kind === 'extensionManifest') {
      return state.extensionManifestBundleEnabled !== false;
    }
    if (route.kind === 'version') {
      return state.versionAccelerationEnabled !== false;
    }
    if (route.kind === 'characters') {
      if (state.characterListAccelerationEnabled === false) return false;
      return isPlainEmptyObject(await readJsonBody(input, init));
    }
    if (route.kind === 'recentChats') {
      return state.recentChatListAccelerationEnabled !== false;
    }
    return state.settingsAccelerationEnabled !== false;
  }

  function canReadReplayBodySync(input, init, method) {
    if (method === 'GET' || method === 'HEAD') return true;
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) return true;
    return !(typeof Request !== 'undefined' && input instanceof Request);
  }

  function buildFastInitBase(input, init, method, bodyValue) {
    var next = {};
    if (typeof Request !== 'undefined' && input instanceof Request) {
      next.credentials = input.credentials;
      next.cache = input.cache;
      next.redirect = input.redirect;
      next.referrer = input.referrer;
      next.referrerPolicy = input.referrerPolicy;
      next.integrity = input.integrity;
      next.keepalive = input.keepalive;
      next.mode = input.mode;
      next.signal = input.signal;
      next.headers = new Headers(input.headers);
    }
    if (init && typeof init === 'object') {
      Object.assign(next, init);
      next.headers = new Headers(init.headers || next.headers || undefined);
    }
    next.method = method;
    next.cache = 'no-store';
    next.body = bodyValue;
    if (!next.headers) next.headers = new Headers();
    if (method !== 'GET' && method !== 'HEAD' && !next.headers.has('content-type')) {
      next.headers.set('content-type', 'application/json');
    }
    return next;
  }

  async function makeFastInit(input, init, method) {
    var replayBody = await getReplayBody(input, init, method);
    return buildFastInitBase(input, init, method, replayBody);
  }

  async function callOriginal(input, init) {
    state.requests.fallback += 1;
    return rawFetch(input, init);
  }

  function isRouteUnavailableSaveStatus(status) {
    return status === 404 || status === 405 || status === 501;
  }

  function trackDispatchedSaveSettlement(fetchPromise) {
    var settlementPromise = Promise.resolve(fetchPromise).then(
      function (res) {
        return {
          ok: Boolean(res && res.ok),
          status: res ? res.status : 0,
          statusText: res ? res.statusText : '',
          error: null,
        };
      },
      function (err) {
        return {
          ok: false,
          status: 0,
          statusText: '',
          error: err || new Error('Settings save failed'),
        };
      }
    );
    state.settingsSaveLastDispatchedSettlement = settlementPromise;
    return settlementPromise;
  }

  async function runFallbackSettingsSave(input, init) {
    try {
      var fallbackResponse = await callOriginal(input, init);
      if (fallbackResponse && fallbackResponse.ok) {
        clearSettingsGetCache('save-fallback');
      } else {
        clearSettingsGetCache('save-fallback-error');
      }
      return fallbackResponse;
    } catch (fallbackError) {
      clearSettingsGetCache('save-fallback-error');
      throw fallbackError;
    }
  }

  async function handleFastSettingsSave(route, input, init, method) {
    state.requests.save += 1;
    var saveSeq = (state.settingsSaveSeq = (Number(state.settingsSaveSeq) || 0) + 1);
    var cacheVersionAtStart = state.settingsGetCacheVersion;
    var fastInit;
    var bodyText;

    try {
      if (canReadReplayBodySync(input, init, method)) {
        var syncBody = (method === 'GET' || method === 'HEAD')
          ? undefined
          : (init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : undefined);
        fastInit = buildFastInitBase(input, init, method, syncBody);
      } else {
        fastInit = await makeFastInit(input, init, method);
      }
      rememberSettingsRequestHeaders(fastInit.headers);
      if (fastInit.headers && fastInit.headers.has('content-encoding')) {
        bodyText = null;
      } else if (isAsyncBodySource(fastInit.body)) {
        bodyText = await fastInit.body.text();
      } else {
        bodyText = decodeBodyToTextSync(fastInit.body);
      }
    } catch (preError) {
      var preMessage = preError && preError.message ? preError.message : String(preError);
      state.requests.errors += 1;
      state.lastError = preMessage;
      if (state.settingsSavePending && saveSeq >= state.settingsSavePending.latestSaveSeq) {
        state.settingsSavePending = null;
        state.lastSaveInvalidationReason = 'save-pre-error';
      }
      if (state.settingsSaveSeq === saveSeq && saveSeq >= state.settingsSaveLastDispatchedSeq) {
        state.settingsSaveLastDispatchedSeq = saveSeq;
        var preFallbackPromise = runFallbackSettingsSave(input, init);
        trackDispatchedSaveSettlement(preFallbackPromise);
        return preFallbackPromise;
      }
      throw preError;
    }

    var resolveSupersededSaveResponse = async function () {
      var newerSettlementPromise = state.settingsSaveLastDispatchedSettlement;
      if (newerSettlementPromise) {
        var newerSettlement = await newerSettlementPromise;
        if (newerSettlement && newerSettlement.error) {
          clearSettingsGetCache('save-network-error');
          throw newerSettlement.error;
        }
        if (newerSettlement && !newerSettlement.ok) {
          clearSettingsGetCache('save-superseded');
          return makeJsonResponse(
            { error: true, superseded: true },
            { 'x-baibaoku-save-superseded': 'true' },
            newerSettlement.status || 500
          );
        }
      }
      if (state.settingsGetCacheVersion === cacheVersionAtStart) {
        clearSettingsGetCache('save-superseded');
      }
      return makeJsonResponse(
        { result: 'ok', skipped: true },
        {
          'x-baibaoku-save-skipped': 'true',
          'x-baibaoku-save-superseded': 'true',
        },
        200
      );
    };

    if (saveSeq < state.settingsSaveLastDispatchedSeq) {
      return resolveSupersededSaveResponse();
    }

    if (
      typeof bodyText === 'string'
      && state.settingsSavePending
      && state.settingsSavePending.bodyText === bodyText
      && state.settingsSavePending.outcomePromise
      && saveSeq > state.settingsSavePending.latestSaveSeq
      && (!state.settingsSavePending.dispatched || state.settingsSavePending.latestSaveSeq === saveSeq - 1)
    ) {
      var coalescedEntry = state.settingsSavePending;
      state.requests.frontendCache += 1;
      state.requests.saveFrontendCache += 1;
      coalescedEntry.followerCount += 1;
      coalescedEntry.latestSaveSeq = saveSeq;
      if (coalescedEntry.dispatched && saveSeq > state.settingsSaveLastDispatchedSeq) {
        state.settingsSaveLastDispatchedSeq = saveSeq;
      }
      var sharedOutcome = await coalescedEntry.outcomePromise;
      if (sharedOutcome && sharedOutcome.snapshot) {
        return makeCachedSettingsSaveResponse(sharedOutcome.snapshot, 'pending');
      }
      return sharedOutcome && sharedOutcome.response
        ? sharedOutcome.response.clone()
        : makeCachedSettingsSaveResponse(null, 'pending');
    }

    var pendingEntry = null;
    if (typeof bodyText === 'string') {
      pendingEntry = {
        bodyText: bodyText,
        latestSaveSeq: saveSeq,
        followerCount: 0,
        dispatched: false,
        outcomePromise: null,
      };
      if (
        saveSeq >= state.settingsSaveLastDispatchedSeq
        && (!state.settingsSavePending || saveSeq >= state.settingsSavePending.latestSaveSeq)
      ) {
        state.settingsSavePending = pendingEntry;
      }
    } else if (
      saveSeq >= state.settingsSaveLastDispatchedSeq
      && state.settingsSavePending
      && saveSeq >= state.settingsSavePending.latestSaveSeq
    ) {
      state.settingsSavePending = null;
    }

    var detachPendingEntry = function () {
      if (pendingEntry && state.settingsSavePending === pendingEntry) {
        state.settingsSavePending = null;
      }
    };

    var getEffectiveSeq = function () {
      return pendingEntry ? pendingEntry.latestSaveSeq : saveSeq;
    };

    var finalizeResponse = async function (response) {
      detachPendingEntry();
      if (pendingEntry && pendingEntry.followerCount > 0 && response && typeof response.clone === 'function') {
        var snapshot = await snapshotSettingsSaveResponse(response.clone());
        return { response: response, snapshot: snapshot };
      }
      return { response: response, snapshot: null };
    };

    // Enqueue onto the FIFO pre-dispatch gate synchronously before yielding for
    // async gzip compression so overlapping CompressionStream tasks never invert
    // network dispatch order; release immediately once rawFetch is invoked so
    // in-flight HTTP responses do not block subsequent dispatches.
    var prevDispatchReady = state.settingsSaveDispatchQueue || Promise.resolve();
    var releaseDispatchSlot;
    var currentDispatchSlot = new Promise(function (resolve) {
      releaseDispatchSlot = resolve;
    });
    var slotReleased = false;
    var finishDispatchSlot = function () {
      if (!slotReleased) {
        slotReleased = true;
        releaseDispatchSlot();
      }
    };
    var nextDispatchTail = prevDispatchReady.then(function () {
      return currentDispatchSlot;
    });
    state.settingsSaveDispatchQueue = nextDispatchTail;
    nextDispatchTail.then(function () {
      if (state.settingsSaveDispatchQueue === nextDispatchTail) {
        state.settingsSaveDispatchQueue = null;
      }
    });

    var executeLeaderSave = async function () {
      var preparedInit;
      try {
        var preparedPromise = gzipFastSaveInit(fastInit, bodyText);
        var readyResults = await Promise.all([preparedPromise, prevDispatchReady]);
        preparedInit = readyResults[0];
      } catch (prepError) {
        await prevDispatchReady;
        var prepMessage = prepError && prepError.message ? prepError.message : String(prepError);
        state.requests.errors += 1;
        state.lastError = prepMessage;
        var prepEffectiveSeq = getEffectiveSeq();
        if (state.settingsSaveSeq === prepEffectiveSeq && prepEffectiveSeq >= state.settingsSaveLastDispatchedSeq) {
          state.settingsSaveLastDispatchedSeq = prepEffectiveSeq;
          if (pendingEntry) pendingEntry.dispatched = true;
          var prepFallbackPromise = runFallbackSettingsSave(input, init);
          trackDispatchedSaveSettlement(prepFallbackPromise);
          finishDispatchSlot();
          return finalizeResponse(await prepFallbackPromise);
        }
        finishDispatchSlot();
        throw prepError;
      }

      var dispatchSeq = getEffectiveSeq();
      if (dispatchSeq < state.settingsSaveLastDispatchedSeq) {
        finishDispatchSlot();
        return finalizeResponse(await resolveSupersededSaveResponse());
      }

      state.settingsSaveLastDispatchedSeq = dispatchSeq;
      if (pendingEntry) pendingEntry.dispatched = true;
      var dispatchHeaders = new Headers((preparedInit && preparedInit.headers) || undefined);
      dispatchHeaders.set('x-baibaoku-save-seq', state.settingsSaveClientEpoch + ':' + String(dispatchSeq));
      var dispatchInit = Object.assign({}, preparedInit, { headers: dispatchHeaders });

      var saveResponse;
      try {
        var saveFetchPromise = rawFetch(route.fastPath, dispatchInit);
        trackDispatchedSaveSettlement(saveFetchPromise);
        finishDispatchSlot();
        saveResponse = await saveFetchPromise;
      } catch (networkError) {
        finishDispatchSlot();
        var netMessage = networkError && networkError.message ? networkError.message : String(networkError);
        state.requests.errors += 1;
        state.lastError = netMessage;
        state.lastSaveCacheError = netMessage;
        clearSettingsGetCache('save-network-error');
        throw networkError;
      } finally {
        finishDispatchSlot();
      }

      if (saveResponse && saveResponse.ok) {
        if (saveResponse.headers.get('x-baibaoku-save-superseded') === 'true') {
          if (state.settingsGetCacheVersion === cacheVersionAtStart) {
            clearSettingsGetCache('save-superseded');
          }
        } else if (saveResponse.headers.get('x-baibaoku-save-skipped') !== 'true') {
          clearSettingsGetCache('save');
        }
        return finalizeResponse(saveResponse);
      }

      var status = saveResponse ? saveResponse.status : 0;
      if (isRouteUnavailableSaveStatus(status)) {
        var postStatusSeq = getEffectiveSeq();
        if (state.settingsSaveSeq === postStatusSeq && postStatusSeq >= state.settingsSaveLastDispatchedSeq) {
          state.settingsSaveLastDispatchedSeq = postStatusSeq;
          var unmountedFallbackPromise = runFallbackSettingsSave(input, init);
          trackDispatchedSaveSettlement(unmountedFallbackPromise);
          return finalizeResponse(await unmountedFallbackPromise);
        }
        clearSettingsGetCache('save-superseded');
        return finalizeResponse(saveResponse);
      }

      clearSettingsGetCache('save-error');
      return finalizeResponse(saveResponse);
    };

    var outcomePromise = executeLeaderSave().finally(function () {
      finishDispatchSlot();
      detachPendingEntry();
    });
    if (pendingEntry) {
      pendingEntry.outcomePromise = outcomePromise;
    }

    var leaderOutcome = await outcomePromise;
    return leaderOutcome.response;
  }

  window.fetch = async function baibaokuEarlyFetch(input, init) {
    var url = toUrl(input);
    var method = getMethod(input, init);
    var route = shouldIntercept(url, method);
    var directSaveSeq = 0;

    if (route && route.kind === 'save') {
      if (state.settingsAccelerationEnabled !== false) {
        return handleFastSettingsSave(route, input, init, method);
      }
      directSaveSeq = (state.settingsSaveSeq = (Number(state.settingsSaveSeq) || 0) + 1);
      state.settingsSavePending = null;
      if (directSaveSeq > state.settingsSaveLastDispatchedSeq) {
        state.settingsSaveLastDispatchedSeq = directSaveSeq;
      }
    }

    if (!await shouldUseFastRoute(route, input, init)) {
      var originalFetchPromise = rawFetch(input, init);
      if (directSaveSeq > 0 && directSaveSeq >= state.settingsSaveLastDispatchedSeq) {
        trackDispatchedSaveSettlement(originalFetchPromise);
      }
      var originalResponse = await originalFetchPromise;
      if (originalResponse && originalResponse.ok && url && url.origin === location.origin && method === 'GET' && url.pathname === '/csrf-token') {
        void handleCsrfTokenResponse(originalResponse.clone()).catch(function (error) {
          state.requests.errors += 1;
          state.lastSettingsGetPrefetchError = error && error.message ? error.message : String(error);
        });
      }
      try {
        await refreshExtensionManifestCacheAfterMutation(url, input, init, originalResponse);
      } catch (error) {
        state.requests.errors += 1;
        state.lastExtensionManifestRefreshError = error && error.message ? error.message : String(error);
      }
      if (originalResponse && originalResponse.ok && shouldInvalidateSettingsGetCache(url, method)) {
        clearSettingsGetCache('mutation:' + url.pathname);
        state.settingsSavePending = null;
        clearSettingsSaveCache('mutation:' + url.pathname);
      }
      return originalResponse;
    }

    try {
      if (route.kind === 'extensionDiscover') {
        return await makeExtensionDiscoverResponse();
      }

      if (route.kind === 'extensionManifest') {
        return await makeExtensionManifestResponse(route) || await callOriginal(input, init);
      }

      state.requests[route.kind] += 1;

      if (route.kind === 'get') {
        if (state.settingsGetCache) {
          state.requests.frontendCache += 1;
          return makeCachedSettingsGetResponse(state.settingsGetCache, 'hit');
        }
        if (state.settingsGetPending) {
          state.requests.frontendCache += 1;
          var pendingCache = await state.settingsGetPending;
          if (pendingCache) {
            return makeCachedSettingsGetResponse(pendingCache, 'pending');
          }
        }
      }

      var fastInit = await makeFastInit(input, init, method);

      if (route.kind === 'get') {
        if (state.lazyThemeLoadingEnabled !== false) {
          fastInit.headers.set('x-baibaoku-lazy-themes', '1');
        }
        rememberSettingsRequestHeaders(fastInit.headers);
      }

      var response = await rawFetch(route.fastPath, fastInit);
      if (response && response.ok) {
        if (route.kind === 'get') {
          var settingsGetCacheVersion = state.settingsGetCacheVersion;
          state.settingsGetPending = cacheSettingsGetResponse(response, settingsGetCacheVersion)
            .catch(function (error) {
              state.requests.errors += 1;
              state.lastCacheError = error && error.message ? error.message : String(error);
              state.settingsGetCache = null;
              throw error;
            })
            .finally(function () {
              state.settingsGetPending = null;
            });
          var settingsGetCache = await state.settingsGetPending;
          if (!settingsGetCache) {
            return callOriginal(input, init);
          }
          return makeCachedSettingsGetResponse(settingsGetCache, 'miss');
        } else if (route.kind === 'characters') {
          var characterData = await response.clone().json().catch(function () { return null; });
          if (!Array.isArray(characterData)) {
            throw new Error('Fast character list returned a non-array payload');
          }
        } else if (route.kind === 'recentChats') {
          var recentChatData = await response.clone().json().catch(function () { return null; });
          if (!Array.isArray(recentChatData)) {
            throw new Error('Fast recent chat list returned a non-array payload');
          }
        }
        return response;
      }
      return callOriginal(input, init);
    } catch (error) {
      state.requests.errors += 1;
      state.lastError = error && error.message ? error.message : String(error);
      return callOriginal(input, init);
    }
  };
})();
`;
}

/**
 * Count tokens for a single message using the appropriate tokenizer.
 * Mimics the per-message behavior of ST's /api/tokenizers/openai/count
 * when called with a single-element array.
 * @param {string} model - Raw query model name
 * @param {string} resolvedModel - Resolved tokenizer model name
 * @param {object} msg - Single message object
 * @returns {Promise<number>} Token count for this message
 */
export async function countSingleMessageBulk(model, resolvedModel, msg) {
    // 1. WebTokenizer models (claude, llama3, deepseek, qwen2, command-r/a, nemo)
    const webTokenizer = getWebTokenizer(resolvedModel);
    if (webTokenizer) {
        const instance = await getTokenizerInstanceBulk(webTokenizer);
        if (instance) return countWebTokenizerTokens(instance, [msg]);
        return guesstimateBulk(JSON.stringify([msg]));
    }

    // 2. SentencePiece models (llama, mistral, yi, gemma, jamba, nerdstash)
    const sppTokenizer = getSentencepiceTokenizer(resolvedModel);
    if (sppTokenizer) {
        return await countSentencepieceArrayTokensBulk(sppTokenizer, [msg]);
    }

    // 3. Default: tiktoken models (gpt-3.5, gpt-4, gpt-4o, o1, etc.)
    const tokensPerName = model.includes('gpt-3.5-turbo-0301') ? -1 : 1;
    const tokensPerMessage = model.includes('gpt-3.5-turbo-0301') ? 4 : 3;
    const tokensPadding = 3;
    const tokenizer = getTiktokenTokenizer(resolvedModel);

    let count = 0;
    try {
        count += tokensPerMessage;
        for (const [key, value] of Object.entries(msg)) {
            count += tokenizer.encode(value).length;
            if (key === 'name') count += tokensPerName;
        }
    } catch {
        // Non-string fields (e.g. multimodal arrays or tool_calls) follow ST native behavior.
    }
    count += tokensPadding;
    if (model.includes('gpt-3.5-turbo-0301')) count += 9;
    return count;
}

async function countSentencepieceArrayTokensBulk(tokenizer, array) {
    const jsonBody = array.flatMap(x => Object.values(x)).join('\n\n');
    const result = await countSentencepieceTokensBulk(tokenizer, jsonBody);
    return result.count;
}

async function countSentencepieceTokensBulk(tokenizer, text) {
    const instance = await getTokenizerInstanceBulk(tokenizer);

    if (!instance) {
        return {
            ids: [],
            count: guesstimateBulk(text),
        };
    }

    const ids = instance.encodeIds(text);
    return {
        ids,
        count: ids.length,
    };
}

async function getTokenizerInstanceBulk(tokenizer) {
    if (!tokenizer || typeof tokenizer.get !== 'function') {
        return null;
    }

    let loadPromise = tokenizerLoadPromises.get(tokenizer);
    if (!loadPromise) {
        // ST tokenizer wrappers do not share an in-flight load, so a first-page bulk
        // count can otherwise initialize the same SentencePiece model many times.
        loadPromise = Promise.resolve()
            .then(() => tokenizer.get())
            .finally(() => tokenizerLoadPromises.delete(tokenizer));
        tokenizerLoadPromises.set(tokenizer, loadPromise);
    }

    return loadPromise;
}

function guesstimateBulk(str) {
    const byteLength = Buffer.byteLength(str, 'utf8');
    return Math.ceil(byteLength / 3.35);
}

export function closeStEndpointCaches() {
    closeSaveGenerateJobs();
    fastVersionCache = null;
    fastVersionPromise = null;

    for (const userCache of settingsUserCaches.values()) {
        for (const watcher of userCache.payloadWatchers?.values() || []) {
            watcher.close();
        }
    }

    settingsUserCaches.clear();
    settingsUpdateLocks.clear();
    settingsFileCaches.clear();
    settingsSaveLocks.clear();
    settingsClientSaveSeqs.clear();
    settingsResponseCaches.clear();
    lazyThemeToolkitDirCache.clear();
    for (const scheduler of settingsBackupSchedulers.values()) {
        if (scheduler.timer) {
            clearTimeout(scheduler.timer);
        }
    }
    settingsBackupSchedulers.clear();
    lastBackupHashes.clear();
    cacheTmpSweepTimestamps.clear();
    userCaches.clear();
    updateLocks.clear();
    fastSearchUserCaches.clear();
    fastSearchLoadLocks.clear();
    chatBackupUserCaches.clear();
    chatBackupLoadLocks.clear();
    chatBackupUpdateLocks.clear();
}

export function registerStEndpoints(router, manager) {
    registerSaveGenerateEndpoints(router);
    warmFastVersionCache();

    router.get('/v1/extensions/manifest-bundle', (req, res) => {
        try {
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.json(buildExtensionManifestBundle(req));
        } catch (error) {
            console.error('[baibaoku] Error in extension manifest bundle endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.get('/v1/fast-version', async (req, res) => {
        try {
            const result = await getFastVersionPayload();
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            setSafeHeader(res, 'X-Baibaoku-Version-Cache', result.source);
            setSafeHeader(res, 'X-Baibaoku-Version-Cache-Age-Ms', result.cacheAgeMs);
            setSafeHeader(res, 'X-Baibaoku-Version-Source-Elapsed-Ms', result.sourceElapsedMs);
            res.json(result.payload);
        } catch (error) {
            console.error('[baibaoku] Error in fast-version endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.get('/v1/early/bridge.js', async (req, res) => {
        try {
            const config = await getSettingsFastConfigSafe(req, manager);
            let effectiveConfig = config;
            if (config.lazyThemeLoadingEnabled !== false && req.user?.directories?.root) {
                const staticPayload = await getStaticSettingsPayload().catch(() => null);
                const settingsInfo = req.user?.profile?.handle
                    ? await readSettingsTextWithCache(req, req.user.profile.handle).catch(() => null)
                    : null;
                const hydratorActive = hasActiveLazyThemeHydrator(req, settingsInfo?.text || '', {
                    extensionsEnabled: staticPayload ? staticPayload.enable_extensions : true,
                });
                if (!hydratorActive) {
                    effectiveConfig = { ...config, lazyThemeLoadingEnabled: false };
                }
            }
            res.type('application/javascript; charset=utf-8');
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.send(makeEarlyBridgeScript(effectiveConfig));
        } catch (error) {
            console.error('[baibaoku] Error in early bridge endpoint:', error);
            res.status(500).type('application/javascript; charset=utf-8').send(`console.error(${JSON.stringify(error.message)});`);
        }
    });

    router.post('/v1/characters/fast-all', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            const charactersDir = req.user.directories.characters;

            // 1. Concurrency control: if this user is already updating, wait for it
            if (!updateLocks.has(userHandle)) {
                const updatePromise = updateCacheForUser(req, manager, userHandle, charactersDir)
                    .finally(() => updateLocks.delete(userHandle));
                updateLocks.set(userHandle, updatePromise);
            }

            // 2. Await the update lock (whether we created it or someone else did)
            const cache = await updateLocks.get(userHandle);

            // 3. Return the cached data as an array, removing internal fields
            const dataArray = Array.from(cache.values()).map(item => {
                const data = { ...item.data };
                delete data._chatStats; // Remove internal chat stats
                return data;
            });
            res.json(dataArray);

        } catch (error) {
            console.error('[baibaoku] Error in fast-all endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chat-backups/fast-list', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            if (!chatBackupUpdateLocks.has(userHandle)) {
                const updatePromise = getFastChatBackupList(req, manager)
                    .finally(() => chatBackupUpdateLocks.delete(userHandle));
                chatBackupUpdateLocks.set(userHandle, updatePromise);
            }

            const { data, metrics } = await chatBackupUpdateLocks.get(userHandle);
            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', metrics.totalMs);
            setSafeHeader(res, 'X-Baibaoku-Backup-Total', metrics.totalFiles);
            setSafeHeader(res, 'X-Baibaoku-Backup-Valid', metrics.validFiles);
            setSafeHeader(res, 'X-Baibaoku-Backup-Invalid', metrics.invalidFiles);
            setSafeHeader(res, 'X-Baibaoku-Cache-Hits', metrics.cacheHits);
            setSafeHeader(res, 'X-Baibaoku-Cache-Misses', metrics.cacheMisses);
            setSafeHeader(res, 'X-Baibaoku-Cache-Gc', metrics.cacheGc);
            res.json(data);
        } catch (error) {
            console.error('[baibaoku] Error in fast chat backup list endpoint:', error);
            res.status(error.status || 500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chats/fast-recent', async (req, res) => {
        try {
            const { data, metrics } = await getFastRecentChats(req);

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', metrics.totalMs);
            setSafeHeader(res, 'X-Baibaoku-Recent-Selected-Files', metrics.selectedFiles);
            setSafeHeader(res, 'X-Baibaoku-Recent-Character-Files', metrics.characterFiles);
            setSafeHeader(res, 'X-Baibaoku-Recent-Group-Files', metrics.groupFiles);
            setSafeHeader(res, 'X-Baibaoku-Recent-Root-Files', metrics.rootFiles);
            res.json(data);
        } catch (error) {
            console.error('[baibaoku] Error in fast-recent endpoint:', error);
            res.status(error.status || 500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chats/fast-search', async (req, res) => {
        try {
            const { data, metrics } = await getFastSearch(req, manager);

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', metrics.totalMs);
            setSafeHeader(res, 'X-Baibaoku-Search-Total-Files', metrics.totalFiles);
            setSafeHeader(res, 'X-Baibaoku-Search-Valid-Files', metrics.validFiles);
            setSafeHeader(res, 'X-Baibaoku-Search-Invalid-Files', metrics.invalidFiles);
            setSafeHeader(res, 'X-Baibaoku-Search-Cache-Misses', metrics.cacheMisses);
            setSafeHeader(res, 'X-Baibaoku-Search-Cache-Gc', metrics.cacheGc);
            res.json(data);
        } catch (error) {
            if (!error.status || error.status >= 500) {
                console.error('[baibaoku] Error in fast-search endpoint:', error);
            }
            res.status(error.status || 500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/chats/fast-get', async (req, res) => {
        return res.status(410).json({
            ok: false,
            error: true,
            message: 'Progressive chat loading is disabled',
        });
    });

    router.get('/v1/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await getSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await setSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.get('/v1/settings/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await getSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-config', async (req, res) => {
        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            res.json({
                ok: true,
                data: await setSettingsFastConfig(req, manager),
            });
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-config endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-save', async (req, res) => {
        const startedAt = Date.now();

        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            const result = await queueSettingsSave(userHandle, () => saveSettingsWithCache(req, userHandle));

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', Date.now() - startedAt);
            if (result.skipped) {
                setSafeHeader(res, 'X-Baibaoku-Save-Skipped', true);
            }
            if (result.superseded) {
                setSafeHeader(res, 'X-Baibaoku-Save-Superseded', true);
            }
            res.json(result);
            scheduleSettingsResponseWarmup(req, userHandle, result.skipped ? 'fast-save-skipped' : 'fast-save');

            // Trigger backup after responding; the backup task is throttled and non-blocking.
            if (!result.skipped) {
                scheduleSettingsAutoBackup(req, userHandle);
            }
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-save endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/themes/get', async (req, res) => {
        const startedAt = Date.now();

        try {
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ ok: false, error: true, message: 'Unauthorized' });
            }

            const name = String(req.body?.name || '').trim();
            if (!name) {
                return res.status(400).json({ ok: false, error: true, message: 'Theme name is required.' });
            }

            const result = await readThemeByName(
                getSettingsUserCache(userHandle),
                req.user.directories.themes,
                name,
            );

            if (!result) {
                return res.status(404).json({ ok: false, error: true, message: 'Theme not found.' });
            }

            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', Date.now() - startedAt);
            setSafeHeader(res, 'X-Baibaoku-Theme-File', result.filename);
            res.json({
                ok: true,
                data: result.theme,
            });
        } catch (error) {
            console.error('[baibaoku] Error in theme get endpoint:', error);
            res.status(500).json({ ok: false, error: true, message: error.message });
        }
    });

    router.post('/v1/settings/fast-get', async (req, res) => {
        const startedAt = Date.now();

        try {
            const metrics = {};
            const userHandle = req.user?.profile?.handle;
            if (!userHandle) {
                return res.status(401).json({ error: true, message: 'Unauthorized' });
            }

            await waitForPendingSettingsSave(userHandle);
            const requestedLazyThemes = shouldUseLazyThemeSettingsPayload(req);
            const staticStartedAt = Date.now();
            const staticPayload = await getStaticSettingsPayload();
            metrics.staticMs = Date.now() - staticStartedAt;

            const settingsStartedAt = Date.now();
            const settingsPromise = readSettingsTextWithCache(req, userHandle)
                .then((settingsInfo) => {
                    metrics.settingsMs = Date.now() - settingsStartedAt;
                    metrics.settingsCache = settingsInfo.cacheStatus || (settingsInfo.cacheHit ? 'hit' : 'miss');
                    return settingsInfo;
                });

            let payloadStartedAt = Date.now();
            let settingsInfo;
            let cachedPayload;

            if (requestedLazyThemes) {
                settingsInfo = await settingsPromise;
                const useLazyThemes = hasActiveLazyThemeHydrator(req, settingsInfo.text, {
                    extensionsEnabled: staticPayload.enable_extensions,
                });
                payloadStartedAt = Date.now();
                const payloadOptions = useLazyThemes
                    ? {
                        themeMode: SETTINGS_THEME_MODE_LAZY,
                        currentThemeName: getCurrentThemeNameFromSettingsText(settingsInfo.text),
                    }
                    : { themeMode: SETTINGS_THEME_MODE_FULL };
                const lockKey = getSettingsUpdateLockKey(userHandle, payloadOptions);
                if (!settingsUpdateLocks.has(lockKey)) {
                    const updatePromise = getFastSettingsPayload(req, userHandle, metrics, payloadOptions)
                        .finally(() => settingsUpdateLocks.delete(lockKey));
                    settingsUpdateLocks.set(lockKey, updatePromise);
                } else {
                    metrics.payloadCache = 'shared';
                    metrics.payloadThemeMode = payloadOptions.themeMode;
                }
                cachedPayload = await settingsUpdateLocks.get(lockKey);
            } else {
                const payloadOptions = { themeMode: SETTINGS_THEME_MODE_FULL };
                const lockKey = getSettingsUpdateLockKey(userHandle, payloadOptions);
                if (!settingsUpdateLocks.has(lockKey)) {
                    const updatePromise = getFastSettingsPayload(req, userHandle, metrics, payloadOptions)
                        .finally(() => settingsUpdateLocks.delete(lockKey));
                    settingsUpdateLocks.set(lockKey, updatePromise);
                } else {
                    metrics.payloadCache = 'shared';
                    metrics.payloadThemeMode = payloadOptions.themeMode;
                }

                [settingsInfo, cachedPayload] = await Promise.all([
                    settingsPromise,
                    settingsUpdateLocks.get(lockKey),
                ]);
            }
            metrics.payloadMs = Date.now() - payloadStartedAt;
            ensureSettingsPayloadPersisted(req, userHandle);

            const responseStartedAt = Date.now();
            const response = await getFastSettingsResponse(
                req,
                userHandle,
                settingsInfo,
                cachedPayload,
                staticPayload,
            );
            metrics.responseMs = Date.now() - responseStartedAt;
            metrics.responseCache = response.cacheStatus || (response.cacheHit ? 'hit' : 'miss');
            metrics.totalMs = Date.now() - startedAt;

            res.type('application/json; charset=utf-8');
            res.set('Cache-Control', 'no-cache');
            setSafeHeader(res, 'X-Baibaoku-Elapsed-Ms', metrics.totalMs);
            setSafeHeader(res, 'X-Baibaoku-Settings-Cache', metrics.settingsCache);
            setSafeHeader(res, 'X-Baibaoku-Payload-Cache', metrics.payloadCache);
            setSafeHeader(res, 'X-Baibaoku-Payload-Theme-Mode', metrics.payloadThemeMode || SETTINGS_THEME_MODE_FULL);
            if (metrics.payloadDirtyReason) {
                setSafeHeader(res, 'X-Baibaoku-Payload-Dirty-Reason', metrics.payloadDirtyReason, { maxSourceLength: 512 });
                setSafeHeader(res, 'X-Baibaoku-Payload-Dirty-Age-Ms', metrics.payloadDirtyAgeMs || 0);
            }
            setSafeHeader(res, 'X-Baibaoku-Response-Cache', metrics.responseCache);
            setSafeHeader(res, 'X-Baibaoku-Response-Encoding', response.encoding);
            res.set('Server-Timing', [
                `settings;dur=${metrics.settingsMs}`,
                `payload;dur=${metrics.payloadMs}`,
                `static;dur=${metrics.staticMs}`,
                `response;dur=${metrics.responseMs}`,
                `total;dur=${metrics.totalMs}`,
            ].join(', '));
            res.send(response.body);
        } catch (error) {
            console.error('[baibaoku] Error in settings fast-get endpoint:', error);
            res.status(500).json({ error: true, message: error.message });
        }
    });

    router.post('/v1/tokenizers/bulk-count', async (req, res) => {
        try {
            const model = String(req.body?.model || 'gpt-3.5-turbo');
            const messages = req.body?.messages;
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ ok: false, error: { message: 'messages must be a non-empty array' } });
            }

            const resolvedModel = getTokenizerModel(model);
            const counts = await Promise.all(messages.map(msg =>
                countSingleMessageBulk(model, resolvedModel, msg)));

            res.json({
                ok: true,
                data: {
                    counts,
                    token_count: counts.reduce((a, b) => a + b, 0),
                },
            });
        } catch (error) {
            console.error('[baibaoku] Error in bulk-count endpoint:', error);
            res.status(500).json({ ok: false, error: { message: error.message } });
        }
    });
}
