import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const stRootFromSymlink = path.resolve(pluginRoot, '..', '..');
const stSiblingRoot = path.resolve(pluginRoot, '..', 'SillyTavern');
const stRepoRoot = fs.existsSync(path.join(stRootFromSymlink, '.git'))
    ? stRootFromSymlink
    : (fs.existsSync(path.join(stRootFromSymlink, 'public'))
        ? path.dirname(fs.realpathSync(path.join(stRootFromSymlink, 'public')))
        : stSiblingRoot);

if (!fs.existsSync(path.join(stRootFromSymlink, 'src', 'util.js')) && fs.existsSync(path.join(stRepoRoot, 'src', 'util.js'))) {
    const pluginPrefix = pathToFileURL(`${pluginRoot}${path.sep}`).href;
    const virtualHostRoot = stRootFromSymlink;
    const loaderSource = `
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const pluginPrefix = ${JSON.stringify(pluginPrefix)};
const virtualHostRoot = ${JSON.stringify(virtualHostRoot)};
const stRepoRoot = ${JSON.stringify(stRepoRoot)};
export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && context.parentURL.startsWith(pluginPrefix)) {
        const resolved = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
        if (resolved.startsWith(virtualHostRoot + path.sep + 'src' + path.sep)
            || resolved.startsWith(virtualHostRoot + path.sep + 'public' + path.sep)) {
            const rel = path.relative(virtualHostRoot, resolved);
            return nextResolve(pathToFileURL(path.join(stRepoRoot, rel)).href, context);
        }
    }
    return nextResolve(specifier, context);
}
`;
    register(`data:text/javascript,${encodeURIComponent(loaderSource)}`);
}

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baibaoku-perf-own-')));
const gitConfigFile = path.join(tmpRoot, 'gitconfig');
fs.writeFileSync(gitConfigFile, '');
Object.assign(process.env, {
    SILLYTAVERN_GIT_BACKEND: 'system',
    SILLYTAVERN_REQUESTPROXY_ENABLED: 'false',
    SILLYTAVERN_REQUESTPROXY_URL: '',
    GIT_CONFIG_GLOBAL: gitConfigFile,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.com',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.com',
});
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete process.env[key];
}

globalThis.DATA_ROOT = path.join(tmpRoot, 'data');
const managerRoot = path.join(globalThis.DATA_ROOT, '_baibaoku', 'extension-manager');
fs.mkdirSync(managerRoot, { recursive: true });
const userExtensions = path.join(globalThis.DATA_ROOT, 'tester', 'extensions');
fs.mkdirSync(userExtensions, { recursive: true });

const configYamlFile = path.join(tmpRoot, 'config.yaml');
fs.writeFileSync(configYamlFile, '{}\n');
const { setConfigFilePath } = await import('../../../src/util.js');
setConfigFilePath(configYamlFile);

const { patchIndexHtml } = await import('../src/early-bridge-installer.js');
const { getThemeBridgeStatus, installThemeBridge, patchPowerUserJs } = await import('../src/theme-bridge-installer.js');
const { patchRegexEngineJs } = await import('../src/regex-bridge-installer.js');
const { patchOpenAIJs, unpatchOpenAIJs } = await import('../src/openai-tokenizer-bridge-installer.js');
const { patchWorldInfoJs, unpatchWorldInfoJs } = await import('../src/world-info-tokenizer-bridge-installer.js');
const { sync: writeFileAtomicSync } = await import('write-file-atomic');
const { write: writeCharacterPng } = await import('../../../src/character-card-parser.js');
const { DatabaseManager } = await import('../src/database.js');
const {
    FAST_CHARACTER_CACHE_SCHEMA,
    SETTINGS_CACHE_INVALIDATE_PREFIXES,
    SETTINGS_CACHE_READONLY_PATHS,
    closeStEndpointCaches,
    countSingleMessageBulk,
    formatShallowCharacter,
    hasActiveLazyThemeHydrator,
    makeEarlyBridgeScript,
    registerStEndpoints,
    shouldInvalidateSettingsGetCachePath,
} = await import('../src/st-endpoints.js');
const {
    DEFAULT_LOCAL_PROXY_PORTS,
    getDefaultConfig,
} = await import('../src/extension-manager/config.js');
const { setCloudMirrorListUrl } = await import('../src/extension-manager/cloud-mirrors.js');
const { ExtensionOpError } = await import('../src/extension-manager/errors.js');
const { resetJobs } = await import('../src/extension-manager/jobs.js');
const { flushOps } = await import('../src/extension-manager/oplog.js');
const { builtinRepo } = await import('../src/extension-manager/repo-builtin.js');
const { parseBranchUpstreamConfig, systemRepo } = await import('../src/extension-manager/repo-system.js');
const { resetRouteStats, saveRouteStats } = await import('../src/extension-manager/sources.js');
const service = await import('../src/extension-manager/service.js');

setCloudMirrorListUrl('');

const originalCwd = process.cwd();
process.chdir(tmpRoot);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const manifest = version => `${JSON.stringify({ display_name: 'Demo', version, author: 'tester', js: 'index.js' }, null, 4)}\n`;
const makeReq = ({ admin = true, extensionsDir = userExtensions } = {}) => ({
    user: { profile: { handle: 'tester', admin }, directories: { extensions: extensionsDir } },
    get: () => undefined,
});
const rejectsWith = (promise, code, check = () => true) => assert.rejects(promise, error => {
    assert.ok(error instanceof ExtensionOpError, `expected ExtensionOpError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return check(error) !== false;
});

function serveGitHttpBackend(request, response, projectRoot, pathname) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const env = {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(pathname ?? url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
    };
    if (request.headers['content-length']) env.CONTENT_LENGTH = request.headers['content-length'];
    if (request.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = request.headers['content-encoding'];
    if (request.headers['git-protocol']) env.HTTP_GIT_PROTOCOL = request.headers['git-protocol'];
    const child = spawn('git', ['http-backend'], { env, windowsHide: true });
    child.stdin.on('error', () => {});
    request.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let streaming = false;
    child.stdout.on('data', chunk => {
        if (streaming) {
            response.write(chunk);
            return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        let status = 200;
        for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
            const index = line.indexOf(':');
            const name = line.slice(0, index).trim();
            const value = line.slice(index + 1).trim();
            if (name.toLowerCase() === 'status') status = parseInt(value, 10);
            else response.setHeader(name, value);
        }
        response.writeHead(status);
        streaming = true;
        if (end + 4 < head.length) response.write(head.subarray(end + 4));
    });
    child.stdout.on('end', () => response.end());
    child.on('error', () => response.destroy());
}

const authRemotesRoot = path.join(tmpRoot, 'remotes-auth');
const mirrorRemotesRoot = path.join(tmpRoot, 'remotes-mirror');
fs.mkdirSync(authRemotesRoot, { recursive: true });
fs.mkdirSync(mirrorRemotesRoot, { recursive: true });

let proxyState = { enabled: true, delayMs: 0 };
const proxyServer = http.createServer((request, response) => {
    if (!proxyState.enabled) {
        request.socket.destroy();
        return;
    }
    const handle = () => {
        // Plain HTTP proxy requests pass full URL `http://github.com/owner/repo.git/...`
        let parsed;
        try {
            parsed = new URL(request.url);
        } catch {
            parsed = new URL(request.url, 'http://github.com');
        }
        serveGitHttpBackend(request, response, authRemotesRoot, parsed.pathname);
    };
    if (proxyState.delayMs > 0) {
        setTimeout(handle, proxyState.delayMs);
    } else {
        handle();
    }
});

let mirrorState = { enabled: true, delayMs: 0, root: authRemotesRoot };
const mirrorServer = http.createServer((request, response) => {
    if (!mirrorState.enabled) {
        request.socket.destroy();
        return;
    }
    const handle = () => {
        const url = new URL(request.url, 'http://127.0.0.1');
        // Strip prefix mirror path `/https://github.com` or `/http://github.com`
        const strippedPath = url.pathname.replace(/^\/+https?:\/+(?:www\.)?github\.com/i, '');
        serveGitHttpBackend(request, response, mirrorState.root, strippedPath);
    };
    if (mirrorState.delayMs > 0) {
        setTimeout(handle, mirrorState.delayMs);
    } else {
        handle();
    }
});

await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => mirrorServer.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;
const mirrorPrefix = `http://127.0.0.1:${mirrorServer.address().port}/`;

function createGithubPairRepo(owner, repoName, initialBranch = 'main') {
    const work = path.join(tmpRoot, 'work', `${owner}-${repoName}`);
    const authBare = path.join(authRemotesRoot, owner, `${repoName}.git`);
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(path.dirname(authBare), { recursive: true });
    git(work, 'init', '-q', '-b', initialBranch);
    const commit = (message, changes, branch = initialBranch, push = true) => {
        const currentBranch = git(work, 'symbolic-ref', '--short', 'HEAD');
        if (currentBranch !== branch) {
            const exists = git(work, 'branch', '--list', branch);
            if (exists) {
                git(work, 'checkout', '-q', branch);
            } else {
                git(work, 'checkout', '-q', '-b', branch);
            }
        }
        for (const [file, content] of Object.entries(changes)) {
            fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
            fs.writeFileSync(path.join(work, file), content);
        }
        git(work, 'add', '-A');
        git(work, 'commit', '-q', '-m', message);
        if (push && fs.existsSync(authBare)) {
            git(work, 'push', '-q', 'origin', `${branch}:${branch}`);
        }
        return git(work, 'rev-parse', 'HEAD');
    };
    const first = commit('initial', { 'manifest.json': manifest('1.0.0'), 'index.js': 'export default 1;\n' }, initialBranch, false);
    git(tmpRoot, 'clone', '-q', '--bare', work, authBare);
    git(work, 'remote', 'add', 'origin', authBare);
    return {
        canonicalHttpUrl: `http://github.com/${owner}/${repoName}.git`,
        authBare,
        work,
        first,
        commit,
    };
}

