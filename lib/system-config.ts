import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SystemEventType =
	| "permission"
	| "complete"
	| "subagent_complete"
	| "error"
	| "question"
	| "user_cancelled"
	| "plan_exit"
	| "session_started"
	| "user_message"
	| "client_connected";

export const SYSTEM_EVENT_TYPES: SystemEventType[] = [
	"permission",
	"complete",
	"subagent_complete",
	"error",
	"question",
	"user_cancelled",
	"plan_exit",
	"session_started",
	"user_message",
	"client_connected",
];

export interface EventActionConfig {
	sound: boolean;
	notification: boolean;
	command: boolean;
	bell: boolean;
}

export interface CommandConfig {
	enabled: boolean;
	path: string;
	args: string[];
	minDuration: number;
}

export interface LinuxConfig {
	grouping: boolean;
}

export interface WindowsConfig {
	appID: string;
}

export interface SystemConfig {
	/** Master switch for system alerts (desktop notification, sound, bell, command). */
	enabled: boolean;
	sound: boolean;
	notification: boolean;
	bell: boolean;
	timeout: number;
	showProjectName: boolean;
	showFullPath: boolean;
	showSessionTitle: boolean;
	showIcon: boolean;
	customIconPath: string | null;
	suppressWhenFocused: boolean;
	enableOnDesktop: boolean;
	notificationSystem: "osascript" | "ghostty";
	suppressGhosttySound: boolean;
	linux: LinuxConfig;
	windows: WindowsConfig;
	minDuration: number;
	mainAgentOnly: boolean;
	command: CommandConfig;
	events: Record<SystemEventType, EventActionConfig>;
	messages: Record<SystemEventType, string>;
	sounds: Record<SystemEventType, string | null>;
	volumes: Record<SystemEventType, number>;
}

export const DEFAULT_EVENT_ACTION: EventActionConfig = {
	sound: true,
	notification: true,
	command: true,
	bell: false,
};

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
	enabled: true,
	sound: true,
	notification: true,
	bell: false,
	timeout: 5,
	showProjectName: true,
	showFullPath: false,
	showSessionTitle: false,
	showIcon: true,
	customIconPath: null,
	suppressWhenFocused: true,
	enableOnDesktop: false,
	notificationSystem: "osascript",
	suppressGhosttySound: false,
	linux: {
		grouping: false,
	},
	windows: {
		appID: "pi",
	},
	minDuration: 0,
	mainAgentOnly: true,
	command: {
		enabled: false,
		path: "",
		args: ["--event", "{event}", "--message", "{message}"],
		minDuration: 0,
	},
	events: {
		permission: { ...DEFAULT_EVENT_ACTION },
		complete: { ...DEFAULT_EVENT_ACTION },
		subagent_complete: { ...DEFAULT_EVENT_ACTION, sound: false, notification: false },
		error: { ...DEFAULT_EVENT_ACTION },
		question: { ...DEFAULT_EVENT_ACTION },
		user_cancelled: { ...DEFAULT_EVENT_ACTION, sound: false, notification: false },
		plan_exit: { ...DEFAULT_EVENT_ACTION },
		session_started: { ...DEFAULT_EVENT_ACTION, notification: false },
		user_message: { ...DEFAULT_EVENT_ACTION, notification: false },
		client_connected: { ...DEFAULT_EVENT_ACTION, notification: false },
	},
	messages: {
		permission: "Session needs permission: {sessionTitle}",
		complete: "Session has finished: {sessionTitle}",
		subagent_complete: "Subagent task completed: {sessionTitle}",
		error: "Session encountered an error: {sessionTitle}",
		question: "Session has a question: {sessionTitle}",
		user_cancelled: "Session was cancelled by user: {sessionTitle}",
		plan_exit: "Plan ready for review: {sessionTitle}",
		session_started: "Session started: {sessionTitle}",
		user_message: "User sent a message: {sessionTitle}",
		client_connected: "Pi connected",
	},
	sounds: {
		permission: null,
		complete: null,
		subagent_complete: null,
		error: null,
		question: null,
		user_cancelled: null,
		plan_exit: null,
		session_started: null,
		user_message: null,
		client_connected: null,
	},
	volumes: {
		permission: 1,
		complete: 1,
		subagent_complete: 1,
		error: 1,
		question: 1,
		user_cancelled: 1,
		plan_exit: 1,
		session_started: 1,
		user_message: 1,
		client_connected: 1,
	},
};

