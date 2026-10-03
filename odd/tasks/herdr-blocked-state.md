# Herdr blocked state

## Objective
Cover Herdr pane agent states (working / blocked / idle) with tests and make the pane report `blocked` whenever the user must act, including `gentle_review` consent and `ask_user_*` prompts.

## Problem and rationale
`HerdrTracker.isBlocked()` (`lib/herdr.ts`) returns `false` while the main agent works and the current tool is not exactly `ask_user_choice`/`ask_user_question`. Real blocker signals are emitted:
- `gentle-pi:ask-user-choice:blocked` / `gentle-pi:ask-user-question:blocked` `{active}` (gentle-pi/extensions/ask-user-*.ts).
- `herdr:blocked` `{active,label}` projection (gentle-pi/extensions/gentle-ai.ts:1707-1727).
- `ui_prompt_start` / `ui_prompt_end` around `ctx.ui.select|confirm|input|editor|custom` (pi-main runner.ts:442-479), used by `gentle_review` consent inside tool execution (gentle-pi/lib/review-consent-ui.ts:66-103).
The tool-name exception masks these signals for `gentle_review`, `codemode`-wrapped calls and parallel tools. Stale blockers are already cleared on `before_agent_start`, `agent_start`, `turn_start` and `agent_settled`.

## Scope and constraints
- Allowed edit surfaces: `lib/herdr.ts`, `tests/herdr.test.ts`, this task file.
- Single writer. Branch: `feat/herdr-prompt-label`.
- Work-unit commit per task; no push or PR.

## Tasks
- [x] T1: Add state-matrix tests (RED for gentle_review consent, codemode-wrapped ask_user, parallel tool, herdr:blocked during tool) and fix `isBlocked()` so active blockers win; keep stale-blocker and working-state tests green.
- [x] T2: Independent verification (focused + full suite, diff check) and work-unit commit.

## Acceptance and checks
- Blocked is reported while any explicit blocker is active, regardless of the running tool.
- Blocker end edges return to working (tool still running) or idle/success (settled).
- Stale blockers from a previous turn do not override a new turn's working state.
Commands: `node --experimental-strip-types --test tests/herdr.test.ts`; `npm test`; `git diff --check`.

## Progress and evidence
- Prior diagnostics work committed separately as `5399a2c`.
- T1 writer `murvhc26-2-65sb`: 8 tests added; RED observed on 5 (gentle_review consent, codemode question, parallel tool, herdr:blocked during tool, pane report). Fix: `isBlocked()` returns `activeBlockers.size > 0`; tool start no longer clears `ui_prompt`. Writer GREEN 40/41 focused, 206/207 full; the 1 failure was test isolation (ambient `PI_NOTIFY_HERDR_DIAGNOSTICS=1`), fixed by passing `env: {}`.
- T2 verifier `murvn3mb-3-qmya` flagged the parallel test as not starting the ask tool; parent fixed it (start ask_user_choice, start/end bash, end blocker -> working).
- Re-verifier `murvq1nh-4-32pn`: focused 41/41 (ambient and cleaned env), `npm test` 207/207, `git diff --check` clean (LF/CRLF warning only).
- RED (parent, `git archive HEAD` into a temp dir with the new tests, cleaned env): 35 pass / 6 fail -- gentle_review consent, codemode question, parallel tool, herdr:blocked during tool, end-edge lifecycle, pane report blocked.
- Not verified: live Herdr pane rendering.
