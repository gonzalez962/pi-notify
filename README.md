# pi-notify

Desktop system notifications (audio playback, desktop banners, terminal bell, custom commands) and Telegram alerts for [Pi](https://github.com/earendil-works/pi) agent hook events.

It notifies the moments that actually need you — **the agent finished the task**, or **Pi is blocked asking you a question** — instead of streaming every turn and tool call into your screen or phone.

Provides two independent, persistent channels:
1. **System channel** — desktop popups, bundled sounds, terminal bell, focus suppression, minimum run duration, and secure custom commands (adapted from `opencode-notifier`).
2. **Telegram channel** — remote phone notifications with parse modes, workspace tagging, and token redaction.

Each channel can be enabled, disabled, or configured independently without affecting the other.

## Install

As a Pi package:

```bash
pi install npm:pi-notify
```

Or point Pi at a local checkout in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-notify/extensions"]
}
```

## Quick Start & Controls

### Independent Channel Controls

Manage all notifications through `/notify`:

| Command | Effect |
|---------|--------|
| `/notify` or `/notify status` | Show status of both System and Telegram notification channels |
| `/notify system on` / `off` | Enable or disable desktop, sound, bell, and command alerts |
| `/notify telegram on` / `off` | Enable or disable Telegram notifications |
| `/notify on` / `off` | Enable or disable all notification channels simultaneously |
| `/notify test [message]` | Trigger a test alert across active channels |
| `/notify help` | Show notification command reference |

### Telegram Setup

Use `/telegram` to configure Telegram credentials and settings:

```
/telegram setup
```

Or step by step:

```bash
/telegram token 123456:AA...
/telegram chat add 123456789 -1001234567890
/telegram test
```

## System Notifications

System notifications work out of the box on macOS, Linux, and Windows.

### Features

- **Desktop notifications** — Native notification banners on macOS (`osascript` or `ghostty` OSC 9), Linux (`notify-send`), and Windows (PowerShell balloon/toast).
- **Bundled sounds** — High-quality sound effects for `permission`, `question`, `complete`, `error`, and `subagent_complete`. Custom audio files (.wav/.mp3) can be configured.
- **Terminal bell** — Optional terminal BEL (`\x07`) emit on events for TTY environments.
- **Focus suppression** — Automatically skips desktop popups and audio alerts when your terminal window, tmux, WezTerm, or Herdr pane is currently focused.
- **Herdr multiplexer & agents tab support** — When running inside [Herdr](https://herdr.dev) (`HERDR_ENV=1`), communicates via Herdr's IPC socket to update `pane.report_agent` and `pane.report_metadata` in real time. Shows running tools (`pi [⏳ bash]`), thinking turns (`pi [⏳ pensando]`), subagent tasks (`pi [⏳ explore: read]`, `pi [⏳ worker: edit]`, `pi [⏳ 2 subagentes]`), input blockers (`pi [❓ esperando respuesta]`), and settled completions (`pi [✅ listo]`, `pi [❌ error]`) directly in Herdr's **Agents** tab and pane title, keeping `working` active until all subagents finish.
- **Terminal tab & task indicator** — Emits OSC 0/2 terminal titles (`\x1b]0;...\x07`) with real-time indicators (`⏳ [pensando...]`, `⏳ [bash]`, `❓ [esperando respuesta]`, `✅`, `❌`), keepalive and burst re-assertions, and Windows Terminal progress sequences (`OSC 9;4;3/4/2/0`) for PowerShell, Windows Terminal, and Herdr panes.
- **Minimum duration threshold** — Suppress completion alerts for quick tasks under `minDuration` seconds.
- **Custom commands** — Run custom executables or webhooks with parameter substitution (`{event}`, `{message}`, `{projectName}`, `{sessionTitle}`, `{timestamp}`, `{turn}`), executed directly without shell interpolation.

### Platform Requirements

Native audio and desktop notification subprocesses are bounded to 5 seconds. A hung process is terminated and the notification resolves as a silent failure so it cannot block Pi. During extension shutdown, pending work gets a 1-second grace period before owned notification/audio processes are cancelled.

| Platform | Notifications | Audio Playback | Focus Detection |
|----------|---------------|----------------|-----------------|
| **macOS** | Native (`osascript`) or Ghostty OSC 9 | `afplay` (built-in) | AppleScript (`System Events`) |
| **Linux** | `notify-send` (`libnotify-bin`) | `paplay`, `aplay`, `mpv`, or `ffplay` | Hyprland, Sway, X11 (`xdotool`), tmux, WezTerm |
| **Windows** | Windows PowerShell (built-in) | Windows Media Player via PowerShell | Foreground process check |
| **WSL** | Recommended to set `customIconPath` to a Windows path | Via PowerShell | tmux pane active |

### System Configuration

Stored at `~/.pi/pi-notify/system.json` (override the directory with `PI_NOTIFY_CONFIG_HOME` or the exact file with `PI_NOTIFY_SYSTEM_CONFIG_PATH`):

```json
{
  "enabled": true,
  "sound": true,
  "notification": true,
  "bell": false,
  "timeout": 5,
  "showProjectName": true,
  "showFullPath": false,
  "showSessionTitle": false,
  "showIcon": true,
  "customIconPath": null,
  "suppressWhenFocused": true,
  "enableOnDesktop": false,
  "notificationSystem": "osascript",
  "suppressGhosttySound": false,
  "linux": {
    "grouping": false
  },
  "windows": {
    "appID": "pi"
  },
  "minDuration": 0,
  "mainAgentOnly": true,
  "command": {
    "enabled": false,
    "path": "",
    "args": ["--event", "{event}", "--message", "{message}"],
    "minDuration": 0
  },
  "events": {
    "permission": { "sound": true, "notification": true, "command": true, "bell": false },
    "complete": { "sound": true, "notification": true, "command": true, "bell": false },
    "subagent_complete": { "sound": false, "notification": false, "command": true, "bell": false },
    "error": { "sound": true, "notification": true, "command": true, "bell": false },
    "question": { "sound": true, "notification": true, "command": true, "bell": false },
    "user_cancelled": { "sound": false, "notification": false, "command": true, "bell": false },
    "plan_exit": { "sound": true, "notification": true, "command": true, "bell": false },
    "session_started": { "sound": true, "notification": false, "command": true, "bell": false },
    "user_message": { "sound": true, "notification": false, "command": true, "bell": false },
    "client_connected": { "sound": true, "notification": false, "command": true, "bell": false }
  },
  "messages": {
    "permission": "Session needs permission: {sessionTitle}",
    "complete": "Session has finished: {sessionTitle}",
    "subagent_complete": "Subagent task completed: {sessionTitle}",
    "error": "Session encountered an error: {sessionTitle}",
    "question": "Session has a question: {sessionTitle}",
    "user_cancelled": "Session was cancelled by user: {sessionTitle}",
    "plan_exit": "Plan ready for review: {sessionTitle}",
    "session_started": "Session started: {sessionTitle}",
    "user_message": "User sent a message: {sessionTitle}",
    "client_connected": "Pi connected"
  },
  "sounds": {
    "permission": null,
    "complete": null,
    "subagent_complete": null,
    "error": null,
    "question": null,
    "user_cancelled": null,
    "plan_exit": null,
    "session_started": null,
    "user_message": null,
    "client_connected": null
  },
  "volumes": {
    "permission": 1,
    "complete": 1,
    "subagent_complete": 1,
    "error": 1,
    "question": 1,
    "user_cancelled": 1,
    "plan_exit": 1,
    "session_started": 1,
    "user_message": 1,
    "client_connected": 1
  }
}
```

### Custom Commands

Custom commands allow running custom scripts or integrations when events occur:

- **Opt-in only**: `command.enabled` must be explicitly set to `true`.
- **Safe parameter handling**: Arguments are passed as discrete argv elements directly to process spawn, avoiding shell interpolation of message data.
- **Available placeholders**: `{event}`, `{message}`, `{projectName}`, `{sessionTitle}`, `{agentName}`, `{timestamp}`, `{turn}`.

## Telegram Notifications

Telegram configuration is stored at `~/.pi/pi-notify/telegram.json`:

```json
{
  "enabled": true,
  "botToken": "",
  "chatIds": ["123456789"],
  "events": ["agent_settled", "ui_prompt_start"],
  "parseMode": "HTML",
  "silent": false,
  "includeProject": true,
  "workspaceName": "",
  "timeoutMs": 10000,
  "throttleMs": 0,
  "mainAgentOnly": true
}
```

### Telegram Command Reference

| Command | Effect |
|---------|--------|
| `/telegram` or `/telegram status` | Show Telegram configuration and ready state |
| `/telegram setup` | Interactive wizard: token, chat ids, hooks |
| `/telegram on` / `/telegram off` | Enable or disable Telegram notifications |
| `/telegram token <bot-token>` | Store bot token in `telegram.json` |
| `/telegram chat add <id> [id...]` | Add destination chats (numeric ids or `@public_channel`) |
| `/telegram chat remove <id> [id...]` | Remove destination chats |
| `/telegram events <name> [name...]` | Replace subscribed hooks (`attention` for default, `all` for every hook) |
| `/telegram events list` | List supported hooks and active subscriptions |
| `/telegram set <key> <value>` | `parseMode`, `silent`, `includeProject`, `workspaceName`, `timeoutMs`, `throttleMs`, `mainAgentOnly` |
| `/telegram test [message]` | Send test message to every configured chat |

### Token from Environment

`PI_NOTIFY_TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_TOKEN` take precedence over stored tokens, allowing zero-disk token operation on shared machines and CI. Configuration files containing tokens are saved with permissions `0600` on POSIX systems.

## Pi Lifecycle Mapping & OpenCode Compatibility

Pi and OpenCode have slightly different extension event models. `pi-notify` provides a compatible mapping:

| OpenCode Notifier Event | Pi Lifecycle Equivalent | Description |
|-------------------------|-------------------------|-------------|
| `complete` | `agent_settled` | Fired when the agent run finishes and context is idle. Carries the assistant's final response. Suppressed if the task ran shorter than `minDuration`. |
| `permission` | `ui_prompt_start` (`kind: "confirm"`) | Pi prompts for user confirmation or tool execution permission. |
| `question` | `ui_prompt_start` (`kind: "select"` or `"input"`) | Pi is blocked waiting for human input. |
| `error` | `session_compact_failed` | Fired when context compaction or an agent error occurs. |
| `session_started` | `session_start` | Fired when a Pi session starts or resumes. |
| `user_cancelled` | `agent_end` (`stopReason: "aborted"`) | Fired when user aborts a run (e.g. via Escape/Ctrl+C). Suppresses premature `complete` alerts. |
| `subagent_complete` | Subagent process completion | Canonical Pi subagents run as separate `pi --mode json` processes. With `mainAgentOnly: true` (default), subagent processes stay quiet to prevent alert spam. |

### Documented OpenCode-Only Gaps

- **`plan_exit`**: OpenCode has a dedicated plan mode exit event. Pi does not have a native plan mode event hook; the event definition is preserved in configuration for template compatibility.
- **`client_connected`**: OpenCode desktop web-socket connection hook. Pi extensions are in-process and load with the agent; `session_start` serves as the initial lifecycle hook.
- **`user_message`**: OpenCode per-message submission event. High-frequency per-message events are not exposed as public phone/system alerts to avoid noise.

## Behaviour Guarantees

- **Channel Isolation**: Turning off System notifications does not disable Telegram notifications, and vice versa.
- **No Premature Alerts**: Completion notifications use `agent_settled` instead of low-level `agent_end` to avoid duplicate alerts during retries or compactions.
- **Abort Suppression**: When a run is aborted, any partial text is discarded and the subsequent `agent_settled` event is suppressed.
- **Headless Safety**: `mainAgentOnly` defaults to `true` on both channels. Subagent processes running in JSON mode stay quiet.
- **Fail-Safe Execution**: Failures in audio players, system notifications, focus checks, or Telegram HTTP calls never throw or disrupt the Pi agent loop.

## Development

Run the full automated test suite:

```bash
npm test
```

## Attribution & License

Portions adapted from [opencode-notifier](https://github.com/mohak34/opencode-notifier) (c) 2025 Mohak S, used under the MIT License. See [NOTICE](NOTICE) for details.

MIT License.
