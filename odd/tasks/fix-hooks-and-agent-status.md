# Fix Hooks and Agent/Subagent Status Tracking

## Objective and authorization
Fix active status tracking in `pi-notify` (`lib/herdr.ts` and `extensions/telegram-notify.ts`) so terminal indicators (OSC 9;4, window titles) and Herdr pane reports accurately reflect the working state of the primary orchestrator, nested tool executions, and running subagents, eliminating false idle states. Authorized by user request to implement after repository review of `gentle-pi`.

## Problems to solve
1. Nested tool execution in Pi 1.0.0 (`parentToolCallId`): when an inner tool finishes, `tool_execution_end` clears `currentToolName` to `null` even though the outer tool (e.g. `codemode`, orchestrator) is still running.
2. Synchronous task-mode subagents: when `subagent_run` is running in `task` mode, `currentToolName` overrides the subagent name and displays generic `[subagent_run]` instead of `[explore: read]`.
3. False idle state during subagent completion and parent wake (commit `2549f17a` in `gentle-pi`): when a background subagent finishes, `gentle-agents:activity` clears active tasks before the parent orchestrator starts its wake turn (`pi.sendUserMessage`), causing the tracker to fall into `idle` and emit `[listo]`.
4. Missing Pi lifecycle hooks: `before_agent_start`, `agent_before_settle`, `session_before_compact`, `session_compact`, `auto_retry_start`, and `user_bash` are not handled, leaving dead idle windows during prompt prep, context compaction, and retries.
5. Undispatched `subagent_complete` event: `subagent_complete` is defined in `system-config.ts` but never dispatched in `extensions/telegram-notify.ts`.
6. False generic `esperando respuesta` during active working / exploring turns: `blockedCount` was an integer counter incremented concurrently across multiple overlapping blocker channels (`ui_prompt_start`, `herdr:blocked`, `gentle-pi:ask-user-choice:blocked`, `gentle-pi:ask-user-question:blocked`). It was never reset at lifecycle boundaries (`agent_start`, `turn_start`, `agent_settled`), was evaluated before `isMainAgentWorking`, and `HerdrTracker` lacked integration with Gentle's global `oddPhaseRegistry`, masking active `exploring` or tool execution with false `[esperando respuesta]`.

## Tasks
- [x] T1: Implement nested tool call tracking (`activeTools` stack/map by `toolCallId`) with `parentToolCallId` in `lib/herdr.ts`.
- [x] T2: Wire missing Pi lifecycle hooks (`before_agent_start`, `agent_before_settle`, `session_before_compact`, `session_compact`, `auto_retry_start`, `user_bash`) in `lib/herdr.ts`.
- [x] T3: Refine subagent state formatting in `lib/herdr.ts`: prioritize subagent name/step over `subagent_run` in task mode, and bridge background completion wake transitions.
- [x] T4: Dispatch `subagent_complete` system notification in `extensions/telegram-notify.ts` and update `herdr.ts` event handlers.
- [x] T5: Write regression tests in `tests/herdr.test.ts` and `tests/extension.test.ts` covering nested tools, new hooks, subagent task/wake states, and `subagent_complete` alerts.
- [x] T6: Eliminate false `esperando respuesta` states: replace leaking `blockedCount` with `activeBlockers` Set, auto-clear blockers on turn/session boundaries, give precedence to actively executing tools in `isBlocked()`, and read Gentle ODD phases (`exploring`, `implementing`, etc.) from `Symbol.for("gentle-pi.odd-phase-registry")`.

## Implementation details and results
- `lib/herdr.ts`: Added `activeToolCalls` map for nested execution tracking, `currentActivityNotice` for compaction/retry notices, direct listeners for `gentle-pi:ask-user-choice:blocked` and `gentle-pi:ask-user-question:blocked`, and subagent completion wake state bridge on `message_end` (`gentle-agents.result`). Replaced blind integer `blockedCount` with `activeBlockers` Set and `activeBlockerMessages` Map; added `isBlocked()` guard ensuring actively running non-interactive tools (`read`, `grep`, `bash`, `edit`, etc.) are never reported as blocked; added auto-clear of blockers on `before_agent_start`, `agent_start`, `turn_start`, and `agent_settled`; added Gentle ODD phase resolution via global `oddPhaseRegistry` symbol.
- `extensions/telegram-notify.ts`: Added `message_end` handler dispatching `subagent_complete` system event.
- Tests: 9 new tests added (total 181 passing across 36 suites, 0 failures).


## Verification
- Test-first development for each task.
- Run `npm test` ensuring all existing tests and new regression tests pass cleanly.
