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
import { HELP_TEXT, applySetting, parseCommand } from "../lib/command.ts";
import { SUPPORTED_EVENTS, describeEvent, eventDescription, eventTitle, lastAssistantText } from "../lib/events.ts";
import { type SendResult, broadcast, renderMessage } from "../lib/telegram.ts";

// The Pi types are an optional peer dependency; keep the extension loadable
// even when they are not installed next to it.
type ExtensionAPI = any;
type ExtensionContext = any;

export default function telegramNotify(pi: ExtensionAPI): void {
	let config: NotifyConfig = loadConfig();
	const lastSentAt = new Map<string, number>();
	const inFlight = new Set<Promise<unknown>>();
	/** Last assistant answer seen, so `agent_settled` can carry the actual reply. */
	let lastAnswer = "";
	/** Suppress the next `agent_settled` when the latest `agent_end` was aborted. */
	let nextSettledSuppressed = false;

	function reload(): void {
		config = loadConfig();
	}

	function persist(next: NotifyConfig): void {
		saveConfig(next);
		config = loadConfig();
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

	async function handleEvent(eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> {
		// Run before enabled/validation/throttle gates so an aborted run never consumes a throttle slot.
		if (eventName === "agent_settled" && nextSettledSuppressed) {
			nextSettledSuppressed = false;
			return;
		}
		if (!config.enabled || !config.events.includes(eventName)) return;
		if (validateForSend(config, resolveBotToken(config)).length > 0) return;
		if (throttled(eventName, Date.now())) return;
		// Restrict notifications to the interactive TUI session by default so
		// JSON-mode subagent processes (canonical Pi subagents run as a separate
		// `pi --mode json` process and load the same extensions) stay quiet.
		// If `ctx.mode` is not available we preserve backward compatibility and
		// allow the notification through.
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
	pi.on("agent_end", (event: unknown) => {
		const messages = (event as { messages?: unknown } | undefined)?.messages;
		// Re-evaluated on every agent_end so the latest run is always the source of truth.
		const aborted = lastAssistantStopReason(messages) === "aborted";
		nextSettledSuppressed = aborted;
		if (aborted) {
			// Aborted partial text must never survive: a later successful but textless
			// run would otherwise notify with the cancelled run's stale answer.
			lastAnswer = "";
			return undefined;
		}
		const answer = lastAssistantText(messages);
		if (answer.length > 0) lastAnswer = answer;
		return undefined;
	});

	for (const eventName of SUPPORTED_EVENTS) {
		pi.on(eventName, (event: unknown, ctx: ExtensionContext) => {
			// Notifications must never block or alter the agent loop, so the send is
			// fire-and-forget and every failure is swallowed here.
			track(handleEvent(eventName, event, ctx).catch(() => undefined));
			return undefined;
		});
	}

	pi.on("session_start", () => {
		reload();
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		// Drain pending sends so a shutdown notification is not lost.
		await Promise.allSettled([...inFlight]);
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