export interface MessageContext {
	sessionTitle?: string | null;
	agentName?: string | null;
	projectName?: string | null;
	timestamp?: string | null;
	turn?: number | null;
	durationMs?: number | null;
}

export function interpolateMessage(message: string, context: MessageContext): string {
	let result = message;
	const sessionTitle = context.sessionTitle || "";
	result = result.replaceAll("{sessionTitle}", sessionTitle);
	const agentName = context.agentName || "";
	result = result.replaceAll("{agentName}", agentName);
	const projectName = context.projectName || "";
	result = result.replaceAll("{projectName}", projectName);
	const timestamp = context.timestamp || "";
	result = result.replaceAll("{timestamp}", timestamp);
	const turn = context.turn != null ? String(context.turn) : "";
	result = result.replaceAll("{turn}", turn);
	result = result.replace(/\s*[:\-|]\s*$/, "").trim();
	result = result.replace(/\s{2,}/g, " ");
	return result;
}

export function formatTimestamp(date: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function configHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_NOTIFY_CONFIG_HOME ?? join(homedir(), ".pi", "pi-notify");
}

export function systemConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_NOTIFY_SYSTEM_CONFIG_PATH ?? join(configHome(env), "system.json");
}

export function systemStatePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configHome(env), "system-state.json");
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function normalizeString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function normalizeStringOrNull(value: unknown, fallback: string | null): string | null {
	if (value === null) return null;
	if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
	return fallback;
}

function normalizeVolume(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function normalizeEventAction(raw: unknown, fallback: EventActionConfig): EventActionConfig {
	if (typeof raw === "boolean") {
		return { sound: raw, notification: raw, command: raw, bell: fallback.bell };
	}
	if (typeof raw !== "object" || raw === null) return { ...fallback };
	const r = raw as Record<string, unknown>;
	return {
		sound: normalizeBoolean(r.sound, fallback.sound),
		notification: normalizeBoolean(r.notification, fallback.notification),
		command: normalizeBoolean(r.command, fallback.command),
		bell: normalizeBoolean(r.bell, fallback.bell),
	};
}

export function normalizeSystemConfig(raw: unknown): SystemConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return JSON.parse(JSON.stringify(DEFAULT_SYSTEM_CONFIG));
	}
	const r = raw as Record<string, unknown>;
	const base = DEFAULT_SYSTEM_CONFIG;

	const notificationSystem = r.notificationSystem === "ghostty" ? "ghostty" : "osascript";

	const events = { ...base.events };
	if (typeof r.events === "object" && r.events !== null) {
		const rawEvents = r.events as Record<string, unknown>;
		for (const ev of SYSTEM_EVENT_TYPES) {
			if (ev in rawEvents) {
				events[ev] = normalizeEventAction(rawEvents[ev], base.events[ev]);
			}
		}
	}

	const messages = { ...base.messages };
	if (typeof r.messages === "object" && r.messages !== null) {
		const rawMessages = r.messages as Record<string, unknown>;
		for (const ev of SYSTEM_EVENT_TYPES) {
			if (typeof rawMessages[ev] === "string") {
				messages[ev] = rawMessages[ev] as string;
			}
		}
	}

	const sounds = { ...base.sounds };
	if (typeof r.sounds === "object" && r.sounds !== null) {
		const rawSounds = r.sounds as Record<string, unknown>;
		for (const ev of SYSTEM_EVENT_TYPES) {
			if (ev in rawSounds) {
				sounds[ev] = normalizeStringOrNull(rawSounds[ev], base.sounds[ev]);
			}
		}
	}

	const volumes = { ...base.volumes };
	if (typeof r.volumes === "object" && r.volumes !== null) {
		const rawVolumes = r.volumes as Record<string, unknown>;
		for (const ev of SYSTEM_EVENT_TYPES) {
			if (ev in rawVolumes) {
				volumes[ev] = normalizeVolume(rawVolumes[ev], base.volumes[ev]);
			}
		}
	}

	const rawCmd = (typeof r.command === "object" && r.command !== null ? r.command : {}) as Record<string, unknown>;
	const command: CommandConfig = {
		enabled: normalizeBoolean(rawCmd.enabled, base.command.enabled),
		path: normalizeString(rawCmd.path, base.command.path),
		args: Array.isArray(rawCmd.args)
			? rawCmd.args.filter((a): a is string => typeof a === "string")
			: [...base.command.args],
		minDuration: normalizeNumber(rawCmd.minDuration, base.command.minDuration, 0, 86400),
	};

	const rawLinux = (typeof r.linux === "object" && r.linux !== null ? r.linux : {}) as Record<string, unknown>;
	const linux: LinuxConfig = {
		grouping: normalizeBoolean(rawLinux.grouping, base.linux.grouping),
	};

	const rawWindows = (typeof r.windows === "object" && r.windows !== null ? r.windows : {}) as Record<string, unknown>;
	const windows: WindowsConfig = {
		appID: normalizeString(rawWindows.appID, base.windows.appID),
	};

	return {
		enabled: normalizeBoolean(r.enabled, base.enabled),
		sound: normalizeBoolean(r.sound, base.sound),
		notification: normalizeBoolean(r.notification, base.notification),
		bell: normalizeBoolean(r.bell, base.bell),
		timeout: normalizeNumber(r.timeout, base.timeout, 1, 300),
		showProjectName: normalizeBoolean(r.showProjectName, base.showProjectName),
		showFullPath: normalizeBoolean(r.showFullPath, base.showFullPath),
		showSessionTitle: normalizeBoolean(r.showSessionTitle, base.showSessionTitle),
		showIcon: normalizeBoolean(r.showIcon, base.showIcon),
		customIconPath: normalizeStringOrNull(r.customIconPath, base.customIconPath),
		suppressWhenFocused: normalizeBoolean(r.suppressWhenFocused, base.suppressWhenFocused),
		enableOnDesktop: normalizeBoolean(r.enableOnDesktop, base.enableOnDesktop),
		notificationSystem,
		suppressGhosttySound: normalizeBoolean(r.suppressGhosttySound, base.suppressGhosttySound),
		linux,
		windows,
		minDuration: normalizeNumber(r.minDuration, base.minDuration, 0, 86400),
		mainAgentOnly: normalizeBoolean(r.mainAgentOnly, base.mainAgentOnly),
		command,
		events,
		messages,
		sounds,
		volumes,
	};
}

