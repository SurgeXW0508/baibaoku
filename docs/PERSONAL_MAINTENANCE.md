# 柏宝库 Personal Fork 维护与 NAS 更新

本文是 `SurgeXW0508/baibaoku` 的个人维护与部署操作说明。能力归属和三仓库兼容原则以 [SillyTavern Personal 维护规范](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md) 为唯一准则；本文只记录柏宝库自身的分支、部署和更新方法。

## 1. 项目定位与部署方式

柏宝库是 SillyTavern **Server Plugin**，不是浏览器第三方扩展，也不是 Docker 镜像内置代码。

当前 NAS 部署关系（2026-11-12 用户提供的实机核验）：

| 项目 | 实际位置 / 状态 |
| --- | --- |
| NAS 宿主机目录 | `/vol3/1000/SillyTavern/plugins/baibaoku` |
| 容器内目录 | `/home/node/app/plugins/baibaoku` |
| Docker 挂载 | 宿主机 `plugins` 目录挂载到 `/home/node/app/plugins`，读写 |
| Server Plugin 开关 | `enableServerPlugins: true` |
| Server Plugin 自动更新 | `enableServerPluginsAutoUpdate: false` |
| NAS 当前 Git HEAD（2026-11-12 快照） | `4814830f2d161dfff89e75370effa31d669586d9`（`personal/stable`，NAS 尚未执行后续拉取） |
| GitHub origin/personal/stable | 已合入个人分支 Runtime 加固（如 `61aae569` / Runtime `9d9854ca`），每次更新前先 `git fetch` 读取实时 HEAD |
| NAS 当前运行代码基线 | `b211a4e97fdaec24dc8b90c85ddc198fac9ac200`（`0.7.3`，2026-11-12 切换时仅检出文档提交） |
| NAS 当前 Git 状态 | `personal/stable`，跟踪 `origin/personal/stable`，工作区干净 |
| NAS 当前 origin | `https://github.com/SurgeXW0508/baibaoku.git`（个人 Fork） |
| NAS 当前 upstream | `https://github.com/baibai-git/baibaoku.git`（原作者） |
| 本地备份分支 | `backup/pre-personal-stable-20261112`，指向原 Runtime 基线 `b211a4e9` |
| NAS 本地 main（2026-11-12 快照） | 跟踪 `upstream/main`，非生产分支，不参与部署（GitHub 个人 Fork `main` 已同步至上游 `0.7.4`） |

因此，更新柏宝库的 Git 文件不会要求重新构建 SillyTavern Docker 镜像；但 Server Plugin 已在 Node 进程启动时加载，更新后必须重启 SillyTavern 容器，并刷新浏览器页面。

柏宝库数据保存在 SillyTavern 的用户数据目录（`data/<user>/baibaoku/`），不在插件 Git 工作区内。更新插件时不得删除、覆盖或重建这些数据库目录。

## 2. GitHub Fork 分支职责