test.after(async () => {
    resetJobs();
    await flushOps();
    saveRouteStats();
    closeStEndpointCaches();
    proxyServer.closeAllConnections();
    mirrorServer.closeAllConnections();
    await Promise.all([
        new Promise(resolve => proxyServer.close(resolve)),
        new Promise(resolve => mirrorServer.close(resolve)),
    ]);
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('WP-K-1: all 5 bridge installers match ST release and candidate, patch idempotently, and avoid premature macro evaluation', () => {
    const bridgeTargets = [
        { file: 'public/index.html', patch: patchIndexHtml, unpatch: null },
        { file: 'public/scripts/power-user.js', patch: patchPowerUserJs, unpatch: null },
        { file: 'public/scripts/extensions/regex/engine.js', patch: patchRegexEngineJs, unpatch: null },
        { file: 'public/scripts/openai.js', patch: patchOpenAIJs, unpatch: unpatchOpenAIJs },
        { file: 'public/scripts/world-info.js', patch: patchWorldInfoJs, unpatch: unpatchWorldInfoJs },
    ];

    for (const target of bridgeTargets) {
        const candidateSource = fs.readFileSync(path.join(stRepoRoot, target.file), 'utf8');
        const releaseSource = git(stRepoRoot, 'show', `release:${target.file}`);

        for (const [label, original] of [['release', releaseSource], ['candidate', candidateSource]]) {
            const cleanOriginal = target.unpatch ? target.unpatch(original) : original;
            const patchedOnce = target.patch(cleanOriginal);
            assert.notEqual(patchedOnce, cleanOriginal, `${target.file} (${label}) should match bridge anchor`);
            const patchedTwice = target.patch(patchedOnce);
            assert.equal(patchedTwice, patchedOnce, `${target.file} (${label}) patch must be idempotent`);

            if (target.unpatch) {
                const restored = target.unpatch(patchedOnce);
                assert.equal(restored, cleanOriginal, `${target.file} (${label}) unpatch must restore exact original source`);
            }
        }
    }

    // Verify neither OpenAI nor World Info bridge blocks inject premature substituteParams() calls
    const openaiClean = unpatchOpenAIJs(fs.readFileSync(path.join(stRepoRoot, 'public/scripts/openai.js'), 'utf8'));
    const openaiPatched = patchOpenAIJs(openaiClean);
    const openaiInjected = openaiPatched.match(/\/\/ baibaoku tokenizer bridge:start[\s\S]*?\/\/ baibaoku tokenizer bridge:end/)?.[0] ?? '';
    assert.ok(openaiInjected.length > 0);
    assert.equal(openaiInjected.includes('substituteParams'), false, 'OpenAI bridge block must not pre-evaluate substituteParams');

    const wiClean = unpatchWorldInfoJs(fs.readFileSync(path.join(stRepoRoot, 'public/scripts/world-info.js'), 'utf8'));
    const wiPatched = patchWorldInfoJs(wiClean);
    const wiInjected = wiPatched.match(/\/\/ baibaoku world info tokenizer bridge:start[\s\S]*?\/\/ baibaoku world info tokenizer bridge:end/)?.[0] ?? '';
    assert.ok(wiInjected.length > 0);
    assert.equal(wiInjected.includes('substituteParams'), false, 'World Info bridge block must not pre-evaluate substituteParams');

    // Verify legacy reordered/WeakMap world-info.js bridge cleans back to exact ST source
    const legacySnippet = [
        'export async function getWorldInfoPrompt() {}',
        'async function checkWorldInfo() {',
        '        let newContent = \'\';',
        '',
        '        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);',
        '',
        '        // baibaoku world info tokenizer bridge:start',
        '        const baibaokuWorldInfoBudgetContent = new WeakMap();',
        '        // baibaoku world info tokenizer bridge:end',
        '        const textToScanTokens = await getTokenCountAsync(allActivatedText);',
        '        for (const entry of newEntries) {',
        '            entry.content = baibaokuWorldInfoBudgetContent.get(entry) ?? substituteParams(entry.content);',
        '        }',
        '}',
    ].join('\n');
    const expectedUnpatchedSnippet = [
        'export async function getWorldInfoPrompt() {}',
        'async function checkWorldInfo() {',
        '        let newContent = \'\';',
        '        const textToScanTokens = await getTokenCountAsync(allActivatedText);',
        '',
        '        filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);',
        '        for (const entry of newEntries) {',
        '            entry.content = substituteParams(entry.content);',
        '        }',
        '}',
    ].join('\n');
    assert.equal(unpatchWorldInfoJs(legacySnippet), expectedUnpatchedSnippet);

    // FX2-2: Verify migration from prior <USER|CHAR|BOT> bridge block leaves a single updated block and unpatches byte-exact
    for (const [label, original] of [
        ['release', git(stRepoRoot, 'show', 'release:public/scripts/world-info.js')],
        ['candidate', fs.readFileSync(path.join(stRepoRoot, 'public/scripts/world-info.js'), 'utf8')],
    ]) {
        const cleanOriginal = unpatchWorldInfoJs(original);
        const freshPatched = patchWorldInfoJs(cleanOriginal);
        const priorBlockPatched = freshPatched.replace(
            '/<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>/i',
            '/<(?:USER|CHAR|BOT)>/i',
        );
        assert.notEqual(priorBlockPatched, freshPatched);
        const migrated = patchWorldInfoJs(priorBlockPatched);
        assert.equal(migrated, freshPatched, `migrating prior bridge block (${label}) must match fresh patch`);
        assert.equal(
            migrated.match(/\/\/ baibaoku world info tokenizer bridge:start/g)?.length,
            1,
            `migrating prior bridge block (${label}) must leave a single bridge block`,
        );
        assert.equal(unpatchWorldInfoJs(migrated), cleanOriginal, `unpatch after migration (${label}) must be byte-exact`);
    }

    // Simulate stateful macro evaluation across bridge + ST native loop: macro runs exactly once
    let macroEvalCount = 0;
    const substituteParams = text => text.replace(/\{\{roll\}\}/g, () => String(++macroEvalCount));
    let bridgePayload = null;
    const sandbox = {
        globalThis: {
            __baibaokuTokenizerBulkBridge: {
                isEnabled: () => true,
                prepareWorldInfoBudgetCounts: payload => {
                    bridgePayload = payload;
                },
            },
        },
        newEntries: [
            { content: 'Roll value: {{roll}}', ignoreBudget: false, useProbability: false, probability: 100 },
            { content: 'Plain lore text without macros', ignoreBudget: false, useProbability: true, probability: 50 },
            { content: 'Group lore for <GROUP> members', ignoreBudget: false, useProbability: false, probability: 100 },
            { content: 'Fallback <charifnotgroup> tag', ignoreBudget: false, useProbability: false, probability: 100 },
        ],
        timedEffects: { isEffectActive: () => false },
        Promise,
        console,
    };
    vm.runInNewContext(`(async () => {\n${wiInjected}\n})()`, sandbox);
    assert.equal(macroEvalCount, 0, 'bridge preparation must not evaluate stateful macros');
    assert.ok(bridgePayload);
    assert.equal(bridgePayload.entries[0].hasMacros, true);
    assert.equal(bridgePayload.entries[0].maySkip, false);
    assert.equal(bridgePayload.entries[1].hasMacros, false);
    assert.equal(bridgePayload.entries[1].maySkip, true);
    assert.equal(bridgePayload.entries[2].hasMacros, true, '<GROUP> legacy macro must set hasMacros=true');
    assert.equal(bridgePayload.entries[3].hasMacros, true, '<CHARIFNOTGROUP> legacy macro must set hasMacros=true');

    // ST native loop then evaluates the kept entry's macro once
    const finalText = substituteParams(sandbox.newEntries[0].content);
    assert.equal(finalText, 'Roll value: 1');
    assert.equal(macroEvalCount, 1);
});

test('WP-K-1: countSingleMessageBulk matches ST native tiktoken behavior on plain, named, multimodal, and tool_calls messages', async () => {
    const plainCount = await countSingleMessageBulk('gpt-4o', 'gpt-4o', {
        role: 'user',
        content: 'Hello world!',
    });
    assert.ok(Number.isInteger(plainCount) && plainCount > 6);

    const namedGpt4 = await countSingleMessageBulk('gpt-4o', 'gpt-4o', {
        role: 'user',
        name: 'Alice',
        content: 'Hello world!',
    });
    assert.ok(namedGpt4 > plainCount);

    const legacy0301 = await countSingleMessageBulk('gpt-3.5-turbo-0301', 'gpt-3.5-turbo', {
        role: 'user',
        name: 'Alice',
        content: 'Hello world!',
    });
    assert.ok(Number.isInteger(legacy0301) && legacy0301 > namedGpt4);

    // Multimodal content array: ST native tiktoken catches TypeError on non-string encode() rather than coercing to "[object Object]"
    const multimodalMsg = {
        role: 'user',
        content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
    };
    const coercedRoleOnlyCount = await countSingleMessageBulk('gpt-4o', 'gpt-4o', {
        role: 'user',
    });
    const multimodalCount = await countSingleMessageBulk('gpt-4o', 'gpt-4o', multimodalMsg);
    const wronglyStringifiedCount = await countSingleMessageBulk('gpt-4o', 'gpt-4o', {
        role: 'user',
        content: String(multimodalMsg.content),
    });
    assert.equal(multimodalCount, coercedRoleOnlyCount, 'multimodal array must match ST native catch semantics');
    assert.notEqual(multimodalCount, wronglyStringifiedCount, 'must not count "[object Object]" tokens');

    // Assistant tool_calls message: content is null, tool_calls is an array
    const toolCallCount = await countSingleMessageBulk('gpt-4o', 'gpt-4o', {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    });
    const assistantRoleOnlyCount = await countSingleMessageBulk('gpt-4o', 'gpt-4o', {
        role: 'assistant',
    });
    assert.equal(toolCallCount, assistantRoleOnlyCount);
});

test('WP-K-2: read-only World Info routes do not invalidate settingsGetCache while mutating routes do', async () => {
    assert.equal(shouldInvalidateSettingsGetCachePath('/api/worldinfo/get', 'POST'), false);
    assert.equal(shouldInvalidateSettingsGetCachePath('/api/worldinfo/list', 'POST'), false);
    assert.equal(shouldInvalidateSettingsGetCachePath('/api/worldinfo/edit', 'POST'), true);
    assert.equal(shouldInvalidateSettingsGetCachePath('/api/worldinfo/delete', 'POST'), true);
    assert.equal(shouldInvalidateSettingsGetCachePath('/api/worldinfo/import', 'POST'), true);
    assert.equal(shouldInvalidateSettingsGetCachePath('/api/settings/save', 'POST'), true);
    assert.equal(shouldInvalidateSettingsGetCachePath('/api/worldinfo/edit', 'GET'), false);

    // Execute Early Bridge script in a browser-like VM and verify live fetch cache behavior
    let fastSettingsHits = 0;
    const windowObj = {
        location: { origin: 'http://127.0.0.1:8000', href: 'http://127.0.0.1:8000/', hostname: '127.0.0.1' },
        Response,
        Headers,
        Request,
        Blob,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        Promise,
        setTimeout,
        clearTimeout,
        document: {
            readyState: 'complete',
            addEventListener: () => {},
            documentElement: null,
        },
        fetch: async (input) => {
            const url = typeof input === 'string' ? input : input.url;
            const pathname = new URL(url, 'http://127.0.0.1:8000').pathname;
            if (pathname === '/api/plugins/baibaoku/v1/settings/fast-get') {
                fastSettingsHits += 1;
                return new Response(JSON.stringify({ settings: JSON.stringify({ theme: 'Default' }), themes: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    };
    windowObj.window = windowObj;
    windowObj.globalThis = windowObj;

    const script = makeEarlyBridgeScript({
        settingsAccelerationEnabled: true,
        lazyThemeLoadingEnabled: false,
        characterListAccelerationEnabled: false,
        recentChatListAccelerationEnabled: false,
        tokenizerBulkCountEnabled: false,
        extensionManifestBundleEnabled: false,
        versionAccelerationEnabled: false,
        chatKeyboardScanReductionEnabled: false,
    });
    vm.runInNewContext(script, windowObj);
    assert.equal(windowObj.__baibaokuEarlyBridge?.installed, true);
    assert.equal(script.includes(JSON.stringify(SETTINGS_CACHE_READONLY_PATHS)), true, 'script must inject SETTINGS_CACHE_READONLY_PATHS JSON');
    assert.equal(script.includes(JSON.stringify(SETTINGS_CACHE_INVALIDATE_PREFIXES)), true, 'script must inject SETTINGS_CACHE_INVALIDATE_PREFIXES JSON');

    const checkPaths = [
        '/api/settings/save',
        '/api/worldinfo/get',
        '/api/worldinfo/list',
        '/api/worldinfo/edit',
        '/api/worldinfo/delete',
        '/api/presets/save',
        '/api/themes/save',
        '/api/quick-replies/save',
        '/api/moving-ui/save',
        '/api/chats/get',
    ];
    for (const checkPath of checkPaths) {
        for (const method of ['POST', 'GET']) {
            const clientResult = windowObj.__baibaokuEarlyBridge.shouldInvalidateSettingsGetCache(
                new windowObj.URL(checkPath, 'http://127.0.0.1:8000'),
                method,
            );
            const serverResult = shouldInvalidateSettingsGetCachePath(checkPath, method);
            assert.equal(clientResult, serverResult, `mismatch for ${method} ${checkPath}`);
        }
    }

    await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' });
    assert.equal(fastSettingsHits, 1);

    // Second settings/get hits in-memory cache
    await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' });
    assert.equal(fastSettingsHits, 1);

    // Switching/listing World Info books MUST NOT clear settingsGetCache
    await windowObj.fetch('/api/worldinfo/get', { method: 'POST', body: '{"name":"BookA"}' });
    await windowObj.fetch('/api/worldinfo/list', { method: 'POST', body: '{}' });
    await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' });
    assert.equal(fastSettingsHits, 1, 'read-only worldinfo endpoints must keep settingsGetCache intact');

    // Editing a World Info book MUST invalidate settingsGetCache
    await windowObj.fetch('/api/worldinfo/edit', { method: 'POST', body: '{"name":"BookA"}' });
    await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' });
    assert.equal(fastSettingsHits, 2, 'worldinfo/edit must invalidate settingsGetCache');
});

test('WP-K-3: security defaults, mirror-only rejection, Option A same-name branch inference, personal/* protection, and mihomo proxy + mirror behavior', async () => {
    // 0. Verify default config values
    const defaults = getDefaultConfig();
    assert.equal(defaults.allowUnverifiedMirrorDecision, false);
    assert.equal(defaults.cloudMirrorsEnabled, false);
    assert.equal(defaults.autoDetectProxy, true);
    assert.deepEqual([...DEFAULT_LOCAL_PROXY_PORTS], [7890, 7897, 10809, 1080]);

    const adminReq = makeReq({ admin: true });

    // 1. Scenario A: Mirror-only reachable (authoritative direct & proxy unreachable)
    const repoA = createGithubPairRepo('owner', 'mirror-only-ext', 'main');
    proxyState = { enabled: false, delayMs: 0 };
    mirrorState = { enabled: true, delayMs: 0, root: authRemotesRoot };
    resetRouteStats();
    await service.updateManagerConfig(adminReq, {
        autoDetectProxy: false,
        proxy: proxyUrl,
        prefixMirrors: [mirrorPrefix],
        domainMirrors: [],
        allowUnverifiedMirrorDecision: false,
        cloudMirrorsEnabled: false,
        probeTimeoutMs: 2500,
    });

    await rejectsWith(
        service.installExtension(adminReq, { url: repoA.canonicalHttpUrl, global: false }),
        'UNVERIFIED_MIRROR',
        err => err.message.includes('仅镜像可达'),
    );

    // Clone locally onto userExtensions, push an update to remote, then test updateExtension under mirror-only
    const extADir = path.join(userExtensions, 'mirror-only-ext');
    git(tmpRoot, 'clone', '-q', repoA.authBare, extADir);
    git(extADir, 'remote', 'set-url', 'origin', repoA.canonicalHttpUrl);
    const headBeforeA = git(extADir, 'rev-parse', 'HEAD');
    const secondShaA = repoA.commit('v1.1.0', { 'manifest.json': manifest('1.1.0') }, 'main');

    await rejectsWith(
        service.updateExtension(adminReq, { extensionName: 'mirror-only-ext', global: false }),
        'UNVERIFIED_MIRROR',
        err => err.message.includes('仅镜像可达'),
    );
    assert.equal(git(extADir, 'rev-parse', 'HEAD'), headBeforeA, 'mirror-only rejection must not advance HEAD');

    // Explicit opt-in (`allowUnverifiedMirrorDecision: true`) allows mirror-only update
    await service.updateManagerConfig(adminReq, { allowUnverifiedMirrorDecision: true });
    const allowedMirrorUpdate = await service.updateExtension(adminReq, { extensionName: 'mirror-only-ext', global: false });
    assert.equal(allowedMirrorUpdate.response.shortCommitHash, secondShaA.slice(0, 7));
    assert.equal(git(extADir, 'rev-parse', 'HEAD'), secondShaA);

    // Restore strict security default for remaining scenarios
    await service.updateManagerConfig(adminReq, { allowUnverifiedMirrorDecision: false });

    // 2. Scenario B: Missing remote branch on `personal/stable` (never auto-switches to `main`, even with force=true)
    proxyState = { enabled: true, delayMs: 0 };
    resetRouteStats();
    const repoB = createGithubPairRepo('owner', 'personal-ext', 'main');
    const stableShaB = repoB.commit('personal stable', { 'manifest.json': manifest('1.0.1-personal') }, 'personal/stable');
    const extBDir = path.join(userExtensions, 'personal-ext');
    git(tmpRoot, 'clone', '-q', '-b', 'personal/stable', repoB.authBare, extBDir);
    git(extBDir, 'remote', 'set-url', 'origin', repoB.canonicalHttpUrl);

    // Mismatched upstream on `personal/stable` -> BRANCH_PROTECTED with relative path in hint (K4)
    git(extBDir, 'config', 'branch.personal/stable.merge', 'refs/heads/main');
    const verBMismatched = await service.checkExtensionVersion(adminReq, { extensionName: 'personal-ext', global: false });
    assert.equal(verBMismatched.baibaoku?.code, 'BRANCH_PROTECTED');
    await rejectsWith(
        service.updateExtension(adminReq, { extensionName: 'personal-ext', global: false }),
        'BRANCH_PROTECTED',
        err => err.hint.includes('extensions/personal-ext') && !err.hint.includes(tmpRoot),
    );
    git(extBDir, 'config', 'branch.personal/stable.merge', 'refs/heads/personal/stable');

    // Delete `personal/stable` on authoritative remote, leaving `main` intact
    git(repoB.authBare, 'branch', '-D', 'personal/stable');

    await rejectsWith(
        service.updateExtension(adminReq, { extensionName: 'personal-ext', global: false, force: false }),
        'BRANCH_PROTECTED',
    );
    await rejectsWith(
        service.updateExtension(adminReq, { extensionName: 'personal-ext', global: false, force: true }),
        'BRANCH_PROTECTED',
    );
    assert.equal(git(extBDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'personal/stable');
    assert.equal(git(extBDir, 'rev-parse', 'HEAD'), stableShaB);

    // 3. Scenario C (K2 Option A + K4 relative hints):
    // C1: Non-personal branch missing `branch.<b>.merge` + authoritative remote HAS same-name branch -> updates & writes upstream config (both system & builtin)
    const repoC1 = createGithubPairRepo('owner', 'inferred-same-branch-ext', 'main');
    const extC1SysDir = path.join(userExtensions, 'inferred-same-branch-sys');
    git(tmpRoot, 'clone', '-q', repoC1.authBare, extC1SysDir);
    git(extC1SysDir, 'remote', 'set-url', 'origin', repoC1.canonicalHttpUrl);
    git(extC1SysDir, 'branch', '--unset-upstream');
    const c1SecondSha = repoC1.commit('v1.2.0', { 'manifest.json': manifest('1.2.0') }, 'main');

    const verC1Before = await service.checkExtensionVersion(adminReq, { extensionName: 'inferred-same-branch-sys', global: false });
    assert.equal(verC1Before.isUpToDate, false);
    assert.equal(Boolean(verC1Before.baibaoku?.remoteCheckFailed), false);

    const updatedC1Sys = await service.updateExtension(adminReq, { extensionName: 'inferred-same-branch-sys', global: false });
    assert.equal(updatedC1Sys.response.shortCommitHash, c1SecondSha.slice(0, 7));
    assert.equal(git(extC1SysDir, 'rev-parse', 'HEAD'), c1SecondSha);
    assert.equal(git(extC1SysDir, 'config', '--get', 'branch.main.remote'), 'origin');
    assert.equal(git(extC1SysDir, 'config', '--get', 'branch.main.merge'), 'refs/heads/main');

    // Builtin backend parity for C1
    const extC1BuiltinDir = path.join(userExtensions, 'inferred-same-branch-builtin');
    git(tmpRoot, 'clone', '-q', repoC1.authBare, extC1BuiltinDir);
    git(extC1BuiltinDir, 'reset', '-q', '--hard', repoC1.first);
    git(extC1BuiltinDir, 'remote', 'set-url', 'origin', repoC1.canonicalHttpUrl);
    git(extC1BuiltinDir, 'branch', '--unset-upstream');
    process.env.SILLYTAVERN_GIT_BACKEND = 'builtin';
    try {
        const verC1Builtin = await service.checkExtensionVersion(adminReq, { extensionName: 'inferred-same-branch-builtin', global: false });
        assert.equal(verC1Builtin.isUpToDate, false);
        const updatedC1Builtin = await service.updateExtension(adminReq, { extensionName: 'inferred-same-branch-builtin', global: false });
        assert.equal(updatedC1Builtin.response.shortCommitHash, c1SecondSha.slice(0, 7));
        assert.equal(git(extC1BuiltinDir, 'rev-parse', 'HEAD'), c1SecondSha);
        assert.equal(git(extC1BuiltinDir, 'config', '--get', 'branch.main.remote'), 'origin');
        assert.equal(git(extC1BuiltinDir, 'config', '--get', 'branch.main.merge'), 'refs/heads/main');
    } finally {
        process.env.SILLYTAVERN_GIT_BACKEND = 'system';
    }

    // C2: Non-personal branch missing `branch.<b>.merge` + remote does NOT have same-name branch -> NO_UPSTREAM (never switches to default branch, even with force=true)
    const repoC2 = createGithubPairRepo('owner', 'inferred-missing-remote-ext', 'main');
    const legacyShaC2 = repoC2.commit('legacy v1.0.1', { 'manifest.json': manifest('1.0.1') }, 'legacy-branch');
    const extC2Dir = path.join(userExtensions, 'inferred-missing-remote-ext');
    git(tmpRoot, 'clone', '-q', '-b', 'legacy-branch', repoC2.authBare, extC2Dir);
    git(extC2Dir, 'remote', 'set-url', 'origin', repoC2.canonicalHttpUrl);
    git(extC2Dir, 'branch', '--unset-upstream');
    git(repoC2.authBare, 'branch', '-D', 'legacy-branch');
    repoC2.commit('main v2.0.0', { 'manifest.json': manifest('2.0.0') }, 'main');

    const verC2 = await service.checkExtensionVersion(adminReq, { extensionName: 'inferred-missing-remote-ext', global: false });
    assert.equal(verC2.isUpToDate, true);
    assert.equal(verC2.baibaoku?.remoteCheckFailed, true);
    assert.equal(verC2.baibaoku?.code, 'NO_UPSTREAM');

    await rejectsWith(
        service.updateExtension(adminReq, { extensionName: 'inferred-missing-remote-ext', global: false, force: false }),
        'NO_UPSTREAM',
        err => err.hint.includes('extensions/inferred-missing-remote-ext') && !err.hint.includes(tmpRoot),
    );
    await rejectsWith(
        service.updateExtension(adminReq, { extensionName: 'inferred-missing-remote-ext', global: false, force: true }),
        'NO_UPSTREAM',
        err => err.hint.includes('extensions/inferred-missing-remote-ext') && !err.hint.includes(tmpRoot),
    );
    assert.equal(git(extC2Dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'legacy-branch');
    assert.equal(git(extC2Dir, 'rev-parse', 'HEAD'), legacyShaC2);

    // C3: `personal/*` missing upstream -> NO_UPSTREAM (even when remote `personal/stable` exists), global hint uses relative third-party path
    const repoC3 = createGithubPairRepo('owner', 'personal-no-upstream-ext', 'main');
    repoC3.commit('personal v1.1.0', { 'manifest.json': manifest('1.1.0') }, 'personal/stable');
    const globalExtensionsDir = path.join(tmpRoot, 'public', 'scripts', 'extensions', 'third-party');
    fs.mkdirSync(globalExtensionsDir, { recursive: true });
    const extC3GlobalDir = path.join(globalExtensionsDir, 'personal-no-upstream-ext');
    git(tmpRoot, 'clone', '-q', '-b', 'personal/stable', repoC3.authBare, extC3GlobalDir);
    git(extC3GlobalDir, 'remote', 'set-url', 'origin', repoC3.canonicalHttpUrl);
    git(extC3GlobalDir, 'branch', '--unset-upstream');

    const verC3 = await service.checkExtensionVersion(adminReq, { extensionName: 'personal-no-upstream-ext', global: true });
    assert.equal(verC3.baibaoku?.remoteCheckFailed, true);
    assert.equal(verC3.baibaoku?.code, 'NO_UPSTREAM');

    await rejectsWith(
        service.updateExtension(adminReq, { extensionName: 'personal-no-upstream-ext', global: true, force: true }),
        'NO_UPSTREAM',
        err => err.hint.includes('public/scripts/extensions/third-party/personal-no-upstream-ext') && !err.hint.includes(tmpRoot),
    );

    // C4: Detached HEAD -> NO_UPSTREAM across checkExtensionVersion and updateExtension
    const extC4Dir = path.join(userExtensions, 'detached-head-ext');
    git(tmpRoot, 'clone', '-q', repoC1.authBare, extC4Dir);
    git(extC4Dir, 'remote', 'set-url', 'origin', repoC1.canonicalHttpUrl);
    git(extC4Dir, 'checkout', '-q', '--detach', 'HEAD');

    const verC4 = await service.checkExtensionVersion(adminReq, { extensionName: 'detached-head-ext', global: false });
    assert.equal(verC4.baibaoku?.remoteCheckFailed, true);
    assert.equal(verC4.baibaoku?.code, 'NO_UPSTREAM');
    assert.equal(verC4.baibaoku?.detached, true);

    await rejectsWith(
        service.updateExtension(adminReq, { extensionName: 'detached-head-ext', global: false, force: true }),
        'NO_UPSTREAM',
    );

    // 4. Scenario D: Authoritative mihomo-like proxy reachable (150ms latency) + fast mirror (0ms latency)
    //    - Faster mirror MUST NOT abort the slower authoritative proxy probe!
    //    - When mirror is tampered with a rogue commit, authoritative proxy SHA wins and tampered mirror is dropped.
    proxyState = { enabled: true, delayMs: 150 };
    mirrorState = { enabled: true, delayMs: 0, root: authRemotesRoot };
    resetRouteStats();

    const repoD = createGithubPairRepo('owner', 'proxy-verified-ext', 'main');
    const installedD = await service.installExtension(adminReq, { url: repoD.canonicalHttpUrl, global: false });
    assert.equal(installedD.response.baibaoku.commit, repoD.first);

    // Create a tampered mirror bare repo serving a rogue commit while authoritative remote advances to legit v1.1.0
    const tamperedBare = path.join(mirrorRemotesRoot, 'owner', 'proxy-verified-ext.git');
    fs.mkdirSync(path.dirname(tamperedBare), { recursive: true });
    git(tmpRoot, 'clone', '-q', '--bare', repoD.authBare, tamperedBare);
    const legitShaD = repoD.commit('legit 1.1.0', { 'manifest.json': manifest('1.1.0'), 'index.js': 'export default "legit";\n' }, 'main');

    const rogueWork = path.join(tmpRoot, 'work', 'rogue-d');
    git(tmpRoot, 'clone', '-q', tamperedBare, rogueWork);
    fs.writeFileSync(path.join(rogueWork, 'manifest.json'), manifest('9.9.9-rogue'));
    fs.writeFileSync(path.join(rogueWork, 'index.js'), 'export default "pwned";\n');
    git(rogueWork, 'add', '-A');
    git(rogueWork, 'commit', '-q', '-m', 'rogue commit');
    const rogueShaD = git(rogueWork, 'rev-parse', 'HEAD');
    git(rogueWork, 'push', '-q', 'origin', 'main:main');

    mirrorState = { enabled: true, delayMs: 0, root: mirrorRemotesRoot };
    resetRouteStats();

    const updatedD = await service.updateExtension(adminReq, { extensionName: 'proxy-verified-ext', global: false });
    const extDDir = path.join(userExtensions, 'proxy-verified-ext');
    assert.equal(updatedD.response.shortCommitHash, legitShaD.slice(0, 7));
    assert.equal(git(extDDir, 'rev-parse', 'HEAD'), legitShaD, 'must update to authoritative proxy SHA, never rogue mirror SHA');
    assert.notEqual(git(extDDir, 'rev-parse', 'HEAD'), rogueShaD);
    assert.equal(fs.readFileSync(path.join(extDDir, 'index.js'), 'utf8'), 'export default "legit";\n');
});

test('WP-K-4 & FX2-1: hasActiveLazyThemeHydrator validates scan cache by directory mtime + 30s TTL, avoids sync power-user reads, and respects live disabledExtensions', () => {
    const extRoot = path.join(tmpRoot, 'theme-hydrator-exts');
    const globalRoot = path.join(tmpRoot, 'theme-hydrator-global');
    fs.mkdirSync(extRoot, { recursive: true });
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.utimesSync(extRoot, 1_700_000_000, 1_700_000_000);
    fs.utimesSync(globalRoot, 1_700_000_000, 1_700_000_000);

    const powerUserWithBridge = path.join(tmpRoot, 'power-user-patched.js');
    const powerUserAnchorMismatch = path.join(tmpRoot, 'power-user-anchor-mismatch.js');
    fs.writeFileSync(powerUserWithBridge, 'function applyTheme(name) {\n    console.log(\'theme applied: \' + name);\n}\n');
    fs.writeFileSync(powerUserAnchorMismatch, 'function applyThemeCustom() {}\n');

    // Install theme bridge once at startup: records status in memory (true for matched anchor, false for anchor mismatch)
    const installedOk = installThemeBridge({ powerUserPath: powerUserWithBridge });
    assert.equal(installedOk.installed, true);
    assert.equal(getThemeBridgeStatus({ powerUserPath: powerUserWithBridge }), true);

    const mismatchResult = installThemeBridge({ powerUserPath: powerUserAnchorMismatch });
    assert.equal(mismatchResult.installed, false);
    assert.equal(getThemeBridgeStatus({ powerUserPath: powerUserAnchorMismatch }), false);

    const req = makeReq({ extensionsDir: extRoot });
    const t0 = 1_700_000_000_000;

    // 1. Missing ST-BaiBai-Tools at t0 -> false
    assert.equal(
        hasActiveLazyThemeHydrator(req, '{}', {
            globalExtensionsDir: globalRoot,
            powerUserPath: powerUserWithBridge,
            extensionsEnabled: true,
            now: t0,
        }),
        false,
    );

    // 2. FX2-1: Installing ST-BaiBai-Tools advances extRoot mtime -> invalidates cache immediately within 30s TTL
    const toolsDir = path.join(extRoot, 'ST-BaiBai-Tools');
    const otherExtDir = path.join(extRoot, 'other-ext');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(otherExtDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'manifest.json'), JSON.stringify({ display_name: '柏宝箱', js: 'dist/index.js' }));
    fs.writeFileSync(path.join(otherExtDir, 'manifest.json'), JSON.stringify({ display_name: 'Other', js: 'index.js' }));
    fs.utimesSync(extRoot, 1_700_000_005, 1_700_000_005);

    assert.equal(
        hasActiveLazyThemeHydrator(req, '{}', {
            globalExtensionsDir: globalRoot,
            powerUserPath: powerUserWithBridge,
            extensionsEnabled: true,
            now: t0 + 10_000,
        }),
        true,
        'directory mtime change on install must invalidate scan cache immediately within 30s TTL',
    );

    let readdirCalls = 0;
    let readFileCalls = 0;
    const origReaddirSync = fs.readdirSync;
    const origReadFileSync = fs.readFileSync;
    fs.readdirSync = (...args) => {
        readdirCalls += 1;
        return origReaddirSync.apply(fs, args);
    };
    fs.readFileSync = (...args) => {
        readFileCalls += 1;
        return origReadFileSync.apply(fs, args);
    };

    try {
        // 3. Repeated calls within 30s when mtime is unchanged trigger ZERO readdirSync and ZERO readFileSync
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t0 + 15_000,
            }),
            true,
        );
        assert.equal(readdirCalls, 0, 'unchanged mtime within 30s must not call readdirSync');
        assert.equal(readFileCalls, 0, 'unchanged mtime within 30s must not call readFileSync');

        // 4. FX2-1: Uninstalling ST-BaiBai-Tools advances extRoot mtime -> returns false immediately within 30s TTL
        fs.rmSync(toolsDir, { recursive: true, force: true });
        fs.utimesSync(extRoot, 1_700_000_016, 1_700_000_016);
        readdirCalls = 0;
        readFileCalls = 0;
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t0 + 16_000,
            }),
            false,
            'directory mtime change on uninstall must invalidate scan cache immediately within 30s TTL',
        );
        assert.equal(readdirCalls, 1, 'uninstalling Tools must rescan extRoot immediately while globalRoot stays cached');

        // 5. 30s TTL fallback: empty folder created first, then manifest.json written inside without parent mtime change
        fs.mkdirSync(toolsDir, { recursive: true });
        fs.utimesSync(extRoot, 1_700_000_020, 1_700_000_020);
        const t1 = t0 + 20_000;
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t1,
            }),
            false,
        );
        fs.writeFileSync(path.join(toolsDir, 'manifest.json'), JSON.stringify({ display_name: '柏宝箱', js: 'dist/index.js' }));
        fs.utimesSync(extRoot, 1_700_000_020, 1_700_000_020);

        readdirCalls = 0;
        readFileCalls = 0;
        const t2 = t1 + 31_000;
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t2,
            }),
            true,
        );
        assert.ok(readdirCalls > 0, 'expired 30s TTL must rescan even if parent mtime did not change');

        readdirCalls = 0;
        readFileCalls = 0;
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t2 + 5_000,
            }),
            true,
        );
        assert.equal(readdirCalls, 0);
        assert.equal(readFileCalls, 0);

        // 6. Disabling Tools in settingsText immediately returns false (disabledExtensions is never cached):
        //    extRoot hits t2 cache (0 IO), globalRoot's t0 cache expired so it rescans once, then subsequent calls do 0 IO.
        const disabledSettings = JSON.stringify({
            extension_settings: {
                disabledExtensions: ['third-party/ST-BaiBai-Tools'],
            },
        });
        assert.equal(
            hasActiveLazyThemeHydrator(req, disabledSettings, {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t2 + 6_000,
            }),
            false,
        );
        assert.equal(readdirCalls, 1, 'only expired globalRoot should rescan once when extRoot toolkit is disabled');
        assert.equal(readFileCalls, 0);

        readdirCalls = 0;
        assert.equal(
            hasActiveLazyThemeHydrator(req, disabledSettings, {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t2 + 6_500,
            }),
            false,
        );
        assert.equal(readdirCalls, 0);
        assert.equal(readFileCalls, 0);

        // 7. Global extensionsEnabled === false -> false
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: false,
                now: t2 + 7_000,
            }),
            false,
        );

        // 8. Anchor mismatch recorded by installThemeBridge -> returns false with zero sync IO
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserAnchorMismatch,
                extensionsEnabled: true,
                now: t2 + 8_000,
            }),
            false,
        );
        assert.equal(readdirCalls, 0);
        assert.equal(readFileCalls, 0);
    } finally {
        fs.readdirSync = origReaddirSync;
        fs.readFileSync = origReadFileSync;
    }
});

