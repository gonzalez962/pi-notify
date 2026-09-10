# pi-notify

Send [Pi](https://github.com/earendil-works/pi) agent hook events to Telegram, using a bot token and a list of chat ids.

It notifies the moments that actually need you — **the agent finished the task**, or **Pi is blocked asking you a question** — instead of streaming every turn and tool call into your chat. Configuration lives behind a single `/telegram` command.

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

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Get your chat id: send any message to your bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[].message.chat.id`.
   Groups and channels use negative ids (`-1001234567890`).
3. In Pi:

```
/telegram setup
```

Or step by step:

```
/telegram token 123456:AA...
/telegram chat add 123456789 -1001234567890
/telegram test
```

The default hook set is already the useful one (`agent_settled` + `ui_prompt_start`), so token and chats are usually all you need.

## Command reference

| Command | Effect |
|---------|--------|
| `/telegram` or `/telegram status` | Show the current configuration and whether it is ready to send |
| `/telegram setup` | Interactive wizard: token, chat ids, hooks |
| `/telegram on` / `/telegram off` | Enable or disable notifications |
| `/telegram token <bot-token>` | Store the bot token |
| `/telegram chat add <id> [id...]` | Add destination chats |
| `/telegram chat remove <id> [id...]` | Remove destination chats |
| `/telegram events <name> [name...]` | Replace the subscribed hooks (`attention` for the default pair, `all` for every hook) |
| `/telegram events list` | List every supported hook and mark the subscribed ones |
| `/telegram set <key> <value>` | `parseMode`, `silent`, `includeProject`, `workspaceName`, `timeoutMs`, `throttleMs`, `mainAgentOnly` |
| `/telegram test [message]` | Send a test message to every configured chat |

## Configuration

Stored at `~/.pi/pi-notify/telegram.json` (override the directory with `PI_NOTIFY_CONFIG_HOME`):

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

| Key | Meaning |
|-----|---------|
| `enabled` | Master switch; when `false` no hook ever sends |
| `botToken` | Telegram bot token; prefer the environment variable below |
| `chatIds` | Destination chats: numeric ids or `@public_channel` usernames |
| `events` | Hook names that trigger a message |
| `parseMode` | `HTML` (default), `MarkdownV2` or `none` |
| `silent` | Deliver without sound |
| `includeProject` | Prefix messages with the project directory name |
| `workspaceName` | Optional workspace label rendered between the event title and the Pi session name. Empty (the default) disables the segment. Multi-word values are supported, but the parser normalizes consecutive whitespace to a single space. Set with `/telegram set workspaceName <text>`; clear with `/telegram set workspaceName none`. Capped at 100 Unicode code units (overlong command input is rejected with a clear error; overlong persisted values are truncated on load) |
| `timeoutMs` | HTTP timeout per Telegram call (1000–120000) |
| `throttleMs` | Minimum delay between two messages of the same hook; `0` disables it |
| `mainAgentOnly` | When `true` (default), suppress hook notifications unless `ctx.mode === "tui"`. Set `false` to also deliver from JSON-mode subagent processes |

### Token from the environment

`PI_NOTIFY_TELEGRAM_BOT_TOKEN`, then `TELEGRAM_BOT_TOKEN`, take precedence over the stored value — useful on shared machines and CI, where the token should not sit on disk. When the token is written to the config file, the file is chmod `600` on POSIX systems.

## Supported hooks

Five hooks, on purpose. A notification you get on every turn is a log, not a notification.

| Hook | Fires when | In `attention` |
|------|-----------|----------------|
| `agent_settled` | The agent finished the task and nothing else is queued. Carries the agent's last answer. | ✅ |
| `ui_prompt_start` | Pi is **blocked** waiting for your answer (confirm, select, input). Carries the question. | ✅ |
| `session_compact_failed` | Context compaction failed | |
| `session_start` | A session started, resumed or forked | |
| `session_shutdown` | The session ended | |

`/telegram events attention` restores the default pair; `/telegram events all` subscribes to the five.

### What is deliberately excluded

- **High-frequency hooks** — `turn_start`, `turn_end`, `message_end`, `tool_call`, `tool_result`, `tool_execution_*`, `input`, `before_agent_start`, `agent_start`, `model_select`, `after_provider_response`. They fire constantly during a normal run; forwarding them turns the chat into a log.
- **Decision hooks** — `project_trust`, `session_before_*`, `context`, `before_provider_*`. Their handler returns a value Pi obeys, so a notifier hooked there could cancel a compaction or block the agent loop. A notifier must never influence what the agent does.
- **`agent_end`** — fires once per low-level run, so a retry or an auto-compaction would deliver two or three messages for one task. The extension keeps an internal `agent_end` listener so `agent_settled` can carry the agent's last answer, but `agent_end` is not in the public subscribable set. Existing configs that still name `agent_end` silently fall back to the default hook set after normalization.

### Why `agent_settled` and not `agent_end`

`agent_end` fires once per agent run, so a retry or an auto-compaction gives you two or three messages for one task. `agent_settled` fires once, after everything has settled — but Pi hands it no messages. The extension keeps the last assistant answer it saw on `agent_end` (the internal listener is always wired, whether or not `agent_end` is subscribed) and attaches it, so you get **one** notification per task, with the reply in it.

## Behaviour guarantees

- Every Telegram message starts with a bold heading. The present segments are joined with ` — ` in a fixed order: **event title → `workspaceName` → Pi session name → project label**. Absent segments are dropped, so the heading never carries a stray separator. The Pi session name lives in the heading, not in a separate `Session:` field.
- Sends are fire-and-forget: a hook never blocks the agent loop on an HTTP call.
- Network and Telegram errors never propagate into Pi; failures surface as a UI warning.
- Pending sends are drained on `session_shutdown`, so the last notification is not lost.
- Messages are truncated to Telegram's 4096-character limit, and escaped for the active parse mode.
- `mainAgentOnly` defaults to `true`, so canonical Pi subagents (which run as a separate `pi --mode json -p --no-session` process and load the same extensions) stay quiet. Set `/telegram set mainAgentOnly false` to also deliver from JSON-mode subagent processes.

## Development

```bash
npm test
```

The suite covers config normalization and persistence, hook formatting, Telegram escaping and transport, command parsing, and the extension wiring end to end against a fake Pi API.

## License

MIT
