/**
 * Hooks worth a phone notification: the run is over, the agent is asking for
 * something, or the session changed state. Per-turn and per-tool hooks
 * (`turn_*`, `tool_*`, `message_end`, `input`, `model_select`, ...) are
 * deliberately absent — they fire constantly during a normal run and would
 * turn the chat into a log instead of a signal.
 *
 * `agent_end` is intentionally excluded: it fires once per low-level run, so
 * a retry or an auto-compaction would duplicate the notification. The
 * extension keeps an internal `agent_end` listener (see the extension entry
 * point) so `agent_settled` can carry the last assistant answer, but
 * `agent_end` is NOT in the public subscribable set: existing normalized
 * configs that still name it are silently discarded.
 *
 * Decision hooks (`project_trust`, `session_before_*`, `context`,
 * `before_provider_*`) are excluded for a different reason: their handler
 * returns a value Pi obeys, and a notifier must never influence the agent loop.
 */
export const SUPPORTED_EVENTS = [
	/** The agent finished the task and nothing else is queued. */
	"agent_settled",
	/** Pi is blocked waiting for a human answer (confirm, select, input). */
	"ui_prompt_start",
	/** Something went wrong compacting the context. */
	"session_compact_failed",
	"session_start",
	"session_shutdown",
] as const;

export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

/** Hooks that mean "a human is needed right now". */
export const ATTENTION_EVENTS: SupportedEvent[] = ["agent_settled", "ui_prompt_start"];

export function isSupportedEvent(name: string): name is SupportedEvent {
	return (SUPPORTED_EVENTS as readonly string[]).includes(name);
}

export interface NotifyPayload {
	title: string;
	fields: Array<[string, string]>;
	body?: string;
}

const TITLES: Partial<Record<SupportedEvent, string>> = {
	agent_settled: "Task finished",
	ui_prompt_start: "Waiting for your answer",
	session_compact_failed: "Compaction failed",
	session_start: "Session started",
	session_shutdown: "Session ended",
};

const DESCRIPTIONS: Partial<Record<SupportedEvent, string>> = {
	agent_settled: "the agent finished the task and nothing else is queued",
	ui_prompt_start: "Pi is blocked waiting for your answer",
	session_compact_failed: "context compaction failed",
	session_start: "a session started, resumed or forked",
	session_shutdown: "the session ended",
};

export function eventDescription(name: string): string {
	return DESCRIPTIONS[name as SupportedEvent] ?? "";
}

export function eventTitle(name: string): string {
	return TITLES[name as SupportedEvent] ?? name;
}

export function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	if (max <= 1) return text.slice(0, max);
	return `${text.slice(0, max - 1)}…`;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Pull readable text out of an assistant/user message content array. */
export function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return collapse(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return collapse(parts.join("\n"));
}

/** Last assistant answer of a run — the actual "message from the pi agent". */
export function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;
		const text = messageText(message);
		if (text.length > 0) return text;
	}
	return "";
}

function str(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return collapse(value);
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return value ? "yes" : "no";
	return undefined;
}

function push(fields: Array<[string, string]>, label: string, value: unknown, max = 160): void {
	const text = str(value);
	if (text === undefined) return;
	fields.push([label, truncate(text, max)]);
}

/** Turn a raw hook payload into a compact, human-readable notification. */
export function describeEvent(name: string, event: unknown): NotifyPayload {
	const raw = (typeof event === "object" && event !== null ? event : {}) as Record<string, unknown>;
	const fields: Array<[string, string]> = [];
	let body: string | undefined;

	switch (name) {
		case "agent_settled":
			// `agent_settled` carries no messages, so the extension attaches the
			// last assistant answer it saw. Without it the notification would say
			// "done" and nothing else.
			body = truncate(collapse(String(raw.answer ?? "")), 3_000);
			break;
		case "ui_prompt_start":
			push(fields, "Kind", raw.kind);
			push(fields, "Question", raw.title, 300);
			break;
		case "session_compact_failed":
			push(fields, "Reason", raw.reason);
			push(fields, "Aborted", raw.aborted);
			push(fields, "Error", raw.errorMessage, 300);
			break;
		case "session_start":
		case "session_shutdown":
			push(fields, "Reason", raw.reason);
			break;
		default:
			// `agent_end` and any future internal-only hook fall here: the
			// formatter exposes them with the raw name and no body so they
			// never masquerade as a notification.
			break;
	}

	return { title: eventTitle(name), fields, body: body && body.length > 0 ? body : undefined };
}