export function loadSystemConfig(env: NodeJS.ProcessEnv = process.env): SystemConfig {
	const path = systemConfigPath(env);
	if (!existsSync(path)) return JSON.parse(JSON.stringify(DEFAULT_SYSTEM_CONFIG));
	try {
		return normalizeSystemConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return JSON.parse(JSON.stringify(DEFAULT_SYSTEM_CONFIG));
	}
}

export function saveSystemConfig(config: SystemConfig, env: NodeJS.ProcessEnv = process.env): string {
	const path = systemConfigPath(env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalizeSystemConfig(config), null, 2)}\n`, "utf8");
	if (process.platform !== "win32") {
		try {
			chmodSync(path, 0o600);
		} catch {
			// Best effort permission hardening
		}
	}
	return path;
}

export function loadTurnCount(env: NodeJS.ProcessEnv = process.env): number {
	const path = systemStatePath(env);
	if (!existsSync(path)) return 0;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw?.turn === "number" && Number.isFinite(raw.turn) && raw.turn >= 0) {
			return Math.trunc(raw.turn);
		}
	} catch {
		// Ignore corrupted state
	}
	return 0;
}

export function saveTurnCount(turn: number, env: NodeJS.ProcessEnv = process.env): void {
	const path = systemStatePath(env);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ turn }), "utf8");
	} catch {
		// Ignore write errors
	}
}

let sessionTurnCount: number | null = null;

export function incrementTurnCount(env: NodeJS.ProcessEnv = process.env): number {
	if (sessionTurnCount === null) {
		sessionTurnCount = loadTurnCount(env);
	}
	sessionTurnCount += 1;
	saveTurnCount(sessionTurnCount, env);
	return sessionTurnCount;
}

export function resetSessionTurnCount(): void {
	sessionTurnCount = null;
}
