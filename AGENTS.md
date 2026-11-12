# Personal BaiBaoKu Fork

- Read [the personal maintenance and NAS update runbook](docs/PERSONAL_MAINTENANCE.md) before changing, reviewing, or deploying this repository.
- Read the canonical [SillyTavern Personal maintenance and capability-ownership rules](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md) before any change that can affect ST Core, ST-BaiBai-Tools, plugin lifecycle, persistence, or shared capabilities.
- `main` is the unchanged upstream synchronization baseline; `personal/stable` is the only production branch. Do not deploy `main`.
- Preserve the Server Plugin boundary. Do not turn BaiBaoKu into a frontend extension or add compatibility hooks/adapters without the canonical Owner Review.
- Keep `enableServerPluginsAutoUpdate: false` in the current production combination. Do not enable the global Server Plugin updater merely to update BaiBaoKu.
- Do not use SillyTavern's `node plugins.js update` for a BaiBaoKu-only deployment; it updates all Git Server Plugins. Use the targeted command documented in the runbook after NAS branch/origin alignment.
- Protect user databases under `data/<user>/baibaoku/`. Runtime rollback and database restoration are separate operations.
- After a Runtime-affecting task is implemented, tested, and reviewed, provide a deployment handoff: state whether NAS runtime changes are needed, whether the change has reached `personal/stable`, give the exact target commit and the runbook's targeted update/restart/verification steps, and explicitly ask whether the user wants to update NAS now.
- Documentation-only or test-only changes must explicitly say that no NAS runtime update is required. Never update NAS, restart the production container, or modify production data without explicit user authorization.
