import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	TELEGRAM_MAX_MESSAGE,
	apiUrl,
	broadcast,
	escapeHtml,
	escapeMarkdownV2,
	renderMessage,
	sendBody,
	sendMessage,
} from "../lib/telegram.ts";

function fakeFetch(handler: (url: string, init: RequestInit) => unknown): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		const result = handler(url, init) as { status?: number; payload?: unknown };
		const status = result.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => result.payload ?? { ok: true },
		};
	}) as unknown as typeof fetch;
}

describe("escaping", () => {
	it("escapes HTML entities", () => {
		assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;"x"&lt;/b&gt;');
	});

	it("escapes every MarkdownV2 reserved character", () => {
		assert.equal(escapeMarkdownV2("a_b*c[d]"), "a\\_b\\*c\\[d\\]");
		assert.equal(escapeMarkdownV2("1.0-beta!"), "1\\.0\\-beta\\!");
	});
});

describe("renderMessage", () => {
	it("renders an HTML message with heading, fields and body", () => {
		const text = renderMessage(
			{ title: "Agent finished", fields: [["Tool", "bash"]], body: "<done>" },
			{ project: "pi-notify", session: "refactor" },
			"HTML",
		);
		// Session name has moved from a separate "Session:" field into the heading.
		// Heading order: title → workspaceName → session → project.
		assert.equal(
			text,
			[
				"<b>Agent finished — refactor — pi-notify</b>",
				"<b>Tool:</b> bash",
				"",
				"<pre>&lt;done&gt;</pre>",
			].join("\n"),
		);
	});

	it("renders plain text when parse mode is none", () => {
		const text = renderMessage({ title: "Agent finished", fields: [] }, {}, "none");
		assert.equal(text, "Agent finished");
	});

	it("never exceeds the Telegram message limit", () => {
		const text = renderMessage({ title: "T", fields: [], body: "x".repeat(10_000) }, {}, "none");
		assert.equal(text.length, TELEGRAM_MAX_MESSAGE);
	});

	it("places workspaceName between title and session in the heading", () => {
		const text = renderMessage(
			{ title: "Task finished", fields: [] },
			{ project: "pi-notify", session: "refactor", workspaceName: "team-alpha" },
			"HTML",
		);
		// Order: title → workspaceName → session → project.
		assert.match(text, /^<b>Task finished — team-alpha — refactor — pi-notify<\/b>/);
		assert.doesNotMatch(text, /Session:/);
	});

	it("omits the workspaceName segment when it is missing or empty", () => {
		assert.equal(
			renderMessage({ title: "Task finished", fields: [] }, {}, "HTML"),
			"<b>Task finished</b>",
		);
		assert.equal(
			renderMessage({ title: "Task finished", fields: [] }, { workspaceName: "" }, "HTML"),
			"<b>Task finished</b>",
		);
		assert.equal(
			renderMessage({ title: "Task finished", fields: [] }, { workspaceName: "ws" }, "HTML"),
			"<b>Task finished — ws</b>",
		);
		assert.equal(
			renderMessage({ title: "Task finished", fields: [] }, { session: "sess" }, "HTML"),
			"<b>Task finished — sess</b>",
		);
		assert.equal(
			renderMessage({ title: "Task finished", fields: [] }, { project: "proj", session: "sess" }, "HTML"),
			"<b>Task finished — sess — proj</b>",
		);
	});

	it("escapes workspaceName for the active parse mode", () => {
		const html = renderMessage(
			{ title: "T", fields: [] },
			{ workspaceName: "<team>" },
			"HTML",
		);
		assert.match(html, /<b>T — &lt;team&gt;<\/b>/);

		const md = renderMessage(
			{ title: "T", fields: [] },
			{ workspaceName: "a_b" },
			"MarkdownV2",
		);
		assert.match(md, /\*T — a\\_b\*/);
	});

	it("keeps both segments when workspaceName and project are identical (configuration is literal)", () => {
		const text = renderMessage(
			{ title: "T", fields: [] },
			{ project: "team-alpha", workspaceName: "team-alpha", session: "sess" },
			"HTML",
		);
		assert.equal(text, "<b>T — team-alpha — sess — team-alpha</b>");
	});

	it("never emits a Session field even when the session is set", () => {
		const text = renderMessage(
			{ title: "T", fields: [["Tool", "bash"]] },
			{ session: "refactor" },
			"none",
		);
		assert.doesNotMatch(text, /Session:/);
		assert.match(text, /^T — refactor/);
	});

	it("renders a 100-unit workspaceName exactly as supplied", () => {
		const name = "a".repeat(100);
		const text = renderMessage(
			{ title: "T", fields: [] },
			{ workspaceName: name },
			"none",
		);
		assert.equal(text, `T — ${name}`);
	});
});

