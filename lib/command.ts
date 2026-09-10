import { WORKSPACE_NAME_MAX_CODE_UNITS } from "./config.ts";
import { ATTENTION_EVENTS, SUPPORTED_EVENTS, isSupportedEvent } from "./events.ts";

export type ParsedCommand =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "setup" }
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "token"; value: string }
	| { kind: "add-chat"; values: string[] }
	| { kind: "remove-chat"; values: string[] }
	| { kind: "events"; values: string[] }
	| { kind: "list-events" }
	| {
			kind: "set";
			key: "parseMode" | "silent" | "includeProject" | "workspaceName" | "timeoutMs" | "throttleMs" | "mainAgentOnly";
			value: string;
	  }
	| { kind: "test"; message?: string }
	| { kind: "error"; message: string };

const SETTABLE = new Set([
	"parseMode",
	"silent",
	"includeProject",
	"workspaceName",
	"timeoutMs",
	"throttleMs",
	"mainAgentOnly",
]);

export const HELP_TEXT = [
	"/telegram — send Pi hook events to Telegram",
	"",
	"  status                    show current configuration",
	"  setup                     interactive wizard (token, chats, events)",
	"  on | off                  enable or disable notifications",
	"  token <bot-token>         store the bot token",
	"  chat add <id> [id...]     add destination chat ids",
	"  chat remove <id> [id...]  remove destination chat ids",
	"  events <name> [name...]   replace the subscribed hooks",
	"  events attention          only the hooks that need you (default)",
	"  events all                every supported hook",
	"  events list               list every supported hook",
	"  set <key> <value>         parseMode | silent | includeProject | workspaceName | timeoutMs | throttleMs | mainAgentOnly",
	"  test [message]            send a test message to every chat",
	"",
	"The token can also come from PI_NOTIFY_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN,",
	"which take precedence over the stored value.",
	"mainAgentOnly defaults to true: notifications fire only from the interactive TUI",
	"agent so JSON-mode subagent processes stay quiet. Set false to also deliver",
	"from json/rpc/print modes.",
].join("\n");

export function parseCommand(args: string): ParsedCommand {
	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return { kind: "status" };

	const [verb, ...rest] = tokens;
	switch (verb) {
		case "help":
		case "-h":
		case "--help":
			return { kind: "help" };
		case "status":
			return { kind: "status" };
		case "setup":
			return { kind: "setup" };
		case "on":
		case "enable":
			return { kind: "enable" };
		case "off":
		case "disable":
			return { kind: "disable" };
		case "token": {
			const value = rest.join(" ").trim();
			if (value.length === 0) return { kind: "error", message: "usage: /telegram token <bot-token>" };
			return { kind: "token", value };
		}
		case "chat": {
			const [action, ...ids] = rest;
			if (action !== "add" && action !== "remove") {
				return { kind: "error", message: "usage: /telegram chat add|remove <id> [id...]" };
			}
			if (ids.length === 0) return { kind: "error", message: `usage: /telegram chat ${action} <id> [id...]` };
			return action === "add" ? { kind: "add-chat", values: ids } : { kind: "remove-chat", values: ids };
		}
		case "events": {
			if (rest.length === 0 || rest[0] === "list") return { kind: "list-events" };
			if (rest.length === 1 && (rest[0] === "all" || rest[0] === "*")) {
				return { kind: "events", values: [...SUPPORTED_EVENTS] };
			}
			if (rest.length === 1 && rest[0] === "attention") {
				return { kind: "events", values: [...ATTENTION_EVENTS] };
			}
			const unknown = rest.filter((name) => !isSupportedEvent(name));
			if (unknown.length > 0) {
				return { kind: "error", message: `unknown hook(s): ${unknown.join(", ")} — run /telegram events list` };
			}
			return { kind: "events", values: rest };
		}
		case "set": {
			const [key, ...valueParts] = rest;
			if (key === undefined || !SETTABLE.has(key)) {
				return { kind: "error", message: `usage: /telegram set <${[...SETTABLE].join("|")}> <value>` };
			}
			const value = valueParts.join(" ").trim();
			if (value.length === 0) return { kind: "error", message: `usage: /telegram set ${key} <value>` };
			return { kind: "set", key: key as "parseMode" | "workspaceName", value };
		}
		case "test":
			return { kind: "test", message: rest.join(" ").trim() || undefined };
		default:
			return { kind: "error", message: `unknown subcommand: ${verb} — run /telegram help` };
	}
}

export interface AppliedSetting {
	ok: boolean;
	message: string;
	patch?: Record<string, unknown>;
}

export function applySetting(key: string, value: string): AppliedSetting {
	switch (key) {
		case "parseMode": {
			const normalized = ["HTML", "MarkdownV2", "none"].find(
				(mode) => mode.toLowerCase() === value.toLowerCase(),
			);
			if (normalized === undefined) return { ok: false, message: "parseMode must be HTML, MarkdownV2 or none" };
			return { ok: true, message: `parseMode = ${normalized}`, patch: { parseMode: normalized } };
		}
		case "silent":
		case "includeProject":
		case "mainAgentOnly": {
			if (!["true", "false"].includes(value.toLowerCase())) {
				return { ok: false, message: `${key} must be true or false` };
			}
			const parsed = value.toLowerCase() === "true";
			return { ok: true, message: `${key} = ${parsed}`, patch: { [key]: parsed } };
		}
		case "workspaceName": {
			// `none` (case-insensitive) is the explicit clear token so users have a
			// single obvious way to disable the segment without leaving a stale
			// value behind. Empty input is rejected to avoid silently clearing.
			if (value.toLowerCase() === "none") {
				return { ok: true, message: "workspaceName = (none)", patch: { workspaceName: "" } };
			}
			const trimmed = value.trim();
			if (trimmed.length === 0) {
				return { ok: false, message: "workspaceName must be non-empty, or 'none' to clear" };
			}
			// Bound to 100 Unicode code units so the heading can never dominate
			// the 4096-char Telegram message limit and force whole-message
			// truncation that drops the body. The same cap is enforced on load
			// for persisted configs (see normalizeWorkspaceName).
			if (trimmed.length > WORKSPACE_NAME_MAX_CODE_UNITS) {
				return {
					ok: false,
					message: `workspaceName must be at most ${WORKSPACE_NAME_MAX_CODE_UNITS} Unicode code units`,
				};
			}
			return { ok: true, message: `workspaceName = ${trimmed}`, patch: { workspaceName: trimmed } };
		}
		case "timeoutMs":
		case "throttleMs": {
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed) || parsed < 0) return { ok: false, message: `${key} must be a positive integer` };
			return { ok: true, message: `${key} = ${parsed}`, patch: { [key]: parsed } };
		}
		default:
			return { ok: false, message: `unknown setting: ${key}` };
	}
}
