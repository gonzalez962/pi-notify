# Herdr Agents branch display

## Objective
Show the current session worktree Git branch below the Herdr workspace label, preserving agent state. Modify pi-notify adapter and authorized user configuration only; never edit Herdr sources.

## Constraints
- Preserve all existing uncommitted changes; current branch: feat/herdr-prompt-label.
- Herdr repository is read-only.
- No commits without explicit user authorization (pending).
- Confirm effective config override before editing; user config is outside Git.
- Handle non-Git directories and detached HEAD without breaking agent reporting.

## Plan
Delivery strategy: ask-on-risk. Forecast: 150–250 authored lines, one coherent adapter/test/config unit.
Route: delegated writer (multiple meaningful files); delegated verifier.

- [x] T1: Implement and test branch metadata in the adapter, preserving existing edits. Delayed IPC correction complete: deterministic test holds report_agent and asserts sender entry before dispose. Genuine RED in isolated loader with disposal guards removed: metadata 2 instead of 1; fixed GREEN 50/50. Guards clear queued state, stop metadata after awaited agent report and prevent queue restart. Prior correction completed: dispose clears branch and rejects late resolver publication; cwd changes force immediate clearing; isolated attached/detached/non-Git fixtures replace ambient test assumptions. Correction observed cwd regression RED then 49/49 GREEN; diff check passed (line-ending warning only). Initial RED 43/1, GREEN 44/0, helper 2/0. No commit (not authorized).
- [x] T2: Configure Agents rows to show workspace, branch and existing status. Parent added [ui.sidebar.agents] with original default heading, $branch, then agent; backup config.toml.pi-notify-branch.bak. herdr server reload-config returned applied, diagnostics []. Other settings preserved. No commit: user config outside Git.
- [x] T3: Independently verify adapter/config changes and report runtime limitations. Final verifier observed focused 50/50 (6 suites), full 219/219 (40 suites), diff check clean (LF/CRLF warnings only). Readback confirmed held-IPC ordering regression, disposal guards, late resolver protection, portable resolver fixtures and config/README consistency. No remaining reported blocker. Live UI visual proof unavailable; no dedicated typecheck/build script in package.json. Native RDD off; assessment unavailable handled through independent verification. Previous verifier observed 49/49 focused, 218/218 full, clean diff check and correct config before race correction. Initial independent focused 46/46 and full 215/215, diff check passed but lifecycle/test issues required correction. Real linked-worktree/nested and detached fixtures passed. Config reload applied. Checks: focused and full applicable tests, type checks if available, structural config validation and native assessment; live UI if available.

## Evidence
Initial git status contains pre-existing edits in extensions/telegram-notify.ts, lib/focus.ts, lib/herdr.ts and related tests, plus odd/tasks/main-agent-result-ownership.md. These are not this feature's ownership.
T1 implementation complete; final independent focused 50/50 and full 219/219 passed. Installed Herdr --default-config confirms [ui.sidebar.agents] nesting and custom $name. HERDR_CONFIG_PATH unset in current process/user/machine; CLI selects C:/Users/Personal/AppData/Roaming/herdr/config.toml. Running-server inherited environment remains unverified. Parent read-only spot-check src/client/shell/agent_sidebar.rs:82,189–219 confirms configured row count drives card height (overall sidebar clipping remains possible). User config updated and server reload returned applied with no diagnostics. Live rendering pending. Commit evidence pending explicit authorization.

## Next step
Implementation and functional/structural verification complete. Reload the Pi extension (or restart the session) to load changed adapter, then visually confirm branch beneath workspace. Herdr configuration already reloaded successfully. Clone-local RDD off; native assessment unassessable due undeclared untracked files was covered by independent high-risk verification. No commits created; explicit authorization required.
