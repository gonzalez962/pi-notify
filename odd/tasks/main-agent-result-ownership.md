# Main-agent result ownership

## Objective and rationale
Only main-agent hooks may publish terminal success/error in Herdr or emit result notifications. Subagent task/working activity remains visible. Child outcomes must not become parent outcomes.

## Scope and constraints
Allowed behavior surfaces: lib/herdr.ts, extensions/telegram-notify.ts; tests/herdr.test.ts, tests/extension.test.ts, tests/channel-isolation.test.ts; README.md only for concise user-facing behavior documentation. Single writer. Existing branch feat/herdr-prompt-label. No commit, push or PR without explicit user request.
Producer source identifies child processes using GENTLE_PI_AGENTS_CHILD=1. Mode alone is not a child discriminator. Preserve result ingestion and parent wake bridging; do not modify external producer source or task result delivery.

## Tasks
- [x] T1 (verified implementation; no commit authorized): Add deterministic failing regressions, implement main-only result ownership and suppress subagent result notifications across channels, preserve working activity, self-verify.
- [x] T2 (verified; no commit authorized): Assess candidate and perform required independent verification; correct test environment isolation and make child Herdr socket assertion meaningful, then re-verify.

## Acceptance and checks
Child contexts cannot publish terminal success/error or dispatch result/error/cancellation notifications. Main-agent completion/error notifications continue working. Parent subagent activity remains working until genuine parent lifecycle permits completion. gentle-agents.result remains consumable but sends no result notification. Cover explicit marker and unmarked main controls.
Test-first RED -> GREEN with focused Herdr/extension/channel tests; npm test and git diff --check. Live Herdr/UI confirmation pending unless actually observed.

## Evidence and progress
Explorers mapped terminal hooks and confirmed producer marker at gentle-pi/lib/agents-runner.ts:216-217,471-475; child-context.ts:11-12. Working snapshots and parent wake bridging must remain. Initial writer implemented child Herdr publishing guard and removed result dispatch; reported RED then 81 focused/210 full passes and diff check PASS. Parent readback found unused notification child marker: child direct notification guard remains incomplete. Correction writer murwow8x-5-6k3t assigned test-first completion. Native ASSESS unassessable due untracked feature document; RDD off, independent verifier required (high-risk fallback). No commits authorized.

## Final verification
Independent re-verifier murx24zz-8-4agm PASS: inherited marker restored; main controls genuine; active pane/socket child regression covers lifecycle and shutdown. 82 focused tests passed; inherited-child full suite 211 passed; git diff --check exit 0 (LF/CRLF advisories only). Writer also observed 211 full passes in normal environment and 82 focused passes in both environments. Native assessment unavailable due untracked task declaration; high-risk independent fallback completed. RDD off: no native review started. No commits or publishing. Live UI remains unobserved.

## Next step
Reload/restart the parent Pi host and confirm background activity remains working while only main settlement emits completion notifications and terminal success/error. Live UI validation pending; no commit authorized.
