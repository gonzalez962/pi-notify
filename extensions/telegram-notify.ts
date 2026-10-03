import { basename } from "node:path";
import {
	type NotifyConfig,
	configPath,
	loadConfig,
	normalizeChatIds,
	redactToken,
	resolveBotToken,
	saveConfig,
	validateForSend,
} from "../lib/config.ts";
import {
	type MessageContext,
	type SystemConfig,
	type SystemEventType,
	DEFAULT_SYSTEM_CONFIG,
	formatTimestamp,
	incrementTurnCount,
	interpolateMessage,
	loadSystemConfig,
	saveSystemConfig,
	systemConfigPath,
} from "../lib/system-config.ts";
import {
	HELP_TEXT,
	NOTIFY_HELP_TEXT,
	applySetting,
	parseCommand,
	parseNotifyCommand,
} from "../lib/command.ts";
import {
	SUPPORTED_EVENTS,
	describeEvent,
	eventDescription,
	eventTitle,
	lastAssistantText,
} from "../lib/events.ts";
import { type SendResult, broadcast, renderMessage } from "../lib/telegram.ts";
import { cancelSoundProcesses, playSound } from "../lib/sound.ts";
import { ringBell } from "../lib/bell.ts";
import { isTerminalFocused } from "../lib/focus.ts";
import { runCustomCommand } from "../lib/custom-command.ts";
import { cancelSystemNotificationProcesses, sendSystemNotification } from "../lib/system-notify.ts";
import { initHerdrTracker, isHerdrActive, resetActiveHerdrTracker } from "../lib/herdr.ts";

// The Pi types are an optional peer dependency; keep the extension loadable
// even when they are not installed next to it.
type ExtensionAPI = any;
type ExtensionContext = any;

export interface SystemDrivers {
	sendNotification?: (options: any) => Promise<boolean>;
	playSound?: (event: any, customPath: any, volume: any) => Promise<boolean>;
	ringBell?: (now?: number) => boolean;
	isFocused?: () => boolean;
	runCommand?: (config: any, event: any, message: any, ctx: any) => boolean;
}

export const EXTENSION_SHUTDOWN_TIMEOUT_MS = 1_000;

let activeDrivers: SystemDrivers = {};

export function setSystemDrivers(drivers: SystemDrivers): void {
	activeDrivers = drivers;
}

export function resetSystemDrivers(): void {
	activeDrivers = {};
}

