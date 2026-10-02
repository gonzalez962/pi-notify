# Full Pi notification port

## Objective and rationale
Port the compatible behavior of ../opencode-notifier-main into pi-notify, preserving existing Telegram behavior and providing independent persistent system and Telegram controls. The user explicitly selected the full compatible port.

## Scope and constraints
Desktop notifications, bundled sounds, bell, focus suppression, minimum duration, custom commands, and compatible lifecycle events. Preserve /telegram and existing configuration. Add /notify system on|off and /notify telegram on|off. Retain upstream MIT attribution. Source directory is read-only. No commits, publishing, real Telegram messages, or real desktop/audio tests. Document OpenCode-only gaps rather than inventing Pi events. Custom commands must be explicit opt-in and avoid shell interpolation of message data. Never expose credentials.

## Tasks
- [x] T1 Map source, destination, and Pi event API; confirm full scope.
- [x] T2 Implement compatible port, independent channel controls, regression tests, and attribution.
- [x] T3 Verify package and tests, independently check risk-sensitive behavior, and document setup and limitations.
- [x] T4 Bound notification subprocess execution and shutdown waits; add hung-process regression tests. User explicitly authorized both protections.

## Acceptance and checks
Each channel can be disabled without disabling the other. Legacy Telegram configuration and commands keep working. Completion uses agent_settled rather than premature agent_end. Aborts and headless agents do not produce unexpected alerts. Platform operations are bounded and failures do not break the agent. Tests mock network/process/audio side effects. Documentation covers installation, credentials, controls, platform requirements, and unsupported behavior.

## Implementation method
Exploration reported no configured strict TDD override and baseline off; ordinary functional testing is required. Exact runner: npm test (node --experimental-strip-types --test tests/*.test.ts). Writer must verify actual local contracts and report discrepancies before relying on unsupported API assumptions.

## Progress and evidence
Repository clean at 8435bb7756e13146056f6868d0f104a593864772 before implementation. Read-only mapper completed; user selected full compatible port. Implemented system notifications, bundled sounds, bell, focus suppression, custom commands without shell interpolation, independent `/notify` system/telegram controls, MIT attribution notice, complete documentation of OpenCode gaps, and mocked unit and integration test suites. Added subprocess timeouts (5s) for audio/notify spawns and bounded shutdown drain (1s) with process cancellation. All 172 tests passing across 36 test suites. `git diff --check` passed cleanly.

## Next step
Implementation and verification completed. Create work-unit commits according to Conventional Commits specification.