个人仓库：[`SurgeXW0508/baibaoku`](https://github.com/SurgeXW0508/baibaoku)

| 分支 | 职责 | 规则 |
| --- | --- | --- |
| `main` | 上游同步镜像 | 只同步 `baibai-git/baibaoku:main`，不放个人 Runtime 改动 |
| `personal/stable` | NAS 生产分支 | 唯一允许部署到 NAS 的分支；更新前必须完成兼容审查和测试 |

`personal/stable` 于 2026-11-12 从个人 Fork 的 `main` 创建（初始基线 `b211a4e97fdaec24dc8b90c85ddc198fac9ac200`），并于同日在 NAS 完成 remote/branch 切换（检出仅含维护文档的 `4814830f2d161dfff89e75370effa31d669586d9`，当时未改动运行期代码或重启容器）。自 2026-11-13 起，GitHub `personal/stable`（如 `61aae569` / Runtime `9d9854ca`）及候选分支（如 `candidate/baibai-0.7.4`）**已包含经审查的个人 Runtime 与前端桥接加固改动**，不再与上游 Runtime 等价；待三库统一发版节点再按第 4 节定向拉取并重启容器。

### 上游更新流程

> 酒馆、柏宝箱与柏宝库按三位一体自维护：上游有更新时严禁直接照搬（copy）合并，必须先对照三库自维护改动核验一致性与安全同步边界，设计好合入方案后再实施。

1. 在 GitHub 将原作者 `baibai-git/baibaoku:main` 同步到个人 Fork 的 `main`。不要直接更新 NAS。
2. 对比旧 `main`、新 `main` 与当前个人三库改动，检查变更是否影响 ST Core、柏宝箱、Server Plugin 生命周期、数据库格式/迁移、依赖、正则桥接和自更新行为，先敲定安全合入方案再动手。
3. 阅读上述 ST canonical 维护规范，完成 Capability Ownership Review；不得仅因上游版本号增加就升级。
4. 在候选分支运行仓库现有测试，至少覆盖本次改动涉及的测试；检查 `package.json` / lockfile、运行时依赖及数据库兼容性。
5. 审查通过后，将变更以可快进方式推进到 `personal/stable`。不要 force-push、rebase 或重写已经公开并被 NAS 跟踪的 stable 历史。
6. 只有用户明确决定部署时，才更新 NAS。

## 3. NAS 一次性分支整理（2026-11-12 历史记录，已完成）

2026-11-12 已通过 NAS SSH 完成一次性 Git 跟踪关系整理。执行前确认：HEAD 为 `b211a4e97fdaec24dc8b90c85ddc198fac9ac200`、工作区干净、原 origin 为原作者仓库，且当时个人 Fork 的 `personal/stable` 相对该基线只有维护文档差异。

2026-11-12 切换完成时的 NAS 本地快照：

- `origin` → `https://github.com/SurgeXW0508/baibaoku.git`。
- `upstream` → `https://github.com/baibai-git/baibaoku.git`。
- 当前分支 → `personal/stable`，跟踪 `origin/personal/stable`。
- NAS 本地 HEAD → `4814830f2d161dfff89e75370effa31d669586d9`。
- 工作区 → clean。
- 备份分支 → `backup/pre-personal-stable-20261112`，保留原始 Runtime 基线 `b211a4e9`。
- NAS 本地 `main` 为非生产分支，不参与当前部署。

2026-11-12 当天仅切换 Git remote/分支并检出文档提交，未安装依赖、修改数据库或重启容器。此后 GitHub `origin/personal/stable` 已推进合入个人 Runtime 加固提交，任何后续 NAS 更新前均须先 `git fetch` 审查实际代码差异，并按第 4 节重启容器生效。

## 4. 日常 NAS 更新（当前分支关系已就绪）

日常更新尽量通过飞牛 OS Docker 图形界面，不再 SSH 登录 NAS。

前置条件必须全部成立：

- 当前目录为 `/home/node/app/plugins/baibaoku`。
- 当前分支为 `personal/stable`。
- `origin` 指向 `SurgeXW0508/baibaoku`。
- 工作区干净。
- GitHub 的 `personal/stable` 已通过审查并包含本次准备部署的提交。

操作：

1. 飞牛 OS → Docker → 容器 → `sillytavern` → 打开容器终端。
2. 先检查状态：

   ```bash
   git -C /home/node/app/plugins/baibaoku status --short --branch
   git -C /home/node/app/plugins/baibaoku remote -v
   git -C /home/node/app/plugins/baibaoku branch --show-current
   ```

3. 只有工作区干净、分支和 origin 都符合前置条件时，才执行针对柏宝库的更新：

   ```bash
   git -C /home/node/app/plugins/baibaoku pull --ff-only origin personal/stable
   ```

4. 检查本次提交是否改变 `package.json` 或 lockfile。只有运行时依赖确实变化时，才在插件目录按仓库安装说明执行生产依赖安装（当前 README 使用 `npm install --omit=dev`）。依赖安装失败时停止，不要继续重启并假定更新成功。
5. 回到飞牛 OS Docker 图形界面，重启 `sillytavern` 容器。不要只刷新浏览器；Server Plugin 代码在 Node 进程启动时加载。
6. 浏览器刷新后检查 `/api/plugins/baibaoku/v1/status`，确认 `ok`、版本号和数据库驱动状态，再做本次改动涉及的最小功能验证。

**不要使用 `node /home/node/app/plugins.js update` 作为柏宝库的日常单独更新命令。** SillyTavern 原生脚本会遍历并更新 `plugins` 目录下的所有 Git Server Plugin，不只更新柏宝库。针对单个插件使用上面的显式 `git pull --ff-only origin personal/stable`，更新范围更清楚。

## 5. 自动更新与重启边界

生产配置保持：

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

该开关是 SillyTavern 的全局 Server Plugin 自动更新开关。开启它可能同时更新其他 Server Plugin；柏宝库自己的启动自更新也读取这个配置。因此不为了柏宝库单独更新而开启全局自动更新。

柏宝库的 `index.js` 在插件初始化时加载主模块，并在启动阶段幂等检查/注入 5 处宿主前端桥接（`public/index.html` 早期桥接、`public/scripts/power-user.js` 主题桥、`public/scripts/extensions/regex/engine.js` 正则桥、`public/scripts/openai.js` 与 `public/scripts/world-info.js` Tokenizer 桥）；因此更新柏宝库或升级酒馆镜像后必须重启 SillyTavern 容器、确认 `/api/plugins/baibaoku/v1/status` 各项桥接状态正常，并完整刷新浏览器页面。

## 6. 回滚与数据安全

- 部署前记录当前稳定 commit，并确认用户数据备份策略；插件代码回滚与数据库恢复是两件事。
- 普通回滚优先通过一个经过审查的 revert commit 推进 `personal/stable`，再按日常流程更新 NAS。
- 不要为了回滚而 force-push stable、随意 `reset --hard`，或删除 `data/<user>/baibaoku/`。
- 如果本次版本涉及数据库 schema 或数据迁移，必须先单独评估迁移是否可逆、旧代码能否读取新数据；不能仅凭 Git 回退认定数据可回滚。
- 不得把容器重启成功或状态 API 返回成功，等同于完整业务验收。

## 7. 扩展管理接管安全默认值与主题懒加载说明

跨仓库能力归属以 [SillyTavern Personal 维护规范](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md) 为准，柏宝库在个人分支上的运行期默认边界如下：

- **扩展版本决定权与代理兼容**：
  - `allowUnverifiedMirrorDecision` 默认 `false`：安装、更新扩展与启动自更新时，必须有**权威线路**（直连 GitHub 或经本地/配置代理访问 GitHub）确认目标提交 SHA；若仅有第三方镜像可达而直连与代理均不可达，默认拒绝更新并提示“仅镜像可达，无法确认版本”。权威线路确认目标 SHA 后，一致的镜像仍可作为下载通道加速拉取 Git 对象。确需在无代理纯镜像环境临时放开时，可显式配置 `allowUnverifiedMirrorDecision: true`。
  - `cloudMirrorsEnabled` 默认 `false`：默认不拉取第三方云端镜像列表兜底。
  - 代理自动探测保持开启（`autoDetectProxy: true`），继续识别环境变量、酒馆 `requestProxy`、Git `http.proxy` 以及本机常用端口 `7890 / 7897 / 10809 / 1080`（兼容 mihomo 等代理场景），且探测阶段保证快速响应的镜像不会提前中止尚未返回的权威代理探测。
- **个人分支保护、完整跟踪关系核验与同名分支推断（方案 A + `FX3-2`）**：
  - `system` 与 `builtin` 双 Git 适配器统一同时读取并核验 `branch.<name>.remote` 与 `branch.<name>.merge`，由单一 `resolveTrackedBranch` 同时约束版本检查与实际更新：显式跟踪非 `origin` 远端（如 `upstream/...` 或本地非 `origin` 引用）在所有分支上一律报 `UNSUPPORTED_UPSTREAM` 拦截，绝不从 `origin` 误拉取或改写用户配置；仅保留 `merge` 缺失 `remote`、仅保留 `remote=origin` 缺失 `merge`、引用前缀不合法或重复配置等残缺状态一律报 `NO_UPSTREAM` 拦截（绝不落入同名分支推断）。
  - `personal/*` 分支（如 `personal/stable`）**必须**具备完整的 `origin` 上游跟踪关系（`remote=origin` + `refs/heads/<branch>`，或 `remote=.` + `refs/remotes/origin/<branch>`），且跟踪分支名必须与当前 `personal/*` 分支一致；完全缺失上游或远端不存在该受保护分支时一律报 `NO_UPSTREAM` / `BRANCH_PROTECTED` 拦截，游离 `HEAD` 同样报 `NO_UPSTREAM`。
  - 仅在 `branch.<name>.remote` 与 `branch.<name>.merge` **同时未配置**的非 `personal/*` 合法分支上，当**权威线路**确认远端存在 `origin/<同名分支>` 时才允许按同名分支检查或更新，并在更新成功后自动补写 `branch.<name>.remote`、`branch.<name>.merge` 与 `remote.origin.fetch`（`system` 与 `builtin` 双后端一致）；若远端不存在同名分支，仍报 `NO_UPSTREAM` 拦截。
  - 任何情况下（包括 `force: true` 强制更新）都**不会**自动切回远端默认分支（如 `main`），避免误切回未裁剪的上游主线；提示信息仅展示相对扩展路径（`extensions/<folder>` 或 `public/scripts/extensions/third-party/<folder>`）。
- **主题懒加载耦合、扩展 Manifest 缓存与设置缓存凭据边界**：
  - 主题懒加载由柏宝库在读取设置时剥离非当前主题、柏宝箱前端切换主题时按需水合共同实现。柏宝库在进程内记录 `power-user.js` 主题桥安装状态，并对扩展目录扫描结果以目录 `mtimeMs` 校验配合 30 秒 TTL 兜底缓存（`FX2-1`，禁用列表每次实时从设置解析；世界书 Tokenizer 桥接宏门控同步覆盖旧式 `<CHARIFNOTGROUP>/<GROUP>`，`FX2-2`，详以 ST canonical 规范为准）；检测到未安装/刚卸载/已禁用柏宝箱（`ST-BaiBai-Tools`）或未安装主题桥时，会自动立即回退下发完整主题列表，避免单独禁用或卸载柏宝箱后无法切换主题。
  - `early-bridge` 仅拦截扩展根目录 `/scripts/extensions/third-party/<扩展>/manifest.json`；缓存未命中或扩展子目录内的 `manifest.json` 一律交还酒馆原生静态路由，不伪造 404（`0.7.4`）。同时完全移除对 `window.MutationObserver` 的键盘扫描包装（交由酒馆原生 `keyboard.js` 唯一负责，`chatKeyboardScanReductionEnabled` 固定返回 `false` 并在桥接态同步暴露 `initialFastConfig`），移除客户端基于 32 位哈希的跨请求 `/api/settings/save` 缓存跳过（仅保留并发同体请求合并，交由后端精确字节比对落盘）；快速设置保存通过单调序号 `settingsSaveSeq` 与独立 `handleFastSettingsSave` 隔离——请求一旦向 `/v1/settings/fast-save` 发出，网络中断、`5xx` 等不确定落盘状态一律清空 `settingsGetCache` 并原样报错/返回，**绝不**自动回退重发 `/api/settings/save` 覆盖后续已保存的新设置；派发前构造异常同样在未被更新序号取代时清空残留 `settingsSavePending` 后再回退原生保存（`S10`），避免后续恢复旧值的同体保存被旧缓存短路。
  - **快速列表与酒馆原生契约严格对齐（`WP-3` + `WP-4` + `S8`/`S9`）**：`/v1/characters/fast-all` 按每角色 `chats/<角色>` 子目录 `mtimeMs`（含目录删除重置归零）增量校验聊天统计而不再依赖 POSIX 下不会变动的顶层 `chats/` `mtimeMs`，严格对齐酒馆 `readFromV2` + `toShallow` 的旧版 V2 卡根级 `name`/`tags` 回退（`data.name`/`data.tags` 为 `undefined` 时保留根字段，`FAST_CHARACTER_CACHE_SCHEMA = 3` 自动重建旧 SQLite 缓存）、`fav` V2 布尔优先级、`data_size`、`date_added` 与损坏/无名卡剔除及缓存驱逐；`/v1/chats/fast-recent`、`/v1/chats/fast-search` 与 `/v1/chat-backups/fast-list` 共享统一尾行解析（`FAST_SEARCH_CACHE_SCHEMA = 3`、`CHAT_BACKUP_CACHE_SCHEMA = 3`），对非单聊请求强校验 `avatar_url` 单段文件名与 `chats` 根目录包含边界（拒绝 `.`/`..`/空串/路径逃逸并返回 HTTP 400，`S8`），严格对齐酒馆原生 `getChatInfo` 的尾部空行视为空聊天（`[The chat is empty]`）、非空损坏尾行降级预览（`[The message is empty]` + 数值 `stats.mtimeMs` 时间戳）与未强转 `send_date`（`S9`），并回收已删群聊文件缓存；已退役的 `/v1/chats/fast-get` 仅保留 `410 Gone` 响应。
  - `data/<user>/baibaoku/cache/` 中的设置快速载荷缓存会镜像 `extension_settings`（包括柏宝箱内置柏宝砚 / 共享渠道 `baibai_api_channels` 的副渠道明文 API Key），与同用户目录 `settings.json` 处于同一信任边界；副渠道建议使用低权限/限额 Key（个人版柏宝砚仅走显式副渠道，详见柏宝箱 Runbook），备份迁移或导出排障前按敏感凭据同等保护。

## 8. 大阶段收口时的部署交接

仅在**大阶段或完整大功能节点完成实现、测试与审查并具备部署评估条件**（或用户主动询问部署）时，在交接结尾明确：

1. 本次变更是否影响 NAS Runtime；若整项独立任务仅为文档/测试变更，简要说明无需更新 NAS 即可。
2. 变更是否已进入 `personal/stable`；若尚未进入，不能声称可以直接部署。
3. 当前 NAS 预计从哪个 commit 更新到哪个 commit。
4. 询问用户是否现在更新 NAS；提供飞牛 Docker 容器终端的**定向更新命令**、必要的依赖安装步骤和图形化重启/验收步骤。

在中间讨论、小功能子步骤、候选修复迭代或用户已明确延后统一发布的阶段内，无需机械重复附带上述部署提示。任何情况下只提供更新建议，不自动更新 NAS、不自动重启、不自动修改生产数据；必须取得用户明确授权后才能执行部署操作。