export default function telegramNotify(pi: ExtensionAPI): void {
	let config: NotifyConfig = loadConfig();
	let systemConfig: SystemConfig = loadSystemConfig();
	const herdrTracker = initHerdrTracker(pi, {
		showAgentPrefix: systemConfig.herdr.showAgentName,
	});
	const lastSentAt = new Map<string, number>();
	const inFlight = new Set<Promise<unknown>>();
	/** Last assistant answer seen, so `agent_settled` can carry the actual reply. */
	let lastAnswer = "";
	/** Suppress the next `agent_settled` when the latest `agent_end` was aborted. */
	let nextSettledSuppressed = false;
	let sessionStartTime = Date.now();

	function reload(): void {
		config = loadConfig();
		systemConfig = loadSystemConfig();
		herdrTracker?.setShowAgentPrefix(systemConfig.herdr.showAgentName);
	}

	function persist(next: NotifyConfig): void {
		saveConfig(next);
		config = loadConfig();
	}

	function persistSystem(next: SystemConfig): void {
		saveSystemConfig(next);
		systemConfig = loadSystemConfig();
		herdrTracker?.setShowAgentPrefix(systemConfig.herdr.showAgentName);
	}

	function sessionName(): string | undefined {
		try {
			const name = pi.getSessionName?.();
			return typeof name === "string" && name.length > 0 ? name : undefined;
		} catch {
			return undefined;
		}
	}

	function projectLabel(ctx: ExtensionContext): string | undefined {
		if (!config.includeProject) return undefined;
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
		return cwd ? basename(cwd) : undefined;
	}

	function systemProjectLabel(ctx: ExtensionContext): string | undefined {
		if (!systemConfig.showProjectName) return undefined;
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
		if (!cwd) return undefined;
		return systemConfig.showFullPath ? cwd : basename(cwd);
	}

	function throttled(eventName: string, now: number): boolean {
		if (config.throttleMs <= 0) return false;
		const previous = lastSentAt.get(eventName);
		if (previous !== undefined && now - previous < config.throttleMs) return true;
		lastSentAt.set(eventName, now);
		return false;
	}

	async function deliver(text: string): Promise<SendResult[]> {
		return broadcast({
			token: resolveBotToken(config),
			chatIds: config.chatIds,
			text,
			parseMode: config.parseMode,
			silent: config.silent,
			timeoutMs: config.timeoutMs,
		});
	}

	function track(promise: Promise<unknown>): void {
		inFlight.add(promise);
		void promise.finally(() => inFlight.delete(promise));
	}

	async function handleTelegramEvent(
		eventName: string,
		event: unknown,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!config.enabled || !config.events.includes(eventName)) return;
		if (validateForSend(config, resolveBotToken(config)).length > 0) return;
		if (throttled(eventName, Date.now())) return;
		// Restrict notifications to the interactive TUI session by default so
		// JSON-mode subagent processes stay quiet.
		if (config.mainAgentOnly) {
			const mode = (ctx as { mode?: unknown } | undefined)?.mode;
			if (typeof mode === "string" && mode !== "tui") return;
		}

		const payload = eventName === "agent_settled" ? { ...(event as object), answer: lastAnswer } : event;
		const text = renderMessage(
			describeEvent(eventName, payload),
			{
				project: projectLabel(ctx),
				session: sessionName(),
				workspaceName: config.workspaceName,
			},
			config.parseMode,
		);

		const results = await deliver(text);
		const failed = results.filter((result) => !result.ok);
		if (failed.length > 0 && ctx?.ui?.notify) {
			ctx.ui.notify(`Telegram: ${failed.length} chat(s) failed - ${failed[0]?.error ?? "unknown error"}`, "warn");
		}
	}

	async function dispatchSystemEvent(
		eventType: SystemEventType,
		_eventData: unknown,
		ctx?: ExtensionContext,
		options: { bypassFocus?: boolean } = {},
	): Promise<void> {
		if (!systemConfig.enabled) return;

		// Restrict to interactive TUI session by default so subagents stay quiet.
		if (systemConfig.mainAgentOnly) {
			const mode = (ctx as { mode?: unknown } | undefined)?.mode;
			if (typeof mode === "string" && mode !== "tui") return;
		}

		const actionConfig = systemConfig.events[eventType];
		if (!actionConfig) return;

		const project = systemProjectLabel(ctx);
		const session = sessionName();
		const timestamp = formatTimestamp();
		const turn = incrementTurnCount();
		const durationMs = Date.now() - sessionStartTime;

		const msgCtx: MessageContext = {
			sessionTitle: systemConfig.showSessionTitle ? (session ?? "") : "",
			projectName: project ?? "",
			timestamp,
			turn,
			durationMs,
		};

		const template = systemConfig.messages[eventType] ?? DEFAULT_SYSTEM_CONFIG.messages[eventType];
		const message = interpolateMessage(template, msgCtx);

		let notifTitle = "Pi";
		if (systemConfig.showProjectName && project) {
			notifTitle = `Pi (${project})`;
		}

		const isFocused =
			!options.bypassFocus &&
			systemConfig.suppressWhenFocused &&
			(activeDrivers.isFocused ? activeDrivers.isFocused() : isTerminalFocused());

		if (!isFocused) {
			if (systemConfig.notification && actionConfig.notification) {
				const notifyFn = activeDrivers.sendNotification ?? sendSystemNotification;
				await notifyFn({
					title: notifTitle,
					message,
					timeoutSec: systemConfig.timeout,
					iconPath: systemConfig.showIcon ? systemConfig.customIconPath : null,
					notificationSystem: systemConfig.notificationSystem,
					linuxGrouping: systemConfig.linux.grouping,
					appName: systemConfig.windows.appID,
				});
			}

			if (systemConfig.sound && actionConfig.sound) {
				const skipGhostty =
					systemConfig.suppressGhosttySound &&
					systemConfig.notificationSystem === "ghostty" &&
					!systemConfig.sounds[eventType];
				if (!skipGhostty) {
					const customSound = systemConfig.sounds[eventType];
					const volume = systemConfig.volumes[eventType] ?? 1;
					const soundFn = activeDrivers.playSound ?? playSound;
					await soundFn(eventType, customSound, volume);
				}
			}
		}

		if (systemConfig.bell && actionConfig.bell) {
			const bellFn = activeDrivers.ringBell ?? ringBell;
			bellFn();
		}

		if (systemConfig.command.enabled && actionConfig.command) {
			const cmdFn = activeDrivers.runCommand ?? runCustomCommand;
			cmdFn(systemConfig.command, eventType, message, msgCtx);
		}
	}

	/** Stop reason of the latest assistant message; `"aborted"` means the user cancelled the run. */
	function lastAssistantStopReason(messages: unknown): string | undefined {
		if (!Array.isArray(messages)) return undefined;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (typeof message !== "object" || message === null) continue;
			if ((message as { role?: unknown }).role !== "assistant") continue;
			const stopReason = (message as { stopReason?: unknown }).stopReason;
			return typeof stopReason === "string" ? stopReason : undefined;
		}
		return undefined;
	}

	// Runs whether or not `agent_end` is subscribed: `agent_settled` needs the text.
	pi.on("agent_end", (event: unknown, ctx: ExtensionContext) => {
		const messages = (event as { messages?: unknown } | undefined)?.messages;
		// Re-evaluated on every agent_end so the latest run is always the source of truth.
		const aborted = lastAssistantStopReason(messages) === "aborted";
		nextSettledSuppressed = aborted;
		if (aborted) {
			// Aborted partial text must never survive: a later successful but textless
			// run would otherwise notify with the cancelled run's stale answer.
			lastAnswer = "";
			track(dispatchSystemEvent("user_cancelled", event, ctx).catch(() => undefined));
			return undefined;
		}
		const answer = lastAssistantText(messages);
		if (answer.length > 0) lastAnswer = answer;
		return undefined;
	});

	pi.on("message_end", (event: unknown, ctx: ExtensionContext) => {
		const msg = (event as { message?: any } | undefined)?.message;
		if (msg?.customType === "gentle-agents.result") {
			track(dispatchSystemEvent("subagent_complete", event, ctx).catch(() => undefined));
		}
		return undefined;
	});

	for (const eventName of SUPPORTED_EVENTS) {
		pi.on(eventName, (event: unknown, ctx: ExtensionContext) => {
			if (eventName === "agent_settled") {
				if (nextSettledSuppressed) {
					nextSettledSuppressed = false;
					return undefined;
				}
				track(handleTelegramEvent(eventName, event, ctx).catch(() => undefined));
				const durationSec = (Date.now() - sessionStartTime) / 1000;
				if (systemConfig.minDuration <= 0 || durationSec >= systemConfig.minDuration) {
					track(dispatchSystemEvent("complete", event, ctx).catch(() => undefined));
				}
				return undefined;
			}

			if (eventName === "ui_prompt_start") {
				track(handleTelegramEvent(eventName, event, ctx).catch(() => undefined));
				const kind = (event as { kind?: unknown } | undefined)?.kind;
				const sysType: SystemEventType = kind === "confirm" ? "permission" : "question";
				track(dispatchSystemEvent(sysType, event, ctx).catch(() => undefined));
				return undefined;
			}

			if (eventName === "session_compact_failed") {
				track(handleTelegramEvent(eventName, event, ctx).catch(() => undefined));
				track(dispatchSystemEvent("error", event, ctx).catch(() => undefined));
				return undefined;
			}

			if (eventName === "session_start") {
				sessionStartTime = Date.now();
				reload();
				track(handleTelegramEvent(eventName, event, ctx).catch(() => undefined));
				track(dispatchSystemEvent("session_started", event, ctx).catch(() => undefined));
				return undefined;
			}

			if (eventName === "session_shutdown") {
				track(handleTelegramEvent(eventName, event, ctx).catch(() => undefined));
				return undefined;
			}

			track(handleTelegramEvent(eventName, event, ctx).catch(() => undefined));
			return undefined;
		});
	}

	pi.on("session_shutdown", async () => {
		herdrTracker?.dispose();
		resetActiveHerdrTracker();
		// Give network delivery a bounded grace period, then cancel owned desktop
		// child processes so shutdown cannot wait forever on a hung player.
		const drain = Promise.allSettled([...inFlight]);
		await Promise.race([
			drain,
			new Promise<void>((resolve) => setTimeout(resolve, EXTENSION_SHUTDOWN_TIMEOUT_MS)),
		]);
		cancelSoundProcesses();
		cancelSystemNotificationProcesses();
		return undefined;
	});

	function tokenSource(token: string): string {
		if (token.length === 0) return "none";
		const fromEnv = process.env.PI_NOTIFY_TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
		return fromEnv ? "environment" : "config file";
	}

	function statusLines(): string[] {
		const token = resolveBotToken(config);
		const problems = validateForSend(config, token);
		return [
			`enabled:        ${config.enabled}`,
			`bot token:      ${redactToken(token)} (${tokenSource(token)})`,
			`chat ids:       ${config.chatIds.length > 0 ? config.chatIds.join(", ") : "(none)"}`,
			`events:         ${config.events.join(", ")}`,
			`parseMode:      ${config.parseMode}`,
			`silent:         ${config.silent}`,
			`includeProject: ${config.includeProject}`,
			`workspaceName:  ${config.workspaceName.length > 0 ? config.workspaceName : "(none)"}`,
			`timeoutMs:      ${config.timeoutMs}`,
			`throttleMs:     ${config.throttleMs}`,
			`mainAgentOnly:  ${config.mainAgentOnly}`,
			`config file:    ${configPath()}`,
			problems.length > 0
				? `not ready:      ${problems.map((problem) => problem.message).join("; ")}`
				: "ready:          yes",
		];
	}

	function notifyStatusLines(): string[] {
		const token = resolveBotToken(config);
		const problems = validateForSend(config, token);
		return [
			"Notifications Status",
			"",
			"System channel:",
			`  enabled:             ${systemConfig.enabled}`,
			`  sound:               ${systemConfig.sound}`,
			`  notification:        ${systemConfig.notification}`,
			`  bell:                ${systemConfig.bell}`,
			`  suppressWhenFocused: ${systemConfig.suppressWhenFocused}`,
			`  minDuration:         ${systemConfig.minDuration}s`,
			`  notificationSystem:  ${systemConfig.notificationSystem}`,
			`  command:             ${systemConfig.command.enabled ? systemConfig.command.path : "(disabled)"}`,
			`  mainAgentOnly:       ${systemConfig.mainAgentOnly}`,
			`  config file:         ${systemConfigPath()}`,
			"",
			"Herdr channel:",
			`  active:              ${isHerdrActive() ? `yes (pane ${process.env.HERDR_PANE_ID})` : "no (not in Herdr)"}`,
			`  showAgentName:       ${systemConfig.herdr.showAgentName}`,
			"",
			"Telegram channel:",
			`  enabled:             ${config.enabled}`,
			`  bot token:           ${redactToken(token)} (${tokenSource(token)})`,
			`  chat ids:            ${config.chatIds.length > 0 ? config.chatIds.join(", ") : "(none)"}`,
			`  events:              ${config.events.join(", ")}`,
			`  mainAgentOnly:       ${config.mainAgentOnly}`,
			`  config file:         ${configPath()}`,
			problems.length > 0
				? `  not ready:           ${problems.map((problem) => problem.message).join("; ")}`
				: "  ready:               yes",
		];
	}

	async function runSetup(ctx: ExtensionContext): Promise<void> {
		const currentToken = resolveBotToken(config);
		const token = await ctx.ui.input(
			"Telegram bot token",
			currentToken.length > 0 ? `current: ${redactToken(currentToken)} (empty keeps it)` : "from @BotFather",
		);
		const chats = await ctx.ui.input(
			"Chat ids (comma or space separated)",
			config.chatIds.length > 0 ? `current: ${config.chatIds.join(", ")}` : "e.g. 123456789, -1001234567890",
		);
		const events = await ctx.ui.input(
			"Hooks to notify ('all' for every hook)",
			`current: ${config.events.join(", ")}`,
		);

		const next: NotifyConfig = { ...config };
		if (typeof token === "string" && token.trim().length > 0) next.botToken = token.trim();
		if (typeof chats === "string" && chats.trim().length > 0) {
			next.chatIds = normalizeChatIds(chats.split(/[,\s]+/));
		}
		if (typeof events === "string" && events.trim().length > 0) {
			const parsed = parseCommand(`events ${events.trim()}`);
			if (parsed.kind === "events") next.events = parsed.values;
			else if (parsed.kind === "error") ctx.ui.notify(parsed.message, "warn");
		}
		next.enabled = true;
		persist(next);
		ctx.ui.notify(["Telegram notifications configured.", ...statusLines()].join("\n"), "info");
	}

	pi.registerCommand("notify", {
		description: "Control Pi notifications across System and Telegram channels",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			if (trimmed.startsWith("system ")) {
				const sub = trimmed.slice(7);
				const verbs = ["on", "off", "focus", "sound"].filter((v) => v.startsWith(sub));
				return verbs.map((v) => ({ value: `system ${v}`, label: `system ${v}` }));
			}
			if (trimmed.startsWith("telegram ")) {
				const sub = trimmed.slice(9);
				const verbs = ["on", "off"].filter((v) => v.startsWith(sub));
				return verbs.map((v) => ({ value: `telegram ${v}`, label: `telegram ${v}` }));
			}
			if (trimmed.startsWith("focus ")) {
				const sub = trimmed.slice(6);
				const verbs = ["on", "off"].filter((v) => v.startsWith(sub));
				return verbs.map((v) => ({ value: `focus ${v}`, label: `focus ${v}` }));
			}
			if (trimmed.startsWith("sound ")) {
				const sub = trimmed.slice(6);
				const verbs = ["on", "off"].filter((v) => v.startsWith(sub));
				return verbs.map((v) => ({ value: `sound ${v}`, label: `sound ${v}` }));
			}
			if (trimmed.startsWith("herdr-name ") || trimmed.startsWith("herdr ")) {
				const sub = trimmed.startsWith("herdr ") ? trimmed.slice(6) : trimmed.slice(11);
				const verbs = ["on", "off"].filter((v) => v.startsWith(sub));
				return verbs.map((v) => ({ value: `herdr-name ${v}`, label: `herdr-name ${v}` }));
			}
			const verbs = ["status", "system", "telegram", "sound", "focus", "herdr-name", "on", "off", "test", "help"];
			const items = verbs.filter((v) => v.startsWith(trimmed)).map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			reload();
			const parsed = parseNotifyCommand(args ?? "");

			switch (parsed.kind) {
				case "help":
					ctx.ui.notify(NOTIFY_HELP_TEXT, "info");
					return;
				case "status":
					ctx.ui.notify(notifyStatusLines().join("\n"), "info");
					return;
				case "system-enable":
				case "system-disable": {
					const enabled = parsed.kind === "system-enable";
					persistSystem({ ...systemConfig, enabled });
					ctx.ui.notify(`System notifications ${enabled ? "enabled" : "disabled"}.`, "info");
					return;
				}
				case "telegram-enable":
				case "telegram-disable": {
					const enabled = parsed.kind === "telegram-enable";
					persist({ ...config, enabled });
					ctx.ui.notify(`Telegram notifications ${enabled ? "enabled" : "disabled"}.`, "info");
					return;
				}
				case "focus-enable":
				case "focus-disable": {
					const suppressWhenFocused = parsed.kind === "focus-enable";
					persistSystem({ ...systemConfig, suppressWhenFocused });
					ctx.ui.notify(
						`Focus suppression ${suppressWhenFocused ? "enabled (silent when focused)" : "disabled (alerts always fire)"}.`,
						"info",
					);
					return;
				}
				case "sound-enable":
				case "sound-disable": {
					const sound = parsed.kind === "sound-enable";
					persistSystem({ ...systemConfig, sound });
					ctx.ui.notify(`System sound ${sound ? "enabled" : "disabled"}.`, "info");
					return;
				}
				case "herdr-name-enable":
				case "herdr-name-disable": {
					const showAgentName = parsed.kind === "herdr-name-enable";
					persistSystem({ ...systemConfig, herdr: { ...systemConfig.herdr, showAgentName } });
					ctx.ui.notify(
						`Herdr agent prefix ${showAgentName ? "enabled ('pi [...]')" : "disabled ('[...]')"}.`,
						"info",
					);
					return;
				}
				case "enable-all": {
					persistSystem({ ...systemConfig, enabled: true });
					persist({ ...config, enabled: true });
					ctx.ui.notify("All notifications (System and Telegram) enabled.", "info");
					return;
				}
				case "disable-all": {
					persistSystem({ ...systemConfig, enabled: false });
					persist({ ...config, enabled: false });
					ctx.ui.notify("All notifications (System and Telegram) disabled.", "info");
					return;
				}
				case "test": {
					const msg = parsed.message ?? "Test notification from Pi";
					const notes: string[] = [];

					if (systemConfig.enabled) {
						await dispatchSystemEvent("complete", { test: true }, ctx, { bypassFocus: true });
						notes.push("System alert triggered.");
					} else {
						notes.push("System channel is disabled.");
					}

					const token = resolveBotToken(config);
					if (config.enabled && validateForSend(config, token).length === 0) {
						const text = renderMessage(
							{
								title: "Test notification",
								fields: [["Source", "pi-notify"]],
								body: msg,
							},
							{
								project: projectLabel(ctx),
								session: sessionName(),
								workspaceName: config.workspaceName,
							},
							config.parseMode,
						);
						const results = await deliver(text);
						const failed = results.filter((r) => !r.ok);
						if (failed.length === 0) {
							notes.push(`Telegram test sent to ${results.length} chat(s).`);
						} else {
							notes.push(`Telegram test failed for ${failed.length}/${results.length} chat(s).`);
						}
					} else if (config.enabled) {
						notes.push("Telegram is not ready (missing token or chats).");
					} else {
						notes.push("Telegram channel is disabled.");
					}

					ctx.ui.notify(notes.join(" "), "info");
					return;
				}
				case "error":
					ctx.ui.notify(parsed.message, "warn");
					return;
				default:
					ctx.ui.notify(NOTIFY_HELP_TEXT, "info");
			}
		},
	});

	pi.registerCommand("telegram", {
		description: "Configure Telegram notifications for Pi hooks",
		getArgumentCompletions: (prefix: string) => {
			const verbs = ["status", "setup", "on", "off", "token", "chat", "events", "set", "test", "help"];
			const items = verbs.filter((verb) => verb.startsWith(prefix)).map((verb) => ({ value: verb, label: verb }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			reload();
			const parsed = parseCommand(args ?? "");

			switch (parsed.kind) {
				case "help":
					ctx.ui.notify(HELP_TEXT, "info");
					return;
				case "status":
					ctx.ui.notify(["Telegram notifications", ...statusLines()].join("\n"), "info");
					return;
				case "setup":
					await runSetup(ctx);
					return;
				case "enable":
				case "disable": {
					persist({ ...config, enabled: parsed.kind === "enable" });
					ctx.ui.notify(`Telegram notifications ${config.enabled ? "enabled" : "disabled"}.`, "info");
					return;
				}
				case "token": {
					persist({ ...config, botToken: parsed.value });
					ctx.ui.notify(`Bot token stored (${redactToken(parsed.value)}) in ${configPath()}.`, "info");
					return;
				}
				case "add-chat": {
					const added = normalizeChatIds(parsed.values);
					const rejected = parsed.values.filter((value) => !added.includes(value.trim()));
					persist({ ...config, chatIds: [...config.chatIds, ...added] });
					const notes = rejected.length > 0 ? ` Ignored invalid id(s): ${rejected.join(", ")}.` : "";
					ctx.ui.notify(
						`Chat ids: ${config.chatIds.join(", ") || "(none)"}.${notes}`,
						rejected.length > 0 ? "warn" : "info",
					);
					return;
				}
				case "remove-chat": {
					const removing = new Set(parsed.values.map((value) => value.trim()));
					persist({ ...config, chatIds: config.chatIds.filter((id) => !removing.has(id)) });
					ctx.ui.notify(`Chat ids: ${config.chatIds.join(", ") || "(none)"}.`, "info");
					return;
				}
				case "events": {
					persist({ ...config, events: parsed.values });
					ctx.ui.notify(`Subscribed hooks: ${config.events.join(", ")}.`, "info");
					return;
				}
				case "list-events": {
					const lines = SUPPORTED_EVENTS.map(
						(name) =>
							`${config.events.includes(name) ? "[x]" : "[ ]"} ${name} - ${eventTitle(name)}: ${eventDescription(name)}`,
					);
					ctx.ui.notify(["Supported hooks", ...lines].join("\n"), "info");
					return;
				}
				case "set": {
					const applied = applySetting(parsed.key, parsed.value);
					if (!applied.ok) {
						ctx.ui.notify(applied.message, "warn");
						return;
					}
					persist({ ...config, ...applied.patch } as NotifyConfig);
					ctx.ui.notify(applied.message, "info");
					return;
				}
				case "test": {
					const token = resolveBotToken(config);
					const problems = validateForSend({ ...config, enabled: true }, token);
					if (problems.length > 0) {
						ctx.ui.notify(`Cannot send: ${problems.map((problem) => problem.message).join("; ")}.`, "warn");
						return;
					}
					const text = renderMessage(
						{
							title: "Test notification",
							fields: [["Source", "pi-notify"]],
							body: parsed.message ?? "If you can read this, the bot token and chat ids work.",
						},
						{
							project: projectLabel(ctx),
							session: sessionName(),
							workspaceName: config.workspaceName,
						},
						config.parseMode,
					);
					const results = await deliver(text);
					const failed = results.filter((result) => !result.ok);
					if (failed.length === 0) {
						ctx.ui.notify(`Test sent to ${results.length} chat(s).`, "info");
						return;
					}
					const detail = failed.map((result) => `${result.chatId}: ${result.error}`).join("\n");
					ctx.ui.notify(`Test failed for ${failed.length}/${results.length} chat(s).\n${detail}`, "error");
					return;
				}
				case "error":
					ctx.ui.notify(parsed.message, "warn");
					return;
				default:
					ctx.ui.notify(HELP_TEXT, "info");
			}
		},
	});
}
