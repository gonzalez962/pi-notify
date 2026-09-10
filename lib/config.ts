import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ATTENTION_EVENTS, SUPPORTED_EVENTS, isSupportedEvent } from "./events.ts";

export type ParseMode = "HTML" | "MarkdownV2" | "none";

export interface NotifyConfig {
	/** Master switch. When false no hook ever sends a message. */
	enabled: boolean;
	/** Telegram bot token. Prefer the environment variable over storing it here. */
	botToken: string;
	/** Destination chats. Groups and channels use negative ids. */
	chatIds: string[];
	/** Hook names that trigger a message. */
	events: string[];
	parseMode: ParseMode;
	/** Deliver without sound. */
	silent: boolean;
	/** Prefix every message with the project directory name. */
	includeProject: boolean;
	/**
	 * Optional workspace label rendered in the heading between the event
	 * title and the Pi session name. Empty string disables the segment so
	 * callers can opt in per-project without touching the heading layout.
	 */
	workspaceName: string;
	/** HTTP timeout per Telegram call. */
	timeoutMs: number;
	/** Minimum delay between two messages for the same hook. 0 disables throttling. */
	throttleMs: number;
	/**
	 * Restrict notifications to the interactive TUI session. When `true` (the
	 * default) hook notifications are suppressed unless `ctx.mode === "tui"`,
	 * so a JSON-mode subagent process stays quiet. When `ctx.mode` is not
	 * available the setting is bypassed to preserve backward compatibility.
	 * Set to `false` to deliver from json/rpc/print modes as well.
	 */
	mainAgentOnly: boolean;
}

export const DEFAULT_CONFIG: NotifyConfig = {
	enabled: true,
	botToken: "",
	chatIds: [],
	events: [...ATTENTION_EVENTS],
	parseMode: "HTML",
	silent: false,
	includeProject: true,
	workspaceName: "",
	timeoutMs: 10_000,
	throttleMs: 0,
	mainAgentOnly: true,
};

const PARSE_MODES: ParseMode[] = ["HTML", "MarkdownV2", "none"];

export function configHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_NOTIFY_CONFIG_HOME ?? join(homedir(), ".pi", "pi-notify");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configHome(env), "telegram.json");
}

function normalizeChatId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	// Numeric ids (users, groups, channels) or @public_channel usernames.
	if (/^-?\d+$/.test(trimmed) || /^@[A-Za-z0-9_]{4,}$/.test(trimmed)) return trimmed;
	return undefined;
}

export function normalizeChatIds(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [];
	const out: string[] = [];
	for (const entry of raw) {
		const id = normalizeChatId(entry);
		if (id !== undefined && !out.includes(id)) out.push(id);
	}
	return out;
}

export function normalizeEvents(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [];
	if (raw.includes("*")) return [...SUPPORTED_EVENTS];
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const name = entry.trim();
		if (!isSupportedEvent(name) || out.includes(name)) continue;
		out.push(name);
	}
	return out;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * Maximum length of the workspace name in Unicode code units (UTF-16). The
 * value is bounded so it cannot dominate the 4096-char Telegram message limit
 * and force whole-message truncation that drops the body. Command input that
 * exceeds this cap is rejected; persisted values are truncated here so a
 * stale config from an older or third-party writer never breaks a session.
 */
export const WORKSPACE_NAME_MAX_CODE_UNITS = 100;

function normalizeWorkspaceName(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed.length === 0) return "";
	if (trimmed.length > WORKSPACE_NAME_MAX_CODE_UNITS) {
		return trimmed.slice(0, WORKSPACE_NAME_MAX_CODE_UNITS);
	}
	return trimmed;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function normalizeConfig(value: unknown): NotifyConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_CONFIG };
	const raw = value as Record<string, unknown>;
	const parseMode = PARSE_MODES.includes(raw.parseMode as ParseMode)
		? (raw.parseMode as ParseMode)
		: DEFAULT_CONFIG.parseMode;
	const events = normalizeEvents(raw.events);
	return {
		enabled: normalizeBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
		botToken: typeof raw.botToken === "string" ? raw.botToken.trim() : DEFAULT_CONFIG.botToken,
		chatIds: normalizeChatIds(raw.chatIds),
		events: events.length > 0 ? events : [...DEFAULT_CONFIG.events],
		parseMode,
		silent: normalizeBoolean(raw.silent, DEFAULT_CONFIG.silent),
		includeProject: normalizeBoolean(raw.includeProject, DEFAULT_CONFIG.includeProject),
		workspaceName: normalizeWorkspaceName(raw.workspaceName),
		timeoutMs: normalizeInteger(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1_000, 120_000),
		throttleMs: normalizeInteger(raw.throttleMs, DEFAULT_CONFIG.throttleMs, 0, 3_600_000),
		mainAgentOnly: normalizeBoolean(raw.mainAgentOnly, DEFAULT_CONFIG.mainAgentOnly),
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
	const path = configPath(env);
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// A corrupt config must never break a session; fall back to defaults.
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: NotifyConfig, env: NodeJS.ProcessEnv = process.env): string {
	const path = configPath(env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
	if (process.platform !== "win32") {
		// The file may hold a bot token; keep it owner-readable only.
		try {
			chmodSync(path, 0o600);
		} catch {
			// Permission hardening is best effort.
		}
	}
	return path;
}

/** Environment wins over the stored token so CI and shared machines never need it on disk. */
export function resolveBotToken(config: NotifyConfig, env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.PI_NOTIFY_TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_BOT_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	return config.botToken.trim();
}

export function redactToken(token: string): string {
	if (token.length === 0) return "(not set)";
	const [id] = token.split(":");
	return `${id ?? "?"}:${"*".repeat(6)}`;
}

export interface ConfigProblem {
	field: "botToken" | "chatIds" | "events" | "enabled";
	message: string;
}

export function validateForSend(config: NotifyConfig, token: string): ConfigProblem[] {
	const problems: ConfigProblem[] = [];
	if (!config.enabled) problems.push({ field: "enabled", message: "notifications are disabled" });
	if (token.length === 0) problems.push({ field: "botToken", message: "no bot token configured" });
	if (config.chatIds.length === 0) problems.push({ field: "chatIds", message: "no chat ids configured" });
	if (config.events.length === 0) problems.push({ field: "events", message: "no events selected" });
	return problems;
}