test('FX3-2: system and builtin Git adapters verify complete (branch.<name>.remote, branch.<name>.merge) tracking tuple consistently', async () => {
    // 1. Unit matrix for parseBranchUpstreamConfig + resolveTrackedBranch
    const buildInfo = (branch, remoteValues, mergeValues) => {
        if (!branch) {
            return { branch: null, upstream: null, upstreamState: 'detached', upstreamRemote: null, upstreamTarget: null };
        }
        const parsed = parseBranchUpstreamConfig(remoteValues, mergeValues);
        return {
            branch,
            upstream: parsed.branch,
            upstreamState: parsed.state,
            upstreamRemote: parsed.remote,
            upstreamTarget: parsed.target,
        };
    };

    assert.deepEqual(
        service.resolveTrackedBranch(buildInfo('personal/stable', ['origin'], ['refs/heads/personal/stable'])),
        { ok: true, branch: 'personal/stable', inferred: false },
    );
    assert.deepEqual(
        service.resolveTrackedBranch(buildInfo('personal/stable', ['.'], ['refs/remotes/origin/personal/stable'])),
        { ok: true, branch: 'personal/stable', inferred: false },
    );

    // Non-origin tracking (upstream, local tracking ref to upstream, or local branch) -> UNSUPPORTED_UPSTREAM on all branches
    for (const [branch, remotes, merges] of [
        ['personal/stable', ['upstream'], ['refs/heads/personal/stable']],
        ['main', ['upstream'], ['refs/heads/main']],
        ['personal/stable', ['.'], ['refs/remotes/upstream/personal/stable']],
        ['main', ['.'], ['refs/heads/dev']],
        ['personal/stable', ['upstream'], []],
    ]) {
        const res = service.resolveTrackedBranch(buildInfo(branch, remotes, merges));
        assert.equal(res.ok, false, `expected rejection for ${branch} (${remotes} / ${merges})`);
        assert.equal(res.code, 'UNSUPPORTED_UPSTREAM');
    }

    // Incomplete or malformed tracking (missing remote, missing merge, wrong ref prefix, multi-valued) -> NO_UPSTREAM (never infers!)
    for (const [branch, remotes, merges] of [
        ['personal/stable', [], ['refs/heads/personal/stable']],
        ['main', [], ['refs/heads/main']],
        ['personal/stable', ['origin'], []],
        ['main', ['origin'], []],
        ['main', ['origin'], ['refs/remotes/origin/main']],
        ['main', ['origin'], ['refs/heads/main', 'refs/heads/dev']],
        ['main', ['origin', 'upstream'], ['refs/heads/main']],
    ]) {
        const res = service.resolveTrackedBranch(buildInfo(branch, remotes, merges));
        assert.equal(res.ok, false, `expected NO_UPSTREAM for ${branch} (${remotes} / ${merges})`);
        assert.equal(res.code, 'NO_UPSTREAM');
        assert.equal(res.incomplete, true);
    }

    // Complete absence -> Scheme A inference on normal branch only, NO_UPSTREAM on personal/*
    assert.deepEqual(
        service.resolveTrackedBranch(buildInfo('main', [], [])),
        { ok: true, branch: 'main', inferred: true },
    );
    assert.equal(service.resolveTrackedBranch(buildInfo('personal/stable', [], [])).code, 'NO_UPSTREAM');
    assert.equal(service.resolveTrackedBranch(buildInfo(null, [], [])).code, 'NO_UPSTREAM');

    // 2. End-to-end Smart HTTP integration across both 'system' and 'builtin' Git backends
    const adminReq = makeReq({ admin: true });
    proxyState = { enabled: true, delayMs: 0 };
    mirrorState = { enabled: false, delayMs: 0, root: authRemotesRoot };
    resetRouteStats();
    await service.updateManagerConfig(adminReq, {
        autoDetectProxy: false,
        proxy: proxyUrl,
        prefixMirrors: [],
        domainMirrors: [],
        allowUnverifiedMirrorDecision: false,
        cloudMirrorsEnabled: false,
        probeTimeoutMs: 2500,
    });

    const repo = createGithubPairRepo('owner', 'fx3-tracking-parity', 'main');
    const initialMainSha = repo.first;
    const initialStableSha = repo.commit('personal v1.0.0', { 'manifest.json': manifest('1.0.0-personal') }, 'personal/stable');
    const newerMainSha = repo.commit('main v1.1.0', { 'manifest.json': manifest('1.1.0') }, 'main');
    const newerStableSha = repo.commit('personal v1.1.0', { 'manifest.json': manifest('1.1.0-personal') }, 'personal/stable');

    for (const backend of ['system', 'builtin']) {
        process.env.SILLYTAVERN_GIT_BACKEND = backend;
        try {
            const envCheck = await service.getEnvironment();
            assert.equal(envCheck.backend, backend, `must exercise ${backend} Git adapter`);

            // Case A: personal/stable explicitly tracking upstream/personal/stable must NOT update from origin/personal/stable
            const extUpstreamPersonalName = `fx3-upstream-personal-${backend}`;
            const extUpstreamPersonalDir = path.join(userExtensions, extUpstreamPersonalName);
            git(tmpRoot, 'clone', '-q', '-b', 'personal/stable', repo.authBare, extUpstreamPersonalDir);
            git(extUpstreamPersonalDir, 'reset', '-q', '--hard', initialStableSha);
            git(extUpstreamPersonalDir, 'remote', 'set-url', 'origin', repo.canonicalHttpUrl);
            git(extUpstreamPersonalDir, 'remote', 'add', 'upstream', 'http://github.com/other/upstream-fork.git');
            git(extUpstreamPersonalDir, 'config', 'branch.personal/stable.remote', 'upstream');
            git(extUpstreamPersonalDir, 'config', 'branch.personal/stable.merge', 'refs/heads/personal/stable');

            const [sysInspectA, builtinInspectA] = await Promise.all([
                systemRepo.inspect(extUpstreamPersonalDir),
                builtinRepo.inspect(extUpstreamPersonalDir),
            ]);
            for (const inspected of [sysInspectA, builtinInspectA]) {
                assert.equal(inspected.upstream, null);
                assert.equal(inspected.upstreamState, 'non-origin');
                assert.equal(inspected.upstreamRemote, 'upstream');
                assert.equal(inspected.upstreamTarget, 'upstream/personal/stable');
            }

            const verA = await service.checkExtensionVersion(adminReq, { extensionName: extUpstreamPersonalName, global: false });
            assert.equal(verA.isUpToDate, true);
            assert.equal(verA.baibaoku?.remoteCheckFailed, true);
            assert.equal(verA.baibaoku?.code, 'UNSUPPORTED_UPSTREAM');

            for (const force of [false, true]) {
                await rejectsWith(
                    service.updateExtension(adminReq, { extensionName: extUpstreamPersonalName, global: false, force }),
                    'UNSUPPORTED_UPSTREAM',
                    err => err.message.includes('upstream/personal/stable'),
                );
            }
            assert.equal(git(extUpstreamPersonalDir, 'rev-parse', 'HEAD'), initialStableSha);
            assert.equal(git(extUpstreamPersonalDir, 'config', '--get', 'branch.personal/stable.remote'), 'upstream');

            // Case B: normal branch `main` tracking `upstream/main` must also reject (no silent origin/main inference or config overwrite)
            const extUpstreamMainName = `fx3-upstream-main-${backend}`;
            const extUpstreamMainDir = path.join(userExtensions, extUpstreamMainName);
            git(tmpRoot, 'clone', '-q', '-b', 'main', repo.authBare, extUpstreamMainDir);
            git(extUpstreamMainDir, 'reset', '-q', '--hard', initialMainSha);
            git(extUpstreamMainDir, 'remote', 'set-url', 'origin', repo.canonicalHttpUrl);
            git(extUpstreamMainDir, 'remote', 'add', 'upstream', 'http://github.com/other/upstream-main.git');
            git(extUpstreamMainDir, 'config', 'branch.main.remote', 'upstream');
            git(extUpstreamMainDir, 'config', 'branch.main.merge', 'refs/heads/main');

            const verB = await service.checkExtensionVersion(adminReq, { extensionName: extUpstreamMainName, global: false });
            assert.equal(verB.baibaoku?.remoteCheckFailed, true);
            assert.equal(verB.baibaoku?.code, 'UNSUPPORTED_UPSTREAM');

            for (const force of [false, true]) {
                await rejectsWith(
                    service.updateExtension(adminReq, { extensionName: extUpstreamMainName, global: false, force }),
                    'UNSUPPORTED_UPSTREAM',
                );
            }
            assert.equal(git(extUpstreamMainDir, 'rev-parse', 'HEAD'), initialMainSha);
            assert.equal(git(extUpstreamMainDir, 'config', '--get', 'branch.main.remote'), 'upstream');

            // Case C: deleting branch.personal/stable.remote while leaving merge (or vice versa) must trigger NO_UPSTREAM
            const extHalfConfigName = `fx3-half-config-${backend}`;
            const extHalfConfigDir = path.join(userExtensions, extHalfConfigName);
            git(tmpRoot, 'clone', '-q', '-b', 'personal/stable', repo.authBare, extHalfConfigDir);
            git(extHalfConfigDir, 'reset', '-q', '--hard', initialStableSha);
            git(extHalfConfigDir, 'remote', 'set-url', 'origin', repo.canonicalHttpUrl);
            git(extHalfConfigDir, 'config', '--unset', 'branch.personal/stable.remote');
            assert.equal(git(extHalfConfigDir, 'config', '--get', 'branch.personal/stable.merge'), 'refs/heads/personal/stable');

            const [sysInspectC, builtinInspectC] = await Promise.all([
                systemRepo.inspect(extHalfConfigDir),
                builtinRepo.inspect(extHalfConfigDir),
            ]);
            for (const inspected of [sysInspectC, builtinInspectC]) {
                assert.equal(inspected.upstream, null);
                assert.equal(inspected.upstreamState, 'incomplete');
            }

            const verC1 = await service.checkExtensionVersion(adminReq, { extensionName: extHalfConfigName, global: false });
            assert.equal(verC1.baibaoku?.remoteCheckFailed, true);
            assert.equal(verC1.baibaoku?.code, 'NO_UPSTREAM');
            for (const force of [false, true]) {
                await rejectsWith(
                    service.updateExtension(adminReq, { extensionName: extHalfConfigName, global: false, force }),
                    'NO_UPSTREAM',
                );
            }
            assert.equal(git(extHalfConfigDir, 'rev-parse', 'HEAD'), initialStableSha);

            // Flip half-config: remote=origin present, merge deleted -> also NO_UPSTREAM
            git(extHalfConfigDir, 'config', 'branch.personal/stable.remote', 'origin');
            git(extHalfConfigDir, 'config', '--unset', 'branch.personal/stable.merge');
            const verC2 = await service.checkExtensionVersion(adminReq, { extensionName: extHalfConfigName, global: false });
            assert.equal(verC2.baibaoku?.remoteCheckFailed, true);
            assert.equal(verC2.baibaoku?.code, 'NO_UPSTREAM');
            await rejectsWith(
                service.updateExtension(adminReq, { extensionName: extHalfConfigName, global: false, force: true }),
                'NO_UPSTREAM',
            );
            assert.equal(git(extHalfConfigDir, 'rev-parse', 'HEAD'), initialStableSha);

            // Normal branch `main` with deleted remote + leftover merge -> also NO_UPSTREAM (must not infer!)
            const extHalfMainName = `fx3-half-main-${backend}`;
            const extHalfMainDir = path.join(userExtensions, extHalfMainName);
            git(tmpRoot, 'clone', '-q', '-b', 'main', repo.authBare, extHalfMainDir);
            git(extHalfMainDir, 'reset', '-q', '--hard', initialMainSha);
            git(extHalfMainDir, 'remote', 'set-url', 'origin', repo.canonicalHttpUrl);
            git(extHalfMainDir, 'config', '--unset', 'branch.main.remote');
            await rejectsWith(
                service.updateExtension(adminReq, { extensionName: extHalfMainName, global: false, force: true }),
                'NO_UPSTREAM',
            );
            assert.equal(git(extHalfMainDir, 'rev-parse', 'HEAD'), initialMainSha);

            // Case D: valid local tracking ref (remote='.' + merge='refs/remotes/origin/personal/stable') updates cleanly
            const extDotOriginName = `fx3-dot-origin-${backend}`;
            const extDotOriginDir = path.join(userExtensions, extDotOriginName);
            git(tmpRoot, 'clone', '-q', '-b', 'personal/stable', repo.authBare, extDotOriginDir);
            git(extDotOriginDir, 'reset', '-q', '--hard', initialStableSha);
            git(extDotOriginDir, 'update-ref', 'refs/remotes/origin/personal/stable', initialStableSha);
            git(extDotOriginDir, 'remote', 'set-url', 'origin', repo.canonicalHttpUrl);
            git(extDotOriginDir, 'config', 'branch.personal/stable.remote', '.');
            git(extDotOriginDir, 'config', 'branch.personal/stable.merge', 'refs/remotes/origin/personal/stable');

            const verD = await service.checkExtensionVersion(adminReq, { extensionName: extDotOriginName, global: false });
            assert.equal(verD.isUpToDate, false);
            const updatedD = await service.updateExtension(adminReq, { extensionName: extDotOriginName, global: false });
            assert.equal(updatedD.response.shortCommitHash, newerStableSha.slice(0, 7));
            assert.equal(git(extDotOriginDir, 'rev-parse', 'HEAD'), newerStableSha);
            assert.equal(git(extDotOriginDir, 'rev-parse', 'refs/remotes/origin/personal/stable'), newerStableSha);

            // Also verify standard origin/main still updates normally to newerMainSha
            const extStdMainName = `fx3-std-main-${backend}`;
            const extStdMainDir = path.join(userExtensions, extStdMainName);
            git(tmpRoot, 'clone', '-q', '-b', 'main', repo.authBare, extStdMainDir);
            git(extStdMainDir, 'reset', '-q', '--hard', initialMainSha);
            git(extStdMainDir, 'update-ref', 'refs/remotes/origin/main', initialMainSha);
            git(extStdMainDir, 'remote', 'set-url', 'origin', repo.canonicalHttpUrl);
            const updatedStd = await service.updateExtension(adminReq, { extensionName: extStdMainName, global: false });
            assert.equal(updatedStd.response.shortCommitHash, newerMainSha.slice(0, 7));
            assert.equal(git(extStdMainDir, 'rev-parse', 'HEAD'), newerMainSha);
        } finally {
            process.env.SILLYTAVERN_GIT_BACKEND = 'system';
        }
    }
});

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

