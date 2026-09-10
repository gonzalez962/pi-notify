import type { ParseMode } from "./config.ts";
import type { NotifyPayload } from "./events.ts";
import { truncate } from "./events.ts";

export const TELEGRAM_MAX_MESSAGE = 4_096;

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape every character Telegram reserves in MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
	const reserved = "_*[]()~`>#+-=|{}.!\\";
	return text.replace(/[\s\S]/g, (character) => (reserved.includes(character) ? `\\${character}` : character));
}

export interface RenderMeta {
	/** Project or directory label, omitted when disabled. */
	project?: string;
	/** Session name, when Pi knows one. */
	session?: string;
	/** Workspace label rendered between the title and the session name. */
	workspaceName?: string;
}

export function renderMessage(payload: NotifyPayload, meta: RenderMeta, parseMode: ParseMode): string {
	const lines: string[] = [];
	// Heading segments are appended in a fixed order — title, workspaceName,
	// session, project — and absent segments are dropped so the heading never
	// carries a stray ` — ` when an optional label is missing.
	const headingSegments = [payload.title];
	if (meta.workspaceName) headingSegments.push(meta.workspaceName);
	if (meta.session) headingSegments.push(meta.session);
	if (meta.project) headingSegments.push(meta.project);
	const heading = headingSegments.join(" — ");

	if (parseMode === "HTML") lines.push(`<b>${escapeHtml(heading)}</b>`);
	else if (parseMode === "MarkdownV2") lines.push(`*${escapeMarkdownV2(heading)}*`);
	else lines.push(heading);

	// The session name is part of the heading, so it is no longer emitted as
	// a separate "Session:" field — callers that still expect it can find it
	// in the heading text.
	const fields: Array<[string, string]> = [...payload.fields];

	for (const [label, value] of fields) {
		if (parseMode === "HTML") lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`);
		else if (parseMode === "MarkdownV2") lines.push(`*${escapeMarkdownV2(label)}:* ${escapeMarkdownV2(value)}`);
		else lines.push(`${label}: ${value}`);
	}

	if (payload.body) {
		lines.push("");
		if (parseMode === "HTML") lines.push(`<pre>${escapeHtml(payload.body)}</pre>`);
		else if (parseMode === "MarkdownV2") lines.push(`\`\`\`\n${escapeMarkdownV2(payload.body)}\n\`\`\``);
		else lines.push(payload.body);
	}

	return truncate(lines.join("\n"), TELEGRAM_MAX_MESSAGE);
}

export interface SendOptions {
	token: string;
	chatId: string;
	text: string;
	parseMode: ParseMode;
	silent: boolean;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
}

export interface SendResult {
	chatId: string;
	ok: boolean;
	/** Telegram error description or a transport error message. */
	error?: string;
}

export function apiUrl(token: string, method: string): string {
	return `https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`;
}

export function sendBody(options: Omit<SendOptions, "token" | "fetchImpl" | "timeoutMs">): Record<string, unknown> {
	const body: Record<string, unknown> = {
		chat_id: options.chatId,
		text: options.text,
		disable_web_page_preview: true,
	};
	if (options.parseMode !== "none") body.parse_mode = options.parseMode;
	if (options.silent) body.disable_notification = true;
	return body;
}

export async function sendMessage(options: SendOptions): Promise<SendResult> {
	const doFetch = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await doFetch(apiUrl(options.token, "sendMessage"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(sendBody(options)),
			signal: controller.signal,
		});
		const payload = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			description?: string;
		};
		if (response.ok && payload.ok === true) return { chatId: options.chatId, ok: true };
		return {
			chatId: options.chatId,
			ok: false,
			error: payload.description ?? `HTTP ${response.status}`,
		};
	} catch (error) {
		return {
			chatId: options.chatId,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

export interface BroadcastOptions extends Omit<SendOptions, "chatId"> {
	chatIds: string[];
}

/** Deliver the same text to every chat. Never throws: failures come back as results. */
export async function broadcast(options: BroadcastOptions): Promise<SendResult[]> {
	const { chatIds, ...rest } = options;
	return Promise.all(chatIds.map((chatId) => sendMessage({ ...rest, chatId })));
}
