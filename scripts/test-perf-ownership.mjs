import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const stRootFromSymlink = path.resolve(pluginRoot, '..', '..');
const stRepoRoot = fs.existsSync(path.join(stRootFromSymlink, '.git'))
    ? stRootFromSymlink
    : path.dirname(fs.realpathSync(path.join(stRootFromSymlink, 'public')));

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
const {
    SETTINGS_CACHE_INVALIDATE_PREFIXES,
    SETTINGS_CACHE_READONLY_PATHS,
    closeStEndpointCaches,
    countSingleMessageBulk,
    hasActiveLazyThemeHydrator,
    makeEarlyBridgeScript,
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

test('WP-K-4: hasActiveLazyThemeHydrator caches extension scans for 30s, avoids sync power-user reads, and respects live disabledExtensions', () => {
    const extRoot = path.join(tmpRoot, 'theme-hydrator-exts');
    const globalRoot = path.join(tmpRoot, 'theme-hydrator-global');
    fs.mkdirSync(extRoot, { recursive: true });
    fs.mkdirSync(globalRoot, { recursive: true });

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

    // Add ST-BaiBai-Tools and another extension on disk
    const toolsDir = path.join(extRoot, 'ST-BaiBai-Tools');
    const otherExtDir = path.join(extRoot, 'other-ext');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(otherExtDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'manifest.json'), JSON.stringify({ display_name: '柏宝箱', js: 'dist/index.js' }));
    fs.writeFileSync(path.join(otherExtDir, 'manifest.json'), JSON.stringify({ display_name: 'Other', js: 'index.js' }));

    // Within 30s TTL (t0 + 10s), cached empty scan still holds; after TTL expires (t0 + 31s), rescans and returns true
    assert.equal(
        hasActiveLazyThemeHydrator(req, '{}', {
            globalExtensionsDir: globalRoot,
            powerUserPath: powerUserWithBridge,
            extensionsEnabled: true,
            now: t0 + 10_000,
        }),
        false,
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
        // 2. TTL expired at t0 + 31s -> rescans directories once, returns true
        const t1 = t0 + 31_000;
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t1,
            }),
            true,
        );
        assert.ok(readdirCalls > 0, 'expired TTL should trigger directory rescan');

        // 3. Repeated calls within 30s (t1 + 5s) trigger ZERO readdirSync and ZERO readFileSync
        readdirCalls = 0;
        readFileCalls = 0;
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: true,
                now: t1 + 5_000,
            }),
            true,
        );
        assert.equal(readdirCalls, 0, 'repeated call within 30s must not call readdirSync');
        assert.equal(readFileCalls, 0, 'repeated call within 30s must not call readFileSync');

        // 4. Disabling Tools in settingsText immediately returns false (disabledExtensions is never cached):
        //    extRoot hits cache (0 IO), globalRoot's t0 cache expired so it rescans once, then subsequent calls do 0 IO.
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
                now: t1 + 6_000,
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
                now: t1 + 6_500,
            }),
            false,
        );
        assert.equal(readdirCalls, 0);
        assert.equal(readFileCalls, 0);

        // 5. Global extensionsEnabled === false -> false
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserWithBridge,
                extensionsEnabled: false,
                now: t1 + 7_000,
            }),
            false,
        );

        // 6. Anchor mismatch recorded by installThemeBridge -> returns false with zero sync IO
        assert.equal(
            hasActiveLazyThemeHydrator(req, '{}', {
                globalExtensionsDir: globalRoot,
                powerUserPath: powerUserAnchorMismatch,
                extensionsEnabled: true,
                now: t1 + 8_000,
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