function createUserContext(handle) {
    const root = path.join(globalThis.DATA_ROOT, handle);
    const directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
        backups: path.join(root, 'backups'),
        extensions: path.join(root, 'extensions'),
    };
    for (const dir of Object.values(directories)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return {
        profile: { handle, admin: true },
        directories,
    };
}

function createEndpointHarness(dbManager) {
    const getHandlers = new Map();
    const postHandlers = new Map();
    const router = {
        get(routePath, handler) { getHandlers.set(routePath, handler); },
        post(routePath, handler) { postHandlers.set(routePath, handler); },
    };
    registerStEndpoints(router, dbManager);

    async function invoke(method, routePath, { user, body = {}, headers = {} } = {}) {
        const handler = method === 'GET' ? getHandlers.get(routePath) : postHandlers.get(routePath);
        assert.equal(typeof handler, 'function', `expected ${method} ${routePath} to be registered`);
        const normalizedHeaders = Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
        );
        const req = {
            method,
            path: routePath,
            user,
            body,
            headers: normalizedHeaders,
            get(name) { return normalizedHeaders[String(name).toLowerCase()]; },
        };
        let statusCode = 200;
        let payload;
        let ended = false;
        const resHeaders = new Map();
        const res = {
            status(code) { statusCode = code; return res; },
            set(name, val) { resHeaders.set(String(name).toLowerCase(), String(val)); return res; },
            setHeader(name, val) { resHeaders.set(String(name).toLowerCase(), String(val)); return res; },
            getHeader(name) { return resHeaders.get(String(name).toLowerCase()); },
            type(ct) { resHeaders.set('content-type', String(ct)); return res; },
            json(data) { payload = data; ended = true; return res; },
            send(data) { payload = data; ended = true; return res; },
        };
        await handler(req, res);
        assert.equal(ended, true, `${method} ${routePath} must send a response`);
        return { status: statusCode, body: payload, headers: resHeaders };
    }

    return { invoke };
}

