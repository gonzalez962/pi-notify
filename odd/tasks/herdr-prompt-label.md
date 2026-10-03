# Herdr prompt-label messages

Goal: Herdr pane messages use the Gentle prompt box label (ODD phase label, fallback "Working") as the primary text, with active subprocesses appended: `Working - Grep/Gentle-review`.

## Tasks

- [x] 1. Rework `HerdrTracker.getDesiredState()` working format (label primary, tools/subagents as suffix) and republish after phase inference; update tests and README.