describe("sendBody", () => {
	it("omits parse_mode when disabled and sets silent delivery", () => {
		const body = sendBody({ chatId: "1", text: "hi", parseMode: "none", silent: true });
		assert.deepEqual(body, { chat_id: "1", text: "hi", disable_web_page_preview: true, disable_notification: true });
	});

	it("includes parse_mode otherwise", () => {
		assert.equal(sendBody({ chatId: "1", text: "hi", parseMode: "HTML", silent: false }).parse_mode, "HTML");
	});
});

describe("apiUrl", () => {
	it("builds the bot endpoint", () => {
		assert.equal(apiUrl("123:abc", "sendMessage"), "https://api.telegram.org/bot123%3Aabc/sendMessage");
	});
});

describe("sendMessage", () => {
	it("reports success", async () => {
		const result = await sendMessage({
			token: "t",
			chatId: "1",
			text: "hi",
			parseMode: "none",
			silent: false,
			timeoutMs: 1_000,
			fetchImpl: fakeFetch(() => ({ payload: { ok: true } })),
		});
		assert.deepEqual(result, { chatId: "1", ok: true });
	});

	it("surfaces the Telegram error description", async () => {
		const result = await sendMessage({
			token: "t",
			chatId: "1",
			text: "hi",
			parseMode: "none",
			silent: false,
			timeoutMs: 1_000,
			fetchImpl: fakeFetch(() => ({ status: 400, payload: { ok: false, description: "chat not found" } })),
		});
		assert.deepEqual(result, { chatId: "1", ok: false, error: "chat not found" });
	});

	it("never throws when the transport fails", async () => {
		const failing = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const result = await sendMessage({
			token: "t",
			chatId: "1",
			text: "hi",
			parseMode: "none",
			silent: false,
			timeoutMs: 1_000,
			fetchImpl: failing,
		});
		assert.deepEqual(result, { chatId: "1", ok: false, error: "network down" });
	});
});

describe("broadcast", () => {
	it("sends one message per chat and keeps per-chat outcomes", async () => {
		const seen: string[] = [];
		const results = await broadcast({
			token: "t",
			chatIds: ["1", "2"],
			text: "hi",
			parseMode: "none",
			silent: false,
			timeoutMs: 1_000,
			fetchImpl: fakeFetch((_url, init) => {
				const chatId = JSON.parse(String(init.body)).chat_id as string;
				seen.push(chatId);
				return chatId === "2" ? { status: 403, payload: { ok: false, description: "bot was blocked" } } : {};
			}),
		});
		assert.deepEqual(seen.sort(), ["1", "2"]);
		assert.deepEqual(results.map((result) => result.ok), [true, false]);
		assert.equal(results[1]?.error, "bot was blocked");
	});

	it("does nothing when there are no chats", async () => {
		assert.deepEqual(
			await broadcast({
				token: "t",
				chatIds: [],
				text: "hi",
				parseMode: "none",
				silent: false,
				timeoutMs: 1_000,
				fetchImpl: fakeFetch(() => {
					throw new Error("must not be called");
				}),
			}),
			[],
		);
	});
});