function writeV2CardPng(filePath, cardObject) {
    const buf = writeCharacterPng(ONE_PIXEL_PNG, JSON.stringify(cardObject));
    fs.writeFileSync(filePath, buf);
}

test('WP-3 Chain 1a: /v1/characters/fast-all detects POSIX chats/<charName> atomic updates without top-level chats/ mtime change and resets deleted chat folders to 0', async () => {
    const dbManager = new DatabaseManager();
    try {
        closeStEndpointCaches();
        const harness = createEndpointHarness(dbManager);
        const user = createUserContext('wp3-posix-user');
        const { characters: charactersDir, chats: chatsDir } = user.directories;

        writeV2CardPng(path.join(charactersDir, 'Alice.png'), {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Alice', description: 'Wonderland', extensions: { fav: false } },
        });
        writeV2CardPng(path.join(charactersDir, 'Bob.png'), {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Bob', description: 'Builder', extensions: { fav: true } },
        });

        const aliceChatDir = path.join(chatsDir, 'Alice');
        fs.mkdirSync(aliceChatDir, { recursive: true });
        fs.utimesSync(aliceChatDir, 1_700_000_000, 1_700_000_000);
        const frozenTopChatsTime = new Date(1_700_000_000 * 1000);
        fs.utimesSync(chatsDir, frozenTopChatsTime, frozenTopChatsTime);

        // Prime cache when Alice's chat directory exists and is empty
        const initialRes = await harness.invoke('POST', '/v1/characters/fast-all', { user });
        assert.equal(initialRes.status, 200);
        const alice0 = initialRes.body.find(c => c.avatar === 'Alice.png');
        assert.ok(alice0);
        assert.equal(alice0.chat_size, 0);
        assert.equal(alice0.date_last_chat, 0);

        const topChatsStatBefore = fs.statSync(chatsDir);
        const charsStatBefore = fs.statSync(charactersDir);

        // Simulate ST's Linux writeFileAtomicSync inside chats/Alice/chat1.jsonl:
        // updates chats/Alice/ mtimeMs while top-level chats/ and characters/ mtimeMs stay unchanged!
        const chat1Path = path.join(aliceChatDir, '2026-05-01@12h00m00s.jsonl');
        const chat1Payload = '{"chat_metadata":{}}\n{"name":"Alice","mes":"Hello POSIX!","send_date":"2026-05-01T12:00:00.000Z"}\n';
        writeFileAtomicSync(chat1Path, chat1Payload, 'utf8');
        fs.utimesSync(chatsDir, frozenTopChatsTime, frozenTopChatsTime);

        assert.equal(fs.statSync(chatsDir).mtimeMs, topChatsStatBefore.mtimeMs, 'top-level chats/ mtimeMs must remain unchanged');
        assert.equal(fs.statSync(charactersDir).mtimeMs, charsStatBefore.mtimeMs, 'characters/ mtimeMs must remain unchanged');

        const afterChatWriteRes = await harness.invoke('POST', '/v1/characters/fast-all', { user });
        const alice1 = afterChatWriteRes.body.find(c => c.avatar === 'Alice.png');
        const chat1Stat = fs.statSync(chat1Path);
        assert.equal(alice1.chat_size, chat1Stat.size, 'chat_size must update even when top-level chats/ mtimeMs did not change');
        assert.equal(alice1.date_last_chat, chat1Stat.mtimeMs, 'date_last_chat must update even when top-level chats/ mtimeMs did not change');

        // Also verify when charactersChanged === true (new Carol.png added) while Alice.png is unchanged and Alice gets chat2.jsonl
        const chat2Path = path.join(aliceChatDir, '2026-05-01@12h05m00s.jsonl');
        writeFileAtomicSync(chat2Path, '{"chat_metadata":{}}\n{"name":"Alice","mes":"Second chat"}\n', 'utf8');
        fs.utimesSync(chatsDir, frozenTopChatsTime, frozenTopChatsTime);
        writeV2CardPng(path.join(charactersDir, 'Carol.png'), {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Carol', description: 'Singer', extensions: { fav: false } },
        });
        const charsBumpedTime = new Date(Date.now() + 5_000);
        fs.utimesSync(charactersDir, charsBumpedTime, charsBumpedTime);

        const afterBothChangedRes = await harness.invoke('POST', '/v1/characters/fast-all', { user });
        const alice2 = afterBothChangedRes.body.find(c => c.avatar === 'Alice.png');
        const chat2Stat = fs.statSync(chat2Path);
        assert.equal(alice2.chat_size, chat1Stat.size + chat2Stat.size, 'unchanged .png must still refresh chat stats when charactersChanged is true');
        assert.equal(alice2.date_last_chat, Math.max(chat1Stat.mtimeMs, chat2Stat.mtimeMs));

        // Deleting chats/Alice/ must reset date_last_chat and chat_size back to 0 (even if top-level chats/ mtime is restored)
        fs.rmSync(aliceChatDir, { recursive: true, force: true });
        fs.utimesSync(chatsDir, frozenTopChatsTime, frozenTopChatsTime);

        const afterDeleteDirRes = await harness.invoke('POST', '/v1/characters/fast-all', { user });
        const alice3 = afterDeleteDirRes.body.find(c => c.avatar === 'Alice.png');
        assert.equal(alice3.chat_size, 0, 'deleted character chat folder must reset chat_size to 0');
        assert.equal(alice3.date_last_chat, 0, 'deleted character chat folder must reset date_last_chat to 0');
    } finally {
        closeStEndpointCaches();
        dbManager.closeAll();
    }
});

test('WP-3 Chain 1b: /v1/characters/fast-all and formatShallowCharacter match ST Core toShallow parity and evict corrupted/nameless cards from memory + SQLite', async () => {
    const dbManager = new DatabaseManager();
    try {
        closeStEndpointCaches();
        const harness = createEndpointHarness(dbManager);
        const user = createUserContext('wp3-shallow-user');
        const { characters: charactersDir, chats: chatsDir } = user.directories;

        // 1. Direct unit checks on formatShallowCharacter for pure V1 (no spec) and V2 cards
        const fakeStat = { ctimeMs: 1_710_000_123.456, mtimeMs: 1_710_000_500, size: 512 };
        const v1Raw = JSON.stringify({
            name: 'default_Seraphina',
            description: 'A guardian angel.',
            personality: 'Warm',
            scenario: 'Sanctuary',
            first_mes: 'Greetings!',
            mes_example: '',
            creatorcomment: 'Created for V1 test',
            fav: 'false',
            tags: 'angel, guardian',
            creator: 'Tester',
        });
        const v1Shallow = await formatShallowCharacter('default_Seraphina.png', fakeStat, v1Raw, chatsDir, null);
        assert.ok(v1Shallow);
        assert.equal(v1Shallow.name, 'default_Seraphina', 'must preserve default_ prefix matching ST Core');
        assert.equal(v1Shallow.data.name, 'default_Seraphina');
        assert.equal(v1Shallow.fav, false, 'string "false" must normalize to boolean false, never truthy string');
        assert.equal(v1Shallow.data.extensions.fav, false);
        assert.deepEqual(v1Shallow.tags, ['angel', 'guardian']);
        assert.equal(v1Shallow.date_added, fakeStat.ctimeMs);
        assert.equal(v1Shallow.create_date, new Date(Math.round(fakeStat.ctimeMs)).toISOString());

        const expectedV1DataSize = [
            'default_Seraphina',
            'A guardian angel.',
            'Warm',
            'Sanctuary',
            'Greetings!',
            '',
            'Created for V1 test',
            '',
            '',
            String(['angel', 'guardian']),
            'Tester',
            '',
            String([]),
            '[object Object]',
        ].reduce((acc, s) => acc + s.length, 0);
        assert.equal(v1Shallow.data_size, expectedV1DataSize, 'V1 data_size must match ST convertToV2 + calculateDataSize');

        // 2. V2 fav boolean precedence (root fav: true overridden by data.extensions.fav: false; string "true" -> true)
        const v2PrecedenceCard = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'WrongRootName',
            fav: true,
            extra_huge_root_blob: 'x'.repeat(5000),
            data: {
                name: 'default_Knight',
                description: 'Loyal knight',
                personality: 'Stoic',
                scenario: 'Castle',
                first_mes: 'Halt.',
                mes_example: '',
                creator_notes: 'V2 notes',
                system_prompt: '',
                post_history_instructions: '',
                tags: ['knight'],
                creator: 'Author',
                character_version: '1.2',
                alternate_greetings: ['Welcome.'],
                extensions: {
                    fav: false,
                    world: 'KingdomLore',
                },
            },
        };
        writeV2CardPng(path.join(charactersDir, 'default_Knight.png'), v2PrecedenceCard);

        const v2StringTrueCard = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            fav: false,
            data: {
                name: 'Mage',
                description: 'Arcane scholar',
                extensions: { fav: 'true' },
            },
        };
        writeV2CardPng(path.join(charactersDir, 'Mage.png'), v2StringTrueCard);

        // Corrupted (no PNG metadata) and nameless cards present on disk
        fs.writeFileSync(path.join(charactersDir, 'Corrupted.png'), ONE_PIXEL_PNG);
        writeV2CardPng(path.join(charactersDir, 'Nameless.png'), {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: '   ', description: 'Should be omitted' },
        });

        const listRes1 = await harness.invoke('POST', '/v1/characters/fast-all', { user });
        assert.equal(listRes1.status, 200);
        const avatars1 = listRes1.body.map(c => c.avatar).sort();
        assert.deepEqual(avatars1, ['Mage.png', 'default_Knight.png'], 'corrupted and nameless cards must be omitted');

        const knight = listRes1.body.find(c => c.avatar === 'default_Knight.png');
        assert.equal(knight.name, 'default_Knight');
        assert.equal(knight.fav, false, 'V2 data.extensions.fav=false must override legacy root fav=true');
        assert.equal(knight.data.extensions.fav, false);
        const expectedKnightDataSize = Object.values(v2PrecedenceCard.data).reduce((acc, val) => acc + String(val).length, 0);
        assert.equal(knight.data_size, expectedKnightDataSize, 'V2 data_size must match ST calculateDataSize(v2.data) without root bloat');

        const mage = listRes1.body.find(c => c.avatar === 'Mage.png');
        assert.equal(mage.fav, true, 'string "true" in data.extensions.fav must normalize to boolean true');
        assert.equal(mage.data.extensions.fav, true);

        // 3. Corrupting a previously cached valid card must evict it from BOTH memory and SQLite persistent cache
        const magePath = path.join(charactersDir, 'Mage.png');
        fs.writeFileSync(magePath, ONE_PIXEL_PNG);
        const futureTime = new Date(Date.now() + 10_000);
        fs.utimesSync(magePath, futureTime, futureTime);
        fs.utimesSync(charactersDir, futureTime, futureTime);

        const listRes2 = await harness.invoke('POST', '/v1/characters/fast-all', { user });
        assert.deepEqual(listRes2.body.map(c => c.avatar), ['default_Knight.png'], 'newly corrupted card must be evicted immediately');

        // Reload from SQLite after clearing in-memory caches + seeding a legacy schema=1 fabricated entry
        const dummyReq = { user };
        await dbManager.set(dummyReq, 'baibaoku.internal', 'character-fast-all', 'Corrupted.png', {
            mtime: fs.statSync(path.join(charactersDir, 'Corrupted.png')).mtimeMs,
            size: ONE_PIXEL_PNG.length,
            data: { shallow: true, name: 'Corrupted', avatar: 'Corrupted.png' },
        });
        closeStEndpointCaches();

        const listRes3 = await harness.invoke('POST', '/v1/characters/fast-all', { user });
        assert.deepEqual(listRes3.body.map(c => c.avatar), ['default_Knight.png'], 'SQLite reload must not resurrect corrupted or schema=1 fabricated cards');
        const dbMage = await dbManager.get(dummyReq, 'baibaoku.internal', 'character-fast-all', 'Mage.png');
        assert.equal(dbMage.exists, false, 'Mage.png must be deleted from SQLite persistent store');
        const dbCorrupted = await dbManager.get(dummyReq, 'baibaoku.internal', 'character-fast-all', 'Corrupted.png');
        assert.equal(dbCorrupted.exists, false, 'legacy schema=1 fabricated entry must be purged from SQLite');
    } finally {
        closeStEndpointCaches();
        dbManager.closeAll();
    }
});

