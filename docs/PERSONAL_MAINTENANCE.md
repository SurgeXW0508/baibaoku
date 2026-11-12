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
| NAS 当前 Git HEAD | `4814830f2d161dfff89e75370effa31d669586d9`（personal/stable） |
| GitHub origin/personal/stable | 每次更新前先 fetch 并读取实时 HEAD；不要依赖文档中记录的历史 SHA |
| NAS Runtime 基线 | `b211a4e97fdaec24dc8b90c85ddc198fac9ac200`（0.7.3；后续差异仅文档） |
| NAS 当前 Git 状态 | `personal/stable`，跟踪 `origin/personal/stable`，工作区干净 |
| NAS 当前 origin | `https://github.com/SurgeXW0508/baibaoku.git`（个人 Fork） |
| NAS 当前 upstream | `https://github.com/baibai-git/baibaoku.git`（原作者） |
| 本地备份分支 | `backup/pre-personal-stable-20261112`，指向原 Runtime 基线 |
| 本地 main | 跟踪 `upstream/main`，当前落后 4 个提交；不参与生产部署 |

因此，更新柏宝库的 Git 文件不会要求重新构建 SillyTavern Docker 镜像；但 Server Plugin 已在 Node 进程启动时加载，更新后必须重启 SillyTavern 容器，并刷新浏览器页面。

柏宝库数据保存在 SillyTavern 的用户数据目录（`data/<user>/baibaoku/`），不在插件 Git 工作区内。更新插件时不得删除、覆盖或重建这些数据库目录。

## 2. GitHub Fork 分支职责

个人仓库：[`SurgeXW0508/baibaoku`](https://github.com/SurgeXW0508/baibaoku)

| 分支 | 职责 | 规则 |
| --- | --- | --- |
| `main` | 上游同步镜像 | 只同步 `baibai-git/baibaoku:main`，不放个人 Runtime 改动 |
| `personal/stable` | NAS 生产分支 | 唯一允许部署到 NAS 的分支；更新前必须完成兼容审查和测试 |

`personal/stable` 于 2026-11-12 从个人 Fork 的 `main` 创建，初始Runtime基线为 `b211a4e97fdaec24dc8b90c85ddc198fac9ac200`。随后新增的 Runbook、AGENTS 和 README 都是文档变更；相对初始基线的差异仅限 `AGENTS.md`、`README.md` 和 `docs/PERSONAL_MAINTENANCE.md`，Runtime仍与上游等价。2026-11-12 已完成 NAS 一次性切换，当前Git HEAD为 `4814830f2d161dfff89e75370effa31d669586d9`；本次仅切换 remote/branch 元数据并检出文档提交，没有更新 Runtime 文件或重启容器。

### 上游更新流程

1. 在 GitHub 将原作者 `baibai-git/baibaoku:main` 同步到个人 Fork 的 `main`。不要直接更新 NAS。
2. 对比旧 `main` 与新 `main`，检查变更是否影响 ST Core、柏宝箱、Server Plugin 生命周期、数据库格式/迁移、依赖、正则桥接和自更新行为。
3. 阅读上述 ST canonical 维护规范，完成 Capability Ownership Review；不得仅因上游版本号增加就升级。
4. 在候选分支运行仓库现有测试，至少覆盖本次改动涉及的测试；检查 `package.json` / lockfile、运行时依赖及数据库兼容性。
5. 审查通过后，将变更以可快进方式推进到 `personal/stable`。不要 force-push、rebase 或重写已经公开并被 NAS 跟踪的 stable 历史。
6. 只有用户明确决定部署时，才更新 NAS。

## 3. NAS 一次性分支整理（已完成）

2026-11-12 已通过 NAS SSH 完成一次性 Git 跟踪关系整理。执行前确认：HEAD 为 `b211a4e97fdaec24dc8b90c85ddc198fac9ac200`、工作区干净、原 origin 为原作者仓库，且个人 Fork 的 `personal/stable` 相对该基线只有维护文档差异。

完成后的实际状态：

- `origin` → `https://github.com/SurgeXW0508/baibaoku.git`。
- `upstream` → `https://github.com/baibai-git/baibaoku.git`。
- 当前分支 → `personal/stable`，跟踪 `origin/personal/stable`。
- 当前 HEAD → `4814830f2d161dfff89e75370effa31d669586d9`。
- 工作区 → clean。
- 备份分支 → `backup/pre-personal-stable-20261112`，保留原始 Runtime 基线 `b211a4e9`。
- 本地 `main` 仍跟踪 `upstream/main`，落后 4 个提交；它不是生产分支，不影响当前部署。

本次只改变 Git remote、分支和检出的文档版本。生产 Runtime 与原 `b211a4e9` 完全相同；没有安装依赖、修改数据库、重启或重新构建 Docker。原有数据库和插件配置均未触碰。 当前 GitHub `origin/personal/stable` 还包含 NAS 本地 HEAD 之后的维护文档提交；这些差异仅涉及本 Runbook，不涉及 Runtime。任何后续更新前先 fetch 并审查实际差异。

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

柏宝库的 `index.js` 在插件初始化时加载主模块；更新后必须重启 SillyTavern。部分版本还会在启动阶段向 ST 的正则引擎文件注入桥接代码，所以更新后应确认桥接状态，并刷新浏览器页面。

## 6. 回滚与数据安全

- 部署前记录当前稳定 commit，并确认用户数据备份策略；插件代码回滚与数据库恢复是两件事。
- 普通回滚优先通过一个经过审查的 revert commit 推进 `personal/stable`，再按日常流程更新 NAS。
- 不要为了回滚而 force-push stable、随意 `reset --hard`，或删除 `data/<user>/baibaoku/`。
- 如果本次版本涉及数据库 schema 或数据迁移，必须先单独评估迁移是否可逆、旧代码能否读取新数据；不能仅凭 Git 回退认定数据可回滚。
- 不得把容器重启成功或状态 API 返回成功，等同于完整业务验收。

## 7. 代码任务结束时的部署交接

凡任务修改了柏宝库 Runtime、依赖、数据库、API 或与 ST/柏宝箱的集成，完成实现、测试和独立审查后，必须在交接结尾明确：

1. 本次变更是否影响 NAS Runtime；纯文档/测试变更应明确说明无需更新 NAS。
2. 变更是否已进入 `personal/stable`；若尚未进入，不能声称可以直接部署。
3. 当前 NAS 预计从哪个 commit 更新到哪个 commit。
4. 主动询问用户是否现在更新 NAS；提供飞牛 Docker 容器终端的**定向更新命令**、必要的依赖安装步骤和图形化重启/验收步骤。

只提供更新建议，不自动更新 NAS、不自动重启、不自动修改生产数据；必须取得用户明确授权后才能执行部署操作。
