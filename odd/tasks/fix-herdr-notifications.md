# Fix Herdr Notifications and Sound Suppression

## Objective and authorization
Fix notifications and sound effects in `pi-notify` when running inside Herdr multiplexer (`HERDR_ENV=1`). Authorized by user request in chat: "arregla las notificaciones en herdr que no se muestran ni suenan - las notificaciones desde la extension no las nativas de herdr".

## Root causes
1. **Multiplexer vs OS Window Focus in `lib/focus.ts`**:
   `isTerminalFocused()` checked `const herdr = isHerdrActivePane(env, exec); if (herdr !== null) return herdr;`.
   When running inside Herdr with `HERDR_PANE_ID`, `isHerdrActivePane()` returned `true` (indicating the pane is active within Herdr's UI). Because it immediately returned `true`, it never checked whether the Herdr window itself had OS-level foreground focus.
   Consequently, even when the user minimized Herdr or switched to Chrome, Telegram, VS Code, or any other app, `isTerminalFocused()` unconditionally returned `true`.
   Since `systemConfig.suppressWhenFocused` is `true` by default, all visual desktop notifications and audio sound effects were suppressed 100% of the time.
2. **Windows PowerShell Foreground Script Syntax Error**:
   In `lib/focus.ts`, the PowerShell script used here-string `Add-Type @' ... '@;` joined with `" "` instead of newlines, throwing a PowerShell syntax error (`UnexpectedCharactersAfterHereStringHeader`).
   Additionally, `[WinFocus]::GetWindowThreadProcessId($hwnd, [ref]$procId);` leaked the thread ID to stdout before the process name, producing `<threadId>\n<processName>` instead of a clean process name.
3. **Missing Herdr in macOS and Linux Sets**:
   `"herdr"` was only listed in the Windows terminal set, but absent from `MAC_TERMINAL_APPS` and `LINUX_TERMINAL_APPS`.

## Solution plan
1. In `lib/focus.ts`:
   - Treat multiplexer checks (`isHerdrActivePane`, `isWezTermActivePane`, `isTmuxActivePane`) as pane-activity guards: if any multiplexer reports `false` (the agent pane is inactive/background), immediately return `false`.
   - If the multiplexer pane is active (or not in a multiplexer), proceed to evaluate whether the host terminal window actually has OS-level foreground focus.
   - Fix the PowerShell script on Windows: join with newlines `\n`, suppress thread ID with `$null = [WinFocus]::GetWindowThreadProcessId(...)`, and safely retrieve process name with `if ($procId -gt 0) { ... }`.
   - Add `"herdr"` to `MAC_TERMINAL_APPS` and `LINUX_TERMINAL_APPS`.
2. In `tests/focus.test.ts`:
   - Add test cases verifying that when Herdr pane is active, `isTerminalFocused` still checks OS focus and returns `false` when another app (e.g. Chrome) is focused.
   - Add test cases verifying that when Herdr pane is active AND Herdr OS window is focused, `isTerminalFocused` returns `true`.
   - Add test cases verifying that when Herdr pane is inactive, `isTerminalFocused` returns `false` even if Herdr OS window is focused.
   - Add test cases verifying Windows PowerShell process detection with `"herdr"` and non-terminal apps.
3. Run full test suite with `npm test`.

## Tasks
- [x] T1: Fix focus detection in `lib/focus.ts` (multiplexer vs OS focus, PowerShell script, and terminal sets).
- [x] T2: Add regression tests in `tests/focus.test.ts`.
- [x] T3: Verify test suite with `npm test` and test real-world behavior in Herdr.

## Progress and evidence
1. Modified `lib/focus.ts`:
   - Replaced unconditional return of `isHerdrActivePane`, `isWezTermActivePane`, and `isTmuxActivePane` with pane-inactivity guards (`if (multiplexer === false) return false;`). If the pane is active, execution proceeds to check OS window focus.
   - Fixed Windows PowerShell foreground window script: joined with `\n`, suppressed P/Invoke thread ID output with `$null = [WinFocus]::GetWindowThreadProcessId(...)`, and guarded process name query with `if ($procId -gt 0)`.
   - Added `"herdr"` to `MAC_TERMINAL_APPS` and `LINUX_TERMINAL_APPS`.
   - Refined editor terminal detection: only considers `"code"` or `"cursor"` a terminal if `TERM_PROGRAM === "vscode"` or `TERM_PROGRAM === "cursor"`, ensuring that users working in Herdr who switch to VS Code / Cursor still receive notifications and audio.
2. Added unit and regression tests in `tests/focus.test.ts`:
   - Windows PowerShell process name detection (`herdr`, `chrome`, `windowsterminal`).
   - Active Herdr pane with unfocused OS window (`chrome`) returns `false` (no false suppression).
   - Active Herdr pane with focused OS window (`herdr`) returns `true`.
   - Inactive Herdr pane returns `false` regardless of OS window focus.
   - Herdr recognition on macOS and Linux.
   - Editor focus scoping (`code` only focused when `TERM_PROGRAM=vscode`).
3. Verification:
   - Full test suite passes: 188 tests across 36 suites, 0 failures.
   - Real-world verification confirms `isTerminalFocused()` returns `false` when Herdr is running but an external application is active, allowing toast notifications and sound to fire.