test('WP-3 Chain 2a: /v1/chats/fast-recent and /v1/chats/fast-search emit degraded previews instead of hiding chats, recompute null cache rows, and GC deleted group chats', async () => {
    const dbManager = new DatabaseManager();
    try {
        closeStEndpointCaches();
        const harness = createEndpointHarness(dbManager);
        const user = createUserContext('wp3-chats-user');
        const { characters: charactersDir, chats: chatsDir, groups: groupsDir, groupChats: groupChatsDir } = user.directories;

        writeV2CardPng(path.join(charactersDir, 'Hero.png'), {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Hero', extensions: { fav: false } },
        });

        const heroChatsDir = path.join(chatsDir, 'Hero');
        fs.mkdirSync(heroChatsDir, { recursive: true });

        const emptyFile = path.join(heroChatsDir, '01_empty.jsonl');
        const validTrailingNl = path.join(heroChatsDir, '02_valid_nl.jsonl');
        const blankTailFile = path.join(heroChatsDir, '03_blank_tail.jsonl');
        const corruptTwoLines = path.join(heroChatsDir, '04_corrupt_2.jsonl');
        const corruptThreeLines = path.join(heroChatsDir, '05_corrupt_3.jsonl');

        fs.writeFileSync(emptyFile, '');
        fs.writeFileSync(
            validTrailingNl,
            '{"chat_metadata":{"note":"meta"}}\n{"name":"Hero","mes":"Valid message","send_date":"2026-06-01T10:00:00.000Z"}\n',
        );
        fs.writeFileSync(
            blankTailFile,
            '{"chat_metadata":{}}\n{"name":"Hero","mes":"Before blank line","send_date":"2026-06-01T09:00:00.000Z"}\n\n',
        );
        fs.writeFileSync(corruptTwoLines, '{"chat_metadata":{}}\n{truncated_json');
        fs.writeFileSync(
            corruptThreeLines,
            '{"chat_metadata":{}}\n{"name":"Hero","mes":"Intact first reply"}\n{"foo":"missing_known_fields"}\n',
        );

        // Pre-seed SQLite fast-search cache with a legacy `result: null` marker to verify it recomputes instead of hiding!
        const corruptTwoStat = fs.statSync(corruptTwoLines);
        await dbManager.openForRequest({ user }, 'baibaoku.internal', { displayName: '柏宝库内部缓存', version: 1 });
        await dbManager.set({ user }, 'baibaoku.internal', 'chats-fast-search', corruptTwoLines, {
            schema: 2,
            mtime: corruptTwoStat.mtimeMs,
            size: corruptTwoStat.size,
            result: null,
        });
        closeStEndpointCaches();

        const recentRes = await harness.invoke('POST', '/v1/chats/fast-recent', {
            user,
            body: { max: 20, metadata: true },
        });
        assert.equal(recentRes.status, 200);
        const recentById = new Map(recentRes.body.map(item => [item.file_id, item]));
        assert.equal(recentById.size, 5, 'fast-recent must never hide empty, blank-tail, or corrupted-tail chat files');

        assert.equal(recentById.get('01_empty').chat_items, 0);
        assert.equal(recentById.get('01_empty').mes, '[The chat is empty]');
        assert.equal(recentById.get('01_empty').last_mes, fs.statSync(emptyFile).mtimeMs);

        assert.equal(recentById.get('02_valid_nl').chat_items, 1);
        assert.equal(recentById.get('02_valid_nl').mes, 'Valid message');
        assert.equal(recentById.get('02_valid_nl').last_mes, '2026-06-01T10:00:00.000Z');
        assert.deepEqual(recentById.get('02_valid_nl').chat_metadata, { note: 'meta' });

        // Native getChatInfo treats trailing blank line (readline lastLine === "") identically to empty chat
        assert.equal(recentById.get('03_blank_tail').chat_items, 0);
        assert.equal(recentById.get('03_blank_tail').mes, '[The chat is empty]');
        assert.equal(recentById.get('03_blank_tail').last_mes, fs.statSync(blankTailFile).mtimeMs);

        assert.equal(recentById.get('04_corrupt_2').chat_items, 0, '2-line header+corrupt must report 0 valid messages');
        assert.equal(recentById.get('04_corrupt_2').mes, '[The message is empty]');
        assert.equal(recentById.get('04_corrupt_2').last_mes, fs.statSync(corruptTwoLines).mtimeMs);

        assert.equal(recentById.get('05_corrupt_3').chat_items, 1, '3-line header+msg+corrupt must report 1 valid message');
        assert.equal(recentById.get('05_corrupt_3').mes, '[The message is empty]');
        assert.equal(recentById.get('05_corrupt_3').last_mes, fs.statSync(corruptThreeLines).mtimeMs);

        const searchRes = await harness.invoke('POST', '/v1/chats/fast-search', {
            user,
            body: { query: '', avatar_url: 'Hero.png' },
        });
        assert.equal(searchRes.status, 200);
        const searchByName = new Map(searchRes.body.map(item => [item.file_name, item]));
        assert.equal(searchByName.size, 5, 'fast-search must return all 5 chat files including recomputed null cache entry');
        assert.equal(searchByName.get('01_empty').message_count, 0);
        assert.equal(searchByName.get('01_empty').preview_message, '[The chat is empty]');
        assert.equal(searchByName.get('01_empty').last_mes, fs.statSync(emptyFile).mtimeMs);
        assert.equal(searchByName.get('02_valid_nl').message_count, 1);
        assert.equal(searchByName.get('02_valid_nl').preview_message, 'Valid message');
        assert.equal(searchByName.get('03_blank_tail').message_count, 0);
        assert.equal(searchByName.get('03_blank_tail').preview_message, '[The chat is empty]');
        assert.equal(searchByName.get('03_blank_tail').last_mes, fs.statSync(blankTailFile).mtimeMs);
        assert.equal(searchByName.get('04_corrupt_2').message_count, 0);
        assert.equal(searchByName.get('04_corrupt_2').preview_message, '[The message is empty]');
        assert.equal(searchByName.get('04_corrupt_2').last_mes, fs.statSync(corruptTwoLines).mtimeMs);
        assert.equal(searchByName.get('05_corrupt_3').message_count, 1);
        assert.equal(searchByName.get('05_corrupt_3').preview_message, '[The message is empty]');
        assert.equal(searchByName.get('05_corrupt_3').last_mes, fs.statSync(corruptThreeLines).mtimeMs);

        // S8: Non-string, dot-segment, empty, or path-escaping avatar_url MUST be rejected with HTTP 400
        for (const badAvatar of [['../../otheruser/chats/Alice'], '..', '.', '.png', '', null, 123, 'Hero/sub.png']) {
            const badRes = await harness.invoke('POST', '/v1/chats/fast-search', {
                user,
                body: { query: '', avatar_url: badAvatar },
            });
            assert.equal(badRes.status, 400, `malformed avatar_url ${JSON.stringify(badAvatar)} must return 400`);
        }

        // Group chat GC test: deleting a group chat file removes its cache key without touching other groups' existing chats
        const gc1Path = path.join(groupChatsDir, 'gc_g1_keep.jsonl');
        const gc2Path = path.join(groupChatsDir, 'gc_g1_delete.jsonl');
        const gcOtherPath = path.join(groupChatsDir, 'gc_g2_keep.jsonl');
        fs.writeFileSync(gc1Path, '{"chat_metadata":{}}\n{"name":"Hero","mes":"G1 keep"}\n');
        fs.writeFileSync(gc2Path, '{"chat_metadata":{}}\n{"name":"Hero","mes":"G1 delete"}\n');
        fs.writeFileSync(gcOtherPath, '{"chat_metadata":{}}\n{"name":"Hero","mes":"G2 keep"}\n');
        fs.writeFileSync(path.join(groupsDir, 'g1.json'), JSON.stringify({ id: 'group-1', chats: ['gc_g1_keep', 'gc_g1_delete'] }));
        fs.writeFileSync(path.join(groupsDir, 'g2.json'), JSON.stringify({ id: 'group-2', chats: ['gc_g2_keep'] }));

        await harness.invoke('POST', '/v1/chats/fast-search', { user, body: { query: '', group_id: 'group-1' } });
        await harness.invoke('POST', '/v1/chats/fast-search', { user, body: { query: '', group_id: 'group-2' } });

        fs.unlinkSync(gc2Path);
        fs.writeFileSync(path.join(groupsDir, 'g1.json'), JSON.stringify({ id: 'group-1', chats: ['gc_g1_keep'] }));

        const groupAfterGc = await harness.invoke('POST', '/v1/chats/fast-search', {
            user,
            body: { query: '', group_id: 'group-1' },
        });
        assert.equal(groupAfterGc.status, 200);
        assert.deepEqual(groupAfterGc.body.map(x => x.file_name), ['gc_g1_keep']);
        assert.equal(groupAfterGc.headers.get('x-baibaoku-search-cache-gc'), '1');

        const deletedEntry = await dbManager.get({ user }, 'baibaoku.internal', 'chats-fast-search', gc2Path);
        const keptGroup1Entry = await dbManager.get({ user }, 'baibaoku.internal', 'chats-fast-search', gc1Path);
        const keptGroup2Entry = await dbManager.get({ user }, 'baibaoku.internal', 'chats-fast-search', gcOtherPath);
        assert.equal(deletedEntry.exists, false, 'deleted group chat file must be pruned from SQLite fast-search cache');
        assert.equal(keptGroup1Entry.exists, true);
        assert.equal(keptGroup2Entry.exists, true, 'other groups existing chat files must never be pruned');

        // Verify /v1/chats/fast-get remains 410 Gone and dead helper code is removed from st-endpoints.js
        const fastGetRes = await harness.invoke('POST', '/v1/chats/fast-get', { user, body: {} });
        assert.equal(fastGetRes.status, 410);
        assert.equal(fastGetRes.body?.error, true);
        const stEndpointsSource = fs.readFileSync(path.join(pluginRoot, 'src/st-endpoints.js'), 'utf8');
        assert.equal(stEndpointsSource.includes('function getFastChatGet'), false);
        assert.equal(stEndpointsSource.includes('scanJsonlTailRanges'), false);
    } finally {
        closeStEndpointCaches();
        dbManager.closeAll();
    }
});

test('WP-3 Chain 2b: /v1/chat-backups/fast-list extracts tail send_date, mes, and file_id with native /api/backups/chat/get parity and invalidates legacy schema=2 cache', async () => {
    const dbManager = new DatabaseManager();
    try {
        closeStEndpointCaches();
        const harness = createEndpointHarness(dbManager);
        const user = createUserContext('wp3-backups-user');
        const { backups: backupsDir } = user.directories;

        const b1 = path.join(backupsDir, 'chat_Hero_20260101.jsonl');
        const bNumeric = path.join(backupsDir, 'chat_Hero_numeric.jsonl');
        const bEmpty = path.join(backupsDir, 'chat_Hero_empty.jsonl');
        const bCorrupt = path.join(backupsDir, 'chat_Hero_corrupt.jsonl');

        fs.writeFileSync(
            b1,
            '{"chat_metadata":{}}\n{"name":"Hero","mes":"Restored greeting","send_date":"2026-02-14T08:30:00.000Z"}\n',
        );
        fs.writeFileSync(
            bNumeric,
            '{"chat_metadata":{}}\n{"name":"Hero","mes":"Legacy epoch send_date","send_date":1700000000000}\n',
        );
        const olderMtime = new Date('2025-01-01T00:00:00.000Z');
        fs.utimesSync(b1, olderMtime, olderMtime);
        fs.writeFileSync(bEmpty, '');
        fs.writeFileSync(bCorrupt, '{"chat_metadata":{}}\n{"name":"Hero","mes":"Msg 1"}\n{broken_tail');

        // Seed stale schema=2 row lacking schema=3 parity
        const b1Stat = fs.statSync(b1);
        await dbManager.openForRequest({ user }, 'baibaoku.internal', { displayName: 'BaiBaoKu internal cache', version: 1 });
        await dbManager.set({ user }, 'baibaoku.internal', 'chat-backups-fast-list', 'chat_Hero_20260101.jsonl', {
            schema: 2,
            mtime: b1Stat.mtimeMs,
            size: b1Stat.size,
            chatItems: 1,
            mes: 'Stale mes',
            lastMes: '2020-01-01T00:00:00.000Z',
        });
        closeStEndpointCaches();

        const res1 = await harness.invoke('POST', '/v1/chat-backups/fast-list', { user });
        assert.equal(res1.status, 200);
        assert.equal(res1.headers.get('x-baibaoku-cache-misses'), '4', 'legacy schema=2 backup cache entry must recompute');

        const byName = new Map(res1.body.map(item => [item.file_name, item]));
        assert.equal(byName.size, 4);

        const row1 = byName.get('chat_Hero_20260101.jsonl');
        assert.equal(row1.file_id, 'chat_Hero_20260101');
        assert.equal(row1.chat_items, 1);
        assert.equal(row1.mes, 'Restored greeting');
        assert.equal(row1.last_mes, '2026-02-14T08:30:00.000Z', 'last_mes must come from tail send_date rather than file mtimeMs');

        const rowNumeric = byName.get('chat_Hero_numeric.jsonl');
        assert.equal(rowNumeric.last_mes, 1700000000000, 'numeric send_date must be preserved without String() coercion');

        const rowEmpty = byName.get('chat_Hero_empty.jsonl');
        assert.equal(rowEmpty.file_id, 'chat_Hero_empty');
        assert.equal(rowEmpty.chat_items, 0);
        assert.equal(rowEmpty.mes, '[The chat is empty]');
        assert.equal(rowEmpty.last_mes, fs.statSync(bEmpty).mtimeMs);

        const rowCorrupt = byName.get('chat_Hero_corrupt.jsonl');
        assert.equal(rowCorrupt.file_id, 'chat_Hero_corrupt');
        assert.equal(rowCorrupt.chat_items, 1);
        assert.equal(rowCorrupt.mes, '[The message is empty]');
        assert.equal(rowCorrupt.last_mes, fs.statSync(bCorrupt).mtimeMs);

        // Second call must hit schema=3 cache with identical fields (including numeric last_mes!)
        closeStEndpointCaches();
        const res2 = await harness.invoke('POST', '/v1/chat-backups/fast-list', { user });
        assert.equal(res2.headers.get('x-baibaoku-cache-hits'), '4');
        assert.deepEqual(res2.body, res1.body);
    } finally {
        closeStEndpointCaches();
        dbManager.closeAll();
    }
});

