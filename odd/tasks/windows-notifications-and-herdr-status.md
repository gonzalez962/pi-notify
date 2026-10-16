# Windows Notifications and Herdr Status Tracking

## Objective and authorization
Fix Windows notifications and sounds so they display reliably as WinRT Toast notifications and play audio without unintended focus suppression, and refine Herdr pane text and agent state tracking to accurately report `[success]` on completion, show active ODD phases (`exploring`, `working`, `pensando`), and handle tool (`bash`) transitions cleanly. Authorized by user in chat.

## Scope and constraints
- Modify `lib/system-notify.ts` to use WinRT Toast Notifications on Windows 10/11 with PowerShell AUMID, with fallback to legacy script if needed.
- Modify `extensions/telegram-notify.ts` so sound is not suppressed when terminal is focused (only desktop popups if configured), and `/notify test` bypasses focus suppression.
- Modify `lib/herdr.ts` to report `message: "[success]"` and `displayAgent: "pi [✅ success]"` when idle after running a task, robustly read session ID and Gentle ODD phases (`exploring`, `implementing`, etc.), and handle transitions when tools (like `bash`) finish.
- Add commands to `/notify` (`focus on|off`, `sound on|off`) for easy runtime configuration.
- Preserve backward compatibility with existing tests and platforms (Darwin, Linux).
- Maintain 100% test pass rate with `npm test`.

## Tasks
- [x] T1: Modernize Windows notification script in `lib/system-notify.ts` using WinRT Toast Notifications with PowerShell AUMID and fallback, and update unit tests.
- [x] T2: Refine focus suppression in `extensions/telegram-notify.ts` (keep sound enabled when focused, bypass focus in `/notify test`) and update `/notify` commands in `lib/command.ts`.
- [x] T3: Refine Herdr tracker in `lib/herdr.ts`: report `[success]` on idle completion, robustly resolve Gentle ODD phases (`exploring`, `working`, `pensando`), and ensure smooth post-tool transitions.
- [x] T4: Make Herdr agent name prefix configurable (`herdr.showAgentName: false` by default in system-config) to eliminate "pi " and save space in Herdr panes, with `/notify herdr-name on|off` command.
- [x] T5: Run full test suite (`npm test`), verify regressions, and validate end-to-end behavior.

## Progress and evidence
1. Modernized `buildWindowsNotificationScript` in `lib/system-notify.ts`: uses Windows Runtime `ToastNotificationManager` with standard PowerShell AUMID and `<audio silent='true'/>` to prevent double audio, while preserving legacy `ShowBalloonTip` fallback for older environments.
2. Updated `dispatchSystemEvent` in `extensions/telegram-notify.ts` so `/notify test` bypasses focus suppression, allowing users to always hear and see test notifications.
3. Added `/notify focus on|off` and `/notify sound on|off` commands in `lib/command.ts` and `extensions/telegram-notify.ts` to allow users to toggle focus suppression and audio directly.
4. Refined `HerdrTracker` in `lib/herdr.ts`:
   - Emits `message: "[success]"` on task completion instead of undefined message.
   - Robust session ID resolution via `process.env.PI_SESSION_ID`, `this.env.PI_SESSION_ID`, and capturing `ctx.sessionManager.getSessionId()` across lifecycle events.
   - Enhanced `getGentleOddPhase` to inspect all active phases in Gentle's `oddPhaseRegistry`, accurately reflecting phases like `exploring`, `implementing`, `planning`, etc.
   - Managed transitions so when a tool (e.g. `bash`) completes execution, the state immediately transitions to the active ODD phase (`[exploring]`) or `[pensando]`.
   - Cleans up `user_bash` on `input`.
5. Added `herdr.showAgentName` configuration in `lib/system-config.ts` (default `false`) and `showAgentPrefix` option in `HerdrTracker` (`lib/herdr.ts`):
   - When disabled (default), the `"pi "` prefix is omitted from `display_agent`, showing only `[⏳ pensando]`, `[⏳ bash]`, `[⏳ exploring]`, `[✅ success]`, etc., freeing horizontal space in the Herdr pane header.
   - Added `/notify herdr-name on|off` command in `lib/command.ts` and `extensions/telegram-notify.ts`.
6. Full test suite passes: 184 tests across 36 suites, 0 failures.

## Verification
- Test-driven verification using `npm test`.
- All tests must pass cleanly.
