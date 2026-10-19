# Herdr resumed activity

## Objective
Reproduce and fix pane activity that remains success or becomes success prematurely when main/subagent work resumes.

## Problem and rationale
The user reports main idle marks everything success and later processes are invisible. Exploration found full-map replacement in subagent activity handling, but incomplete payload causality is unconfirmed. Do not preserve completed tasks blindly.

## Scope and constraints
- Behavior and regression tests: `lib/herdr.ts`, `tests/herdr.test.ts`.
- User authorized opt-in temporary redacted diagnostics and usage documentation in `README.md`; no lifecycle semantics changes without evidence.
- Confirm event semantics before altering replacement behavior; no changes to external Herdr UI or unrelated notification code.
- Single writer. Existing branch: `feat/herdr-prompt-label`.
- No commits, push, or PR without explicit user request. No work-unit commit produced because no fix exists.

## Tasks
- [x] T1: Implement jobs tracking in HerdrTracker: prevent premature `[success]` status during background jobs (`bash_background`, `monitor`), surface active jobs in process message (`Working - Job: <label>` / `Working - <N> jobs`), and transition to `[success]` only when all jobs finish. Verified with 6 new deterministic regression tests.
- [x] T2: Diagnostics diff independently re-verified PASS; 33 Herdr/199 full tests pass, diff check exit 0. Native assessment remained unassessable due untracked task file; independent high-risk fallback completed. Future lifecycle fix requires fresh assessment/verification.
- [x] T3: Disabled-by-default bounded redacted diagnostics implemented and independently verified. No commit: user has not requested one.
- [x] T4: Stale pane status root cause identified: background jobs (`gentle-ai:jobs-sidebar` / `bash_background` / `monitor`) were not tracked in `HerdrTracker`, causing `agent_settled` to mark `[success]` prematurely while background jobs were running. Fixed and verified.

## Acceptance and checks
Resumed main or background activity reports working after success; genuine completion still reports success; main settling does not hide known running tasks; queued report ordering is covered where relevant.
Test-first: observed failing regression before behavior change, focused GREEN afterward. If no regression can be demonstrated, report that limitation rather than speculate.
Commands: `node --experimental-strip-types --test tests/herdr.test.ts`; `npm test`; `git diff --check`.

## Progress and evidence
Read-only scout completed. Worker murtcx9w-2-s9wm returned partial with no source/test edits.
- Focused Herdr tests: 26 passed.
- Full suite: 192 tests across 36 suites passed.
- `git diff --check`: passed.
- RED: not demonstrated. GREEN/refactor: not applicable, no behavior change.
- Existing tests treat empty subagent snapshots as completion and restore working on main start/result wake.
- Activity producer and actual Herdr rendering were not verified; suspected snapshot issue remains a hypothesis.
- User confirmed live failure: pane remained success during background worker murtcx9w-2-s9wm. This is user-observed UI evidence, not a deterministic regression or event trace.
- Explorer murtmem1-3-zgdk tracing actual installed event producer and tracker subscription read-only.
- No lifecycle fix or commit. Diagnostic implementation independently verified below.

## Next step
Worker muruih13-4-gimt completed diagnostics in lib/herdr.ts, tests/herdr.test.ts and README.md: opt-in PI_NOTIFY_HERDR_DIAGNOSTICS=1 stderr JSONL, capped at 500 records/500 characters per tracker, output failures ignored. Worker observed RED then GREEN: 30 focused tests and 196 full tests across 37 suites passed, diff check passed (LF/CRLF warnings). No lifecycle change or commit. Independent verifier observed 30 focused/196 full passes and diff check exit 0 but did not approve: thrown send errors now retried/swallowed; method logged verbatim; sliced JSON may be malformed; cap and thrown-send parity tests absent. Correction worker mururd4q-6-ghvo completed: thrown-send RED observed, rejection restored with one attempt/no retry, method allow-list enforced, oversized records dropped rather than sliced, cap/parity tests added. Checks: 3 focused regressions, 33 Herdr tests, 199 full tests across 37 suites passed; diff check passed (LF/CRLF warnings). Re-assessment unassessable on untracked document; independent re-verifier muruw4ht-7-zlyo PASS: 33/33 focused, 199/199 full across 37 suites, diff check exit 0 (LF/CRLF warnings). Earlier parity/privacy/bounds findings resolved. No live UI or producer verified. Enable in a new Pi-host PowerShell process with `$env:PI_NOTIFY_HERDR_DIAGNOSTICS='1'; pi 2> "$env:TEMP\pi-herdr-stderr.log"`. File may contain unrelated stderr and encoding depends on PowerShell version. Disable by removing env var and restarting Pi. Capture only diagnostic lines for review, not full raw stderr. User confirmed stale success and working; cause unresolved.