test('WP-3 Chain 3: makeEarlyBridgeScript preserves native MutationObserver, exposes initialFastConfig, eliminates settingsSaveCache hash drops, coalesces only in-flight identical saves, and invalidates on all mutating routes', async () => {
    const dbManager = new DatabaseManager();
    try {
        closeStEndpointCaches();
        const harness = createEndpointHarness(dbManager);
        const user = createUserContext('wp3-bridge-user');

        // 1. /v1/fast-config GET & POST must always report chatKeyboardScanReductionEnabled: false and progressiveChatLoadingEnabled: false
        const getCfg = await harness.invoke('GET', '/v1/fast-config', { user });
        assert.equal(getCfg.status, 200);
        assert.equal(getCfg.body.data.chatKeyboardScanReductionEnabled, false);
        assert.equal(getCfg.body.data.progressiveChatLoadingEnabled, false);

        const setCfg = await harness.invoke('POST', '/v1/fast-config', {
            user,
            body: {
                chatKeyboardScanReductionEnabled: true,
                progressiveChatLoadingEnabled: true,
                tokenizerBulkCountEnabled: false,
            },
        });
        assert.equal(setCfg.status, 200);
        assert.equal(setCfg.body.data.chatKeyboardScanReductionEnabled, false);
        assert.equal(setCfg.body.data.progressiveChatLoadingEnabled, false);
        assert.equal(setCfg.body.data.tokenizerBulkCountEnabled, false);

        // 2. Verify makeEarlyBridgeScript never wraps MutationObserver, exposes initialFastConfig, and never drops sequential saves
        const script = makeEarlyBridgeScript({
            settingsAccelerationEnabled: true,
            lazyThemeLoadingEnabled: false,
            characterListAccelerationEnabled: true,
            recentChatListAccelerationEnabled: false,
            tokenizerBulkCountEnabled: false,
            extensionManifestBundleEnabled: true,
            versionAccelerationEnabled: true,
            chatKeyboardScanReductionEnabled: true,
        });
        assert.equal(script.includes('installKeyboardObserverCoalescing'), false);
        assert.equal(script.includes('hashStringForSaveKey'), false);

        class NativeMutationObserver {
            constructor(cb) { this.cb = cb; }
            observe() {}
            disconnect() {}
            takeRecords() { return []; }
        }

        let fastSaveNetworkCalls = 0;
        let saveGateRelease = null;
        const windowObj = {
            location: new URL('http://127.0.0.1:8000/'),
            Response,
            Headers,
            Request,
            Blob,
            URL,
            URLSearchParams,
            TextEncoder,
            TextDecoder,
            Promise,
            setTimeout,
            clearTimeout,
            MutationObserver: NativeMutationObserver,
            document: {
                readyState: 'complete',
                body: {},
                addEventListener: () => {},
                documentElement: null,
            },
            fetch: async (input) => {
                const url = typeof input === 'string' ? input : input.url;
                const pathname = new URL(url, 'http://127.0.0.1:8000').pathname;
                if (pathname === '/api/plugins/baibaoku/v1/settings/fast-save') {
                    fastSaveNetworkCalls += 1;
                    if (saveGateRelease) {
                        await saveGateRelease;
                    }
                    return new Response(JSON.stringify({ ok: true }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            },
        };
        windowObj.window = windowObj;
        windowObj.globalThis = windowObj;

        vm.runInNewContext(script, windowObj);
        const bridge = windowObj.__baibaokuEarlyBridge;
        assert.equal(bridge.installed, true);
        assert.equal(windowObj.MutationObserver, NativeMutationObserver, 'window.MutationObserver must remain 100% native');
        assert.equal(Boolean(windowObj.MutationObserver.__baibaokuWrapped), false);
        assert.equal(bridge.keyboardObserverCoalescingInstalled, false);
        assert.equal(bridge.chatKeyboardScanReductionEnabled, false);
        assert.equal(bridge.isChatKeyboardScanReductionEnabled(), false);
        assert.equal(bridge.setChatKeyboardScanReductionEnabled(true), false);
        assert.equal(bridge.chatKeyboardScanReductionEnabled, false);

        assert.deepEqual({ ...bridge.initialFastConfig }, {
            settingsAccelerationEnabled: true,
            lazyThemeLoadingEnabled: false,
            characterListAccelerationEnabled: true,
            recentChatListAccelerationEnabled: false,
            progressiveChatLoadingEnabled: false,
            tokenizerBulkCountEnabled: false,
            extensionManifestBundleEnabled: true,
            versionAccelerationEnabled: true,
            chatKeyboardScanReductionEnabled: false,
        });

        // 3. Sequential identical saves MUST both reach the backend (never dropped by client-side hash cache)
        const payloadA = JSON.stringify({ active_preset: 'Alpha', temperature: 1.0 });
        await windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadA });
        assert.equal(fastSaveNetworkCalls, 1);
        assert.equal(bridge.settingsSaveCache, null);

        await windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadA });
        assert.equal(fastSaveNetworkCalls, 2, 'sequential identical settings/save must never be dropped on the client');

        // 4. Concurrent in-flight identical saves coalesce into 1 network request; different bodies do NOT coalesce
        let releaseGate;
        saveGateRelease = new Promise(resolve => { releaseGate = resolve; });
        const payloadB = JSON.stringify({ active_preset: 'Beta', temperature: 0.8 });
        const p1 = windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadB });
        const p2 = windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadB });
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.equal(fastSaveNetworkCalls, 3, 'concurrent identical in-flight saves must coalesce to 1 backend request');
        releaseGate();
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);
        assert.deepEqual(await r1.json(), { ok: true });
        assert.deepEqual(await r2.json(), { ok: true });
        assert.equal(r2.headers.get('x-baibaoku-frontend-save-cache'), 'pending');
        assert.equal(bridge.settingsSavePending, null);

        // Concurrent DIFFERENT-body saves must NOT coalesce
        saveGateRelease = new Promise(resolve => { releaseGate = resolve; });
        const pd1 = windowObj.fetch('/api/settings/save', { method: 'POST', body: JSON.stringify({ k: 1 }) });
        const pd2 = windowObj.fetch('/api/settings/save', { method: 'POST', body: JSON.stringify({ k: 2 }) });
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.equal(fastSaveNetworkCalls, 5, 'concurrent different-body saves must both reach backend');
        releaseGate();
        await Promise.all([pd1, pd2]);

        // 5. Non-save mutating route (e.g. /api/presets/save) clears settingsSavePending & calls clearSettingsSaveCache
        bridge.settingsSavePending = { bodyText: payloadB, promise: Promise.resolve(null) };
        await windowObj.fetch('/api/presets/save', { method: 'POST', body: '{"name":"Preset1"}' });
        assert.equal(bridge.settingsSavePending, null, 'mutating routes must clear settingsSavePending');
        assert.equal(bridge.lastSaveInvalidationReason, 'mutation:/api/presets/save');
    } finally {
        closeStEndpointCaches();
        dbManager.closeAll();
    }
});

test('WP-2 Round 2: Early Bridge fast-save monotonic settingsSaveSeq prevents post-dispatch overwrite on network drop / 5xx and blocks superseded 404 fallback', async () => {
    const dbManager = new DatabaseManager();
    try {
        closeStEndpointCaches();
        const harness = createEndpointHarness(dbManager);
        const user = createUserContext('wp2-r2-settings-user');
        const settingsPath = path.join(user.directories.root, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({ active_preset: 'Initial', temp: 0.5 }, null, 4));

        let fastGetCalls = 0;
        let fastSaveCalls = 0;
        let nativeSaveCalls = 0;
        let fastSaveResponder = null;

        const windowObj = {
            location: new URL('http://127.0.0.1:8000/'),
            Response,
            Headers,
            Request,
            Blob,
            URL,
            URLSearchParams,
            TextEncoder,
            TextDecoder,
            Promise,
            setTimeout,
            clearTimeout,
            document: {
                readyState: 'complete',
                body: {},
                addEventListener: () => {},
                documentElement: null,
            },
            fetch: async (input, init = {}) => {
                const url = typeof input === 'string' ? input : input.url;
                const pathname = new URL(url, 'http://127.0.0.1:8000').pathname;
                const rawBody = typeof init.body === 'string'
                    ? init.body
                    : (typeof init.body?._fallbackJson === 'string'
                        ? init.body._fallbackJson
                        : (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)
                            ? new TextDecoder().decode(init.body)
                            : '{}'));

                if (pathname === '/api/plugins/baibaoku/v1/settings/fast-get') {
                    fastGetCalls += 1;
                    const text = fs.readFileSync(settingsPath, 'utf8');
                    return new Response(JSON.stringify({ settings: text, themes: [] }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }

                if (pathname === '/api/plugins/baibaoku/v1/settings/fast-save') {
                    fastSaveCalls += 1;
                    if (fastSaveResponder) {
                        return await fastSaveResponder(rawBody);
                    }
                    const res = await harness.invoke('POST', '/v1/settings/fast-save', {
                        user,
                        body: JSON.parse(rawBody),
                    });
                    const headers = { 'content-type': 'application/json' };
                    if (res.headers.get('x-baibaoku-save-skipped')) {
                        headers['x-baibaoku-save-skipped'] = res.headers.get('x-baibaoku-save-skipped');
                    }
                    return new Response(JSON.stringify(res.body), { status: res.status, headers });
                }

                if (pathname === '/api/settings/save') {
                    nativeSaveCalls += 1;
                    writeFileAtomicSync(settingsPath, JSON.stringify(JSON.parse(rawBody), null, 4), 'utf8');
                    return new Response(JSON.stringify({ result: 'ok' }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }

                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            },
        };
        windowObj.window = windowObj;
        windowObj.globalThis = windowObj;

        const script = makeEarlyBridgeScript({
            settingsAccelerationEnabled: true,
            lazyThemeLoadingEnabled: false,
            characterListAccelerationEnabled: false,
            recentChatListAccelerationEnabled: false,
            tokenizerBulkCountEnabled: false,
            extensionManifestBundleEnabled: false,
            versionAccelerationEnabled: false,
        });
        vm.runInNewContext(script, windowObj);
        const bridge = windowObj.__baibaokuEarlyBridge;
        assert.equal(bridge.settingsSaveSeq, 0);

        // Prime client settingsGetCache
        const initialGet = await (await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' })).json();
        assert.equal(JSON.parse(initialGet.settings).active_preset, 'Initial');
        assert.equal(fastGetCalls, 1);

        // 1a. Exact External Review P1: Save A writes to server, Save B writes & resolves 200, then Save A HTTP response drops!
        let rejectHeldSaveA;
        let markSaveAWritten;
        const saveAWrittenPromise = new Promise(resolve => { markSaveAWritten = resolve; });
        const payloadA = JSON.stringify({ active_preset: 'PresetA', temp: 0.7 });
        const payloadB = JSON.stringify({ active_preset: 'PresetB', temp: 1.1 });

        fastSaveResponder = async (rawBody) => {
            const parsed = JSON.parse(rawBody);
            const res = await harness.invoke('POST', '/v1/settings/fast-save', { user, body: parsed });
            if (parsed.active_preset === 'PresetA') {
                markSaveAWritten();
                return await new Promise((_resolve, reject) => {
                    rejectHeldSaveA = reject;
                });
            }
            return new Response(JSON.stringify(res.body), {
                status: res.status,
                headers: { 'content-type': 'application/json' },
            });
        };

        const saveAPromise = windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadA });
        await saveAWrittenPromise;
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetA');

        const saveBRes = await windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadB });
        assert.equal(saveBRes.ok, true);
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetB');

        // Re-populate client settingsGetCache with B before A's network connection drops
        const cachedBGet = await (await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' })).json();
        assert.equal(JSON.parse(cachedBGet.settings).active_preset, 'PresetB');
        assert.equal(fastGetCalls, 2);
        assert.ok(bridge.settingsGetCache, 'settingsGetCache should hold PresetB prior to A network drop');

        // Drop A's HTTP connection after server write!
        rejectHeldSaveA(new TypeError('Failed to fetch'));
        await assert.rejects(saveAPromise, err => err instanceof TypeError && err.message === 'Failed to fetch');

        assert.equal(nativeSaveCalls, 0, 'post-dispatch network failure must NEVER fall back to /api/settings/save');
        assert.equal(
            JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset,
            'PresetB',
            'persisted settings.json must remain PresetB, never overwritten back to PresetA',
        );
        assert.equal(bridge.settingsGetCache, null, 'post-dispatch network failure must invalidate settingsGetCache');
        assert.equal(bridge.lastInvalidationReason, 'save-network-error');

        const freshAfterDrop = await (await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' })).json();
        assert.equal(fastGetCalls, 3, 'subsequent settings/get must refetch fresh PresetB after invalidation');
        assert.equal(JSON.parse(freshAfterDrop.settings).active_preset, 'PresetB');

        // 1b. Exact External Review P1 (HTTP 500 variant + coalesced followers):
        // Save C (2 coalesced callers) writes C on server, Save D writes D & succeeds, then Save C returns 500 Internal Server Error!
        let resolveHeldSaveC;
        let markSaveCWritten;
        const saveCWrittenPromise = new Promise(resolve => { markSaveCWritten = resolve; });
        const payloadC = JSON.stringify({ active_preset: 'PresetC', temp: 0.3 });
        const payloadD = JSON.stringify({ active_preset: 'PresetD', temp: 0.9 });

        fastSaveResponder = async (rawBody) => {
            const parsed = JSON.parse(rawBody);
            const res = await harness.invoke('POST', '/v1/settings/fast-save', { user, body: parsed });
            if (parsed.active_preset === 'PresetC') {
                markSaveCWritten();
                return await new Promise((resolve) => {
                    resolveHeldSaveC = resolve;
                });
            }
            return new Response(JSON.stringify(res.body), {
                status: res.status,
                headers: { 'content-type': 'application/json' },
            });
        };

        const saveCPromise1 = windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadC });
        const saveCPromise2 = windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadC });
        await saveCWrittenPromise;
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetC');

        const saveDRes = await windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadD });
        assert.equal(saveDRes.ok, true);
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetD');

        await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' });
        assert.ok(bridge.settingsGetCache);

        resolveHeldSaveC(new Response('Internal Server Error', {
            status: 500,
            statusText: 'Internal Server Error',
            headers: { 'content-type': 'text/plain' },
        }));
        const [saveCRes1, saveCRes2] = await Promise.all([saveCPromise1, saveCPromise2]);
        assert.equal(saveCRes1.status, 500);
        assert.equal(saveCRes2.status, 500);
        assert.equal(await saveCRes1.text(), 'Internal Server Error');
        assert.equal(await saveCRes2.text(), 'Internal Server Error');
        assert.equal(nativeSaveCalls, 0, 'HTTP 500 on fast-save must NEVER fall back to /api/settings/save');
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetD');
        assert.equal(bridge.settingsGetCache, null, 'HTTP 500 must invalidate settingsGetCache');
        assert.equal(bridge.lastInvalidationReason, 'save-error');

        // Also verify non-route-missing statuses (400, 401, 403, 502, 503, 504) never call native save even when unsuperseded
        for (const errStatus of [400, 401, 403, 502, 503, 504]) {
            await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' });
            assert.ok(bridge.settingsGetCache);
            fastSaveResponder = async () => new Response(JSON.stringify({ error: errStatus }), {
                status: errStatus,
                headers: { 'content-type': 'application/json' },
            });
            const errRes = await windowObj.fetch('/api/settings/save', {
                method: 'POST',
                body: JSON.stringify({ active_preset: `ShouldNotFallback_${errStatus}` }),
            });
            assert.equal(errRes.status, errStatus);
            assert.equal(nativeSaveCalls, 0, `HTTP ${errStatus} must never fall back to /api/settings/save`);
            assert.equal(bridge.settingsGetCache, null, `HTTP ${errStatus} must invalidate settingsGetCache`);
        }
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetD');

        // 2a. Route-unmounted 404 fallback when NO newer save started (both single and coalesced identical saves)
        await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' });
        assert.ok(bridge.settingsGetCache);

        fastSaveResponder = async () => new Response('Not Found', { status: 404, statusText: 'Not Found' });
        const payloadFallbackSingle = JSON.stringify({ active_preset: 'UnmountedFallbackSingle', temp: 0.6 });
        const single404FallbackRes = await windowObj.fetch('/api/settings/save', {
            method: 'POST',
            body: payloadFallbackSingle,
        });
        assert.equal(single404FallbackRes.status, 200);
        assert.equal(nativeSaveCalls, 1, 'unsuperseded 404 must fall back once to /api/settings/save');
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'UnmountedFallbackSingle');
        assert.equal(bridge.settingsGetCache, null, 'successful fallback save must invalidate settingsGetCache');

        // Coalesced identical saves hitting 404 must fall back to /api/settings/save ONLY ONCE and return unread 200 to both callers
        const payloadFallbackCoalesced = JSON.stringify({ active_preset: 'UnmountedFallbackCoalesced', temp: 0.65 });
        const [coal404Res1, coal404Res2] = await Promise.all([
            windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadFallbackCoalesced }),
            windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadFallbackCoalesced }),
        ]);
        assert.equal(coal404Res1.status, 200);
        assert.equal(coal404Res2.status, 200);
        assert.deepEqual(await coal404Res1.json(), { result: 'ok' });
        assert.deepEqual(await coal404Res2.json(), { result: 'ok' });
        assert.equal(nativeSaveCalls, 2, 'coalesced identical saves hitting 404 must execute native fallback only once');
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'UnmountedFallbackCoalesced');

        // 2b. Superseded 404: Save E is in flight, Save F starts (advancing settingsSaveSeq) and writes PresetF, then E returns 404!
        let resolveHeld404E;
        let markSaveEDispatched;
        const saveEDispatchedPromise = new Promise(resolve => { markSaveEDispatched = resolve; });
        fastSaveResponder = async (rawBody) => {
            const parsed = JSON.parse(rawBody);
            if (parsed.active_preset === 'PresetE_Stale404') {
                markSaveEDispatched();
                return await new Promise((resolve) => {
                    resolveHeld404E = resolve;
                });
            }
            const res = await harness.invoke('POST', '/v1/settings/fast-save', { user, body: parsed });
            return new Response(JSON.stringify(res.body), {
                status: res.status,
                headers: { 'content-type': 'application/json' },
            });
        };

        const stale404Promise = windowObj.fetch('/api/settings/save', {
            method: 'POST',
            body: JSON.stringify({ active_preset: 'PresetE_Stale404' }),
        });
        await saveEDispatchedPromise;

        const newerFRes = await windowObj.fetch('/api/settings/save', {
            method: 'POST',
            body: JSON.stringify({ active_preset: 'PresetF_Newer' }),
        });
        assert.equal(newerFRes.ok, true);
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetF_Newer');

        await windowObj.fetch('/api/settings/get', { method: 'POST', body: '{}' });
        assert.ok(bridge.settingsGetCache);

        const nativeCallsBeforeStale404 = nativeSaveCalls;
        resolveHeld404E(new Response('Not Found', { status: 404, statusText: 'Not Found' }));
        const stale404Res = await stale404Promise;
        assert.equal(stale404Res.status, 404, 'superseded 404 must return 404 without calling native fallback');
        assert.equal(nativeSaveCalls, nativeCallsBeforeStale404, 'superseded 404 must NEVER call /api/settings/save');
        assert.equal(
            JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset,
            'PresetF_Newer',
            'superseded 404 must not clobber PresetF_Newer',
        );
        assert.equal(bridge.settingsGetCache, null);
        assert.equal(bridge.lastInvalidationReason, 'save-superseded');

        // 2c. Pre-dispatch body read failure: superseded pre-dispatch throw must NOT call /api/settings/save
        let rejectBrokenBlob;
        const brokenSlowBlob = Object.create(Blob.prototype);
        brokenSlowBlob.text = () => new Promise((_resolve, reject) => {
            rejectBrokenBlob = reject;
        });
        const fastSaveCallsBeforePreErr = fastSaveCalls;
        const preErrPromise = windowObj.fetch('/api/settings/save', { method: 'POST', body: brokenSlowBlob });

        // Newer save G arrives and succeeds before brokenSlowBlob.text() rejects
        const newerGRes = await windowObj.fetch('/api/settings/save', {
            method: 'POST',
            body: JSON.stringify({ active_preset: 'PresetG_AfterPreError' }),
        });
        assert.equal(newerGRes.ok, true);
        assert.equal(fastSaveCalls, fastSaveCallsBeforePreErr + 1, 'pre-dispatch error must not have dispatched fast-save');

        const nativeCallsBeforePreErr = nativeSaveCalls;
        rejectBrokenBlob(new Error('Blob read failed'));
        await assert.rejects(preErrPromise, /Blob read failed/);
        assert.equal(nativeSaveCalls, nativeCallsBeforePreErr, 'superseded pre-dispatch error must not call native fallback');
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetG_AfterPreError');

        // 2c-ii (S10). Save A(X) in flight -> Save B(Y) throws pre-dispatch & falls back to native -> Save C(X) MUST NOT coalesce onto stale A(X)!
        let resolveHeldAForS10;
        let markADispatchedForS10;
        const aDispatchedForS10 = new Promise(resolve => { markADispatchedForS10 = resolve; });
        const payloadS10X = JSON.stringify({ active_preset: 'PresetX_S10' });
        let xFastSaveCount = 0;
        fastSaveResponder = async (rawBody) => {
            const parsed = JSON.parse(rawBody);
            const res = await harness.invoke('POST', '/v1/settings/fast-save', { user, body: parsed });
            if (parsed.active_preset === 'PresetX_S10' && ++xFastSaveCount === 1) {
                markADispatchedForS10();
                return await new Promise((resolve) => {
                    resolveHeldAForS10 = resolve;
                });
            }
            return new Response(JSON.stringify(res.body), {
                status: res.status,
                headers: { 'content-type': 'application/json' },
            });
        };

        const saveAS10 = windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadS10X });
        await aDispatchedForS10;
        assert.ok(bridge.settingsSavePending, 'Save A(X) populates settingsSavePending');

        // Save B(Y): body.text() throws inside handleFastSettingsSave pre-dispatch while A(X) is STILL in flight,
        // so B(Y) falls back to native /api/settings/save and writes PresetY_S10_Fallback to disk!
        const payloadS10Y = JSON.stringify({ active_preset: 'PresetY_S10_Fallback' });
        const throwingBodyB = Object.create(Blob.prototype);
        throwingBodyB._fallbackJson = payloadS10Y;
        throwingBodyB.text = () => Promise.reject(new Error('Pre-dispatch read failure'));
        const saveBS10Res = await windowObj.fetch('/api/settings/save', { method: 'POST', body: throwingBodyB });
        assert.equal(saveBS10Res.ok, true);
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetY_S10_Fallback');
        assert.equal(bridge.settingsSavePending, null, 'Unsuperseded pre-dispatch catch MUST clear settingsSavePending before native fallback');
        assert.equal(bridge.lastSaveInvalidationReason, 'save-pre-error');

        // Save C(X) now dispatches a fresh fast-save (xFastSaveCount === 2) instead of coalescing onto stale A(X)!
        const saveCS10Res = await windowObj.fetch('/api/settings/save', { method: 'POST', body: payloadS10X });
        assert.equal(saveCS10Res.ok, true);
        assert.equal(xFastSaveCount, 2, 'Save C(X) must dispatch fresh fast-save rather than coalescing onto Save A(X)');
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, 'PresetX_S10');

        resolveHeldAForS10(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        await saveAS10;

        // 2d. Verify 405 and 501 also act as definite pre-write route-unavailable statuses when unsuperseded
        for (const unmountedStatus of [405, 501]) {
            fastSaveResponder = async () => new Response('Route Unavailable', { status: unmountedStatus });
            const prevNative = nativeSaveCalls;
            const fallbackRes = await windowObj.fetch('/api/settings/save', {
                method: 'POST',
                body: JSON.stringify({ active_preset: `Fallback_${unmountedStatus}` }),
            });
            assert.equal(fallbackRes.status, 200);
            assert.equal(nativeSaveCalls, prevNative + 1);
            assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).active_preset, `Fallback_${unmountedStatus}`);
        }
    } finally {
        await new Promise(resolve => setTimeout(resolve, 30));
        closeStEndpointCaches();
        dbManager.closeAll();
    }
});

test('WP-4 Round 2: Legacy V2 character cards without data.name/data.tags match SillyTavern readFromV2 + toShallow parity and rebuild schema=2 SQLite cache', async () => {
    assert.equal(FAST_CHARACTER_CACHE_SCHEMA, 3, 'FAST_CHARACTER_CACHE_SCHEMA must be bumped to 3');

    // Load SillyTavern's real pure `readFromV2`, `toShallow`, and `calculateDataSize` functions directly from characters.js
    const lodashMod = await import(pathToFileURL(path.join(stRepoRoot, 'node_modules/lodash/lodash.js')).href);
    const _ = lodashMod.default;
    const { humanizedDateTime } = await import(pathToFileURL(path.join(stRepoRoot, 'src/util.js')).href);
    const stCharactersSource = fs.readFileSync(path.join(stRepoRoot, 'src/endpoints/characters.js'), 'utf8');
    const calcMatch = stCharactersSource.match(/const calculateDataSize = \(data\) => \{[\s\S]*?\n\};/);
    const shallowMatch = stCharactersSource.match(/const toShallow = \(character\) => \{[\s\S]*?\n\};/);
    const readFromV2Match = stCharactersSource.match(/function readFromV2\(char\) \{[\s\S]*?\n\}/);
    assert.ok(calcMatch && shallowMatch && readFromV2Match, 'expected ST characters.js helpers to be extractable');

    const buildStHelpers = new Function(
        '_',
        'humanizedDateTime',
        'console',
        `${calcMatch[0]}\n${shallowMatch[0]}\n${readFromV2Match[0]}\nreturn { stReadFromV2: readFromV2, stToShallow: toShallow, stCalculateDataSize: calculateDataSize };`,
    );
    const { stReadFromV2, stToShallow, stCalculateDataSize } = buildStHelpers(
        _,
        humanizedDateTime,
        { warn: () => {}, info: () => {}, error: () => {} },
    );

    const runStNativeShallow = (rawCard, filename, stat) => {
        const cloned = structuredClone(rawCard);
        const v2Obj = stReadFromV2(cloned);
        v2Obj.avatar = filename;
        v2Obj.date_added = stat.ctimeMs;
        v2Obj.create_date = v2Obj.create_date || new Date(Math.round(stat.ctimeMs)).toISOString();
        v2Obj.chat_size = 0;
        v2Obj.date_last_chat = 0;
        v2Obj.data_size = stCalculateDataSize(v2Obj?.data);
        if (!v2Obj.name) {
            return null;
        }
        const shallow = stToShallow(v2Obj);
        // ST's readFromV2 omits `return` after `char.fav = false` when `extensions.fav` is undefined,
        // leaving `fav: undefined` in JS memory (which omits `fav` in JSON); BaiBaoKu normalizes `fav` to boolean.
        shallow.fav = shallow.fav === true || shallow.fav === 'true';
        shallow.data.extensions.fav = shallow.data.extensions.fav === true || shallow.data.extensions.fav === 'true';
        return shallow;
    };

    const dbManager = new DatabaseManager();
    try {
        closeStEndpointCaches();
        const harness = createEndpointHarness(dbManager);
        const user = createUserContext('wp4-r2-legacy-v2-user');
        const { characters: charactersDir, chats: chatsDir } = user.directories;
        const fakeStat = { ctimeMs: 1_720_000_000_000, mtimeMs: 1_720_000_000_000, size: 1024 };

        // 1. Legacy V2 card with root name/tags and V2 `data` missing `data.name` and `data.tags`
        const legacyRootAliceCard = {
            name: 'LegacyRootAlice',
            tags: ['classic', 'v1-root'],
            chat: 'LegacyRootAlice - 2026-01-01@00h00m00s000ms',
            create_date: '2026-01-01T00:00:00.000Z',
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                description: 'Has V2 data without data.name or data.tags',
            },
        };
        const bbkAliceShallow = await formatShallowCharacter(
            'LegacyRootAlice.png',
            fakeStat,
            JSON.stringify(legacyRootAliceCard),
            chatsDir,
            null,
        );
        const stAliceShallow = runStNativeShallow(legacyRootAliceCard, 'LegacyRootAlice.png', fakeStat);
        assert.ok(bbkAliceShallow, 'formatShallowCharacter must preserve legacy V2 card with root name');
        assert.equal(bbkAliceShallow.name, 'LegacyRootAlice');
        assert.deepEqual(bbkAliceShallow.tags, ['classic', 'v1-root']);
        assert.equal(bbkAliceShallow.fav, false);
        assert.equal(bbkAliceShallow.data.name, '');
        assert.deepEqual(bbkAliceShallow.data.tags, []);
        assert.equal(bbkAliceShallow.data.extensions.fav, false);
        const { _chatStats: _ignoredStats1, ...bbkAlicePublic } = bbkAliceShallow;
        assert.deepEqual(bbkAlicePublic, stAliceShallow, 'BaiBaoKu shallow output must match ST readFromV2 + toShallow field-for-field');

        // 2. V2 card missing `data` object entirely (`isV2 && !hasV2Data`) with root `fav: true`
        const rootOnlyV2Card = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'RootOnlyV2',
            fav: true,
            tags: ['solo'],
            chat: 'RootOnlyV2 - fixed',
            create_date: '2026-01-02T00:00:00.000Z',
        };
        const bbkRootOnlyShallow = await formatShallowCharacter(
            'RootOnlyV2.png',
            fakeStat,
            JSON.stringify(rootOnlyV2Card),
            chatsDir,
            null,
        );
        const stRootOnlyShallow = runStNativeShallow(rootOnlyV2Card, 'RootOnlyV2.png', fakeStat);
        assert.ok(bbkRootOnlyShallow);
        const { _chatStats: _ignoredStats2, ...bbkRootOnlyPublic } = bbkRootOnlyShallow;
        assert.deepEqual(bbkRootOnlyPublic, stRootOnlyShallow, 'isV2 && !hasV2Data shallow output must match ST readFromV2 + toShallow');

        // 3. Card with explicit `data.name: ""` MUST still return null even if root `name` is non-empty
        const explicitEmptyDataNameCard = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'IgnoredRootBecauseDataNameDefinedAsEmpty',
            data: {
                name: '',
                description: 'Explicit empty V2 name',
            },
        };
        const explicitEmptyResult = await formatShallowCharacter(
            'ExplicitEmpty.png',
            fakeStat,
            JSON.stringify(explicitEmptyDataNameCard),
            chatsDir,
            null,
        );
        assert.equal(explicitEmptyResult, null, 'explicit data.name="" must not fall back to root name');
        assert.equal(runStNativeShallow(explicitEmptyDataNameCard, 'ExplicitEmpty.png', fakeStat), null);

        // 4. End-to-end /v1/characters/fast-all + persisted schema=2 SQLite cache invalidation and rebuild under schema=3
        writeV2CardPng(path.join(charactersDir, 'LegacyRootAlice.png'), legacyRootAliceCard);
        writeV2CardPng(path.join(charactersDir, 'ExplicitEmpty.png'), explicitEmptyDataNameCard);

        const aliceFileStat = fs.statSync(path.join(charactersDir, 'LegacyRootAlice.png'));
        const reqCtx = { user };
        await dbManager.openForRequest(reqCtx, 'baibaoku.internal', {
            displayName: '柏宝库内部缓存',
            version: 1,
        });
        // Seed stale schema=2 entry with wrong/stale name & tags (and matching mtime/size so ONLY schema=3 bump forces rebuild!)
        await dbManager.set(reqCtx, 'baibaoku.internal', 'character-fast-all', 'LegacyRootAlice.png', {
            schema: 2,
            mtime: aliceFileStat.mtimeMs,
            size: aliceFileStat.size,
            data: {
                shallow: true,
                name: 'StaleSchema2Name',
                avatar: 'LegacyRootAlice.png',
                tags: [],
                data: { name: 'StaleSchema2Name', tags: [], extensions: { fav: false, world: '' } },
            },
        });
        await dbManager.set(reqCtx, 'baibaoku.internal', 'character-fast-all', 'GhostSchema2.png', {
            schema: 2,
            mtime: aliceFileStat.mtimeMs,
            size: aliceFileStat.size,
            data: {
                shallow: true,
                name: 'GhostSchema2',
                avatar: 'GhostSchema2.png',
            },
        });
        closeStEndpointCaches();

        const fastAllRes = await harness.invoke('POST', '/v1/characters/fast-all', { user });
        assert.equal(fastAllRes.status, 200);
        assert.deepEqual(
            fastAllRes.body.map(c => c.avatar),
            ['LegacyRootAlice.png'],
            'fast-all must include LegacyRootAlice.png and omit ExplicitEmpty.png & purged GhostSchema2.png',
        );
        assert.equal(fastAllRes.body[0].name, 'LegacyRootAlice', 'schema=2 entry must be invalidated and rebuilt');
        assert.deepEqual(fastAllRes.body[0].tags, ['classic', 'v1-root']);
        assert.equal(fastAllRes.body[0].data.name, '');
        assert.deepEqual(fastAllRes.body[0].data.tags, []);

        const persistedAlice = await dbManager.get(reqCtx, 'baibaoku.internal', 'character-fast-all', 'LegacyRootAlice.png');
        assert.equal(persistedAlice.exists, true);
        assert.equal(persistedAlice.value.schema, 3, 'rebuilt SQLite entry must be persisted with schema=3');
        assert.equal(persistedAlice.value.data.name, 'LegacyRootAlice');

        const persistedGhost = await dbManager.get(reqCtx, 'baibaoku.internal', 'character-fast-all', 'GhostSchema2.png');
        assert.equal(persistedGhost.exists, false, 'stale schema=2 entry must be deleted from SQLite');
    } finally {
        closeStEndpointCaches();
        dbManager.closeAll();
    }
});



