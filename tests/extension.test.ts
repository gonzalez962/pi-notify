import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_CONFIG, saveConfig } from "../lib/config.ts";

const root = mkdtempSync(join(tmpdir(), "pi-notify-ext-"));
process.env.PI_NOTIFY_CONFIG_HOME = root;
process.env.PI_NOTIFY_DISABLE_SYSTEM_SPAWN = "1";
delete process.env.PI_NOTIFY_TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;

interface SentRequest {
	url: string;
	body: Record<string, unknown>;
}

const sent: SentRequest[] = [];
const realFetch = globalThis.fetch;

interface FakePi {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
	on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	registerCommand: (name: string, options: any) => void;
	getSessionName: () => string;
	emit: (name: string, event: unknown, ctx: unknown) => Promise<void>;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, any>();
	return {
		handlers,
		commands,
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		getSessionName: () => "test-session",
		async emit(name, event, ctx) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

const notifications: Array<[string, string]> = [];
const ctx = {
	cwd: join(root, "my-project"),
	ui: {
		notify: (message: string, level: string) => {
			notifications.push([level, message]);
		},
		input: async () => "",
	},
};

let register: (pi: unknown) => void;

before(async () => {
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		sent.push({ url, body: JSON.parse(String(init.body)) });
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	}) as unknown as typeof fetch;
	register = (await import("../extensions/telegram-notify.ts")).default as (pi: unknown) => void;
});

after(() => {
	globalThis.fetch = realFetch;
	rmSync(root, { recursive: true, force: true });
});

describe("telegram-notify extension", () => {
	it("registers the /telegram command and wires agent_end only as an internal last-answer cache", () => {
		const pi = fakePi();
		register(pi);
		// agent_end is always wired (the listener caches the last assistant
		// answer that agent_settled carries) but it is NOT in SUPPORTED_EVENTS,
		// so it never triggers a Telegram send.
		assert.ok(pi.handlers.has("agent_end"));
		assert.ok(pi.handlers.has("ui_prompt_start"));
		assert.ok(pi.handlers.has("agent_settled"));
		assert.equal(pi.handlers.has("project_trust"), false);
		assert.ok(pi.commands.has("telegram"));
	});

	it("sends a Telegram message for a subscribed hook", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10", "-100200"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		// agent_end populates the internal lastAnswer cache that agent_settled will carry.
		await pi.emit(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "all green" }] }] },
			ctx,
		);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(sent.length, 2, "one message per chat id");
		assert.deepEqual(sent.map((request) => request.body.chat_id).sort(), ["-100200", "10"]);
		assert.match(String(sent[0]?.url), /^https:\/\/api\.telegram\.org\/bot123%3Atoken\/sendMessage$/);
		const text = String(sent[0]?.body.text);
		assert.match(text, /Task finished/);
		assert.match(text, /my-project/);
		assert.match(text, /test-session/);
		assert.match(text, /all green/);
	});

	it("stays silent for hooks that are not subscribed", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["session_compact_failed"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "confirm", title: "Allow?" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.deepEqual(sent, []);
	});

	it("stays silent while disabled or unconfigured", async () => {
		saveConfig({ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], enabled: false }, process.env);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		assert.deepEqual(sent, []);

		saveConfig({ ...DEFAULT_CONFIG, chatIds: [] }, process.env);
		const bare = fakePi();
		register(bare);
		await bare.emit("agent_settled", { type: "agent_settled" }, ctx);
		await bare.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		assert.deepEqual(sent, []);
	});

	it("persists configuration through the /telegram command", async () => {
		saveConfig(DEFAULT_CONFIG, process.env);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		await command.handler("token 999:secret", ctx);
		await command.handler("chat add 55 nonsense", ctx);
		await command.handler("events ui_prompt_start", ctx);
		await command.handler("set throttleMs 5000", ctx);

		sent.length = 0;
		await pi.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "confirm", title: "Allow?" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.body.chat_id, "55");
		assert.match(String(sent[0]?.url), /bot999%3Asecret/);
		assert.ok(
			notifications.some(([level, message]) => level === "warn" && message.includes("nonsense")),
			"invalid chat ids are reported",
		);
	});

	it("carries the agent's last answer into the agent_settled notification", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		// agent_end is not subscribed, but its answer must still reach agent_settled.
		await pi.emit(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "migration done" }] }] },
			ctx,
		);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(sent.length, 1);
		const text = String(sent[0]?.body.text);
		assert.match(text, /Task finished/);
		assert.match(text, /migration done/);
	});

	it("notifies when Pi blocks on a question", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["ui_prompt_start"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("ui_prompt_start", { type: "ui_prompt_start", kind: "confirm", title: "Allow guarded command?" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(sent.length, 1);
		const text = String(sent[0]?.body.text);
		assert.match(text, /Waiting for your answer/);
		assert.match(text, /Allow guarded command\?/);
	});

	it("throttles repeated notifications for the same hook", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"], throttleMs: 60_000 },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(sent.length, 1);
	});

	it("emitting agent_end alone does not send and only caches the last answer", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "draft" }] }] },
			ctx,
		);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.deepEqual(sent, []);
	});

	it("puts workspaceName in the heading between title and session", async () => {
		saveConfig(
			{
				...DEFAULT_CONFIG,
				botToken: "123:token",
				chatIds: ["10"],
				events: ["agent_settled"],
				workspaceName: "team-alpha",
			},
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(sent.length, 1);
		const text = String(sent[0]?.body.text);
		// Order: title → workspaceName → session → project.
		assert.match(text, /Task finished — team-alpha — test-session — my-project/);
		assert.doesNotMatch(text, /Session:/);
	});

	it("omits the workspaceName segment when it is empty", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		const text = String(sent[0]?.body.text);
		assert.match(text, /Task finished — test-session — my-project/);
		assert.doesNotMatch(text, /—\s*—/);
	});

	it("persists workspaceName through `set` and the value survives into the next notification", async () => {
		saveConfig(DEFAULT_CONFIG, process.env);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		await command.handler("token 1:t", ctx);
		await command.handler("chat add 99", ctx);
		await command.handler("events agent_settled", ctx);
		await command.handler("set workspaceName My Cool Workspace", ctx);

		sent.length = 0;
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		const text = String(sent[0]?.body.text);
		assert.match(text, /Task finished — My Cool Workspace — test-session — my-project/);
	});

	it("clears workspaceName with the `none` token and the heading stops carrying it", async () => {
		saveConfig(
			{
				...DEFAULT_CONFIG,
				botToken: "123:token",
				chatIds: ["10"],
				events: ["agent_settled"],
				workspaceName: "team-alpha",
			},
			process.env,
		);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		await command.handler("set workspaceName none", ctx);

		sent.length = 0;
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		const text = String(sent[0]?.body.text);
		assert.match(text, /Task finished — test-session — my-project/);
		assert.doesNotMatch(text, /team-alpha/);
	});

	it("includes workspaceName in /telegram status and /telegram test", async () => {
		saveConfig(
			{
				...DEFAULT_CONFIG,
				botToken: "123:token",
				chatIds: ["10"],
				workspaceName: "team-alpha",
			},
			process.env,
		);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		await command.handler("status", ctx);
		const statusMessage =
			notifications
				.filter(([, message]) => message.startsWith("Telegram notifications"))
				.at(-1)?.[1] ?? "";
		assert.match(statusMessage, /workspaceName:\s+team-alpha/);

		notifications.length = 0;
		sent.length = 0;
		await command.handler("test hello", ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		const text = String(sent[0]?.body.text);
		assert.match(text, /Test notification — team-alpha — test-session — my-project/);
	});

	it("shows workspaceName as (none) in /telegram status when it is empty", async () => {
		saveConfig(DEFAULT_CONFIG, process.env);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		await command.handler("status", ctx);
		const statusMessage =
			notifications
				.filter(([, message]) => message.startsWith("Telegram notifications"))
				.at(-1)?.[1] ?? "";
		assert.match(statusMessage, /workspaceName:\s+\(none\)/);
	});

	it("mentions workspaceName in /telegram help", async () => {
		saveConfig(DEFAULT_CONFIG, process.env);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		notifications.length = 0;
		await command.handler("help", ctx);
		const helpMessage = notifications.at(-1)?.[1] ?? "";
		assert.match(helpMessage, /workspaceName/);
	});

	it("rejects a whitespace-only workspaceName with a clear error", async () => {
		saveConfig(DEFAULT_CONFIG, process.env);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		notifications.length = 0;
		await command.handler("set workspaceName    ", ctx);
		const warn = notifications.find(([level]) => level === "warn");
		assert.ok(warn, "whitespace-only workspaceName must surface a warn notification");
		assert.match(warn?.[1] ?? "", /workspaceName/);
	});

	it("keeps the includeProject=false heading layout intact (only title + workspaceName + session)", async () => {
		saveConfig(
			{
				...DEFAULT_CONFIG,
				botToken: "123:token",
				chatIds: ["10"],
				events: ["agent_settled"],
				includeProject: false,
				workspaceName: "team-alpha",
			},
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		const text = String(sent[0]?.body.text);
		// project segment omitted because includeProject is false.
		assert.match(text, /Task finished — team-alpha — test-session/);
		assert.doesNotMatch(text, /my-project/);
		assert.doesNotMatch(text, /—\s*—/);
	});
});

describe("aborted run suppression", () => {
	it("suppresses the agent_settled that matches an aborted agent_end", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit(
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "half-done thought" }],
						stopReason: "aborted",
					},
				],
			},
			ctx,
		);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.deepEqual(sent, []);
	});

	it("notifies with the retry's answer when a successful run follows an aborted one", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit(
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "partial" }],
						stopReason: "aborted",
					},
				],
			},
			ctx,
		);
		await pi.emit(
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "completed cleanly" }],
						stopReason: "stop",
					},
				],
			},
			ctx,
		);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(sent.length, 1);
		const text = String(sent[0]?.body.text);
		assert.match(text, /completed cleanly/);
		assert.doesNotMatch(text, /partial/);
	});

	it("never carries the aborted partial text into a later textless successful run", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit(
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "aborted leftover" }],
						stopReason: "aborted",
					},
				],
			},
			ctx,
		);
		// The retry finishes cleanly but produces no assistant text (tool-only run).
		await pi.emit(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }] },
			ctx,
		);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.equal(sent.length, 1, "the successful run must still notify");
		assert.doesNotMatch(String(sent[0]?.body.text), /aborted leftover/);
	});
});

describe("mainAgentOnly mode filter", () => {
	const ctxWithMode = (mode: string | undefined) => ({
		mode,
		cwd: join(root, "my-project"),
		ui: ctx.ui,
	});

	it("suppresses notifications in json mode when mainAgentOnly is true (default)", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctxWithMode("json"));
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxWithMode("json"));

		assert.deepEqual(sent, [], "json-mode subagents must not deliver to Telegram");
	});

	it("suppresses notifications in rpc mode when mainAgentOnly is true (default)", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctxWithMode("rpc"));
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxWithMode("rpc"));

		assert.deepEqual(sent, [], "rpc mode must not deliver to Telegram");
	});

	it("suppresses notifications in print mode when mainAgentOnly is true (default)", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctxWithMode("print"));
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxWithMode("print"));

		assert.deepEqual(sent, [], "print mode must not deliver to Telegram");
	});

	it("sends notifications in tui mode when mainAgentOnly is true (default)", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctxWithMode("tui"));
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxWithMode("tui"));

		assert.equal(sent.length, 1, "tui mode is the interactive main agent and must deliver");
	});

	it("preserves backward compatibility when ctx.mode is unavailable", async () => {
		saveConfig(
			{ ...DEFAULT_CONFIG, botToken: "123:token", chatIds: ["10"], events: ["agent_settled"] },
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		// Older Pi versions or test harnesses hand us a ctx without `mode`.
		// mainAgentOnly must not regress those callers — notifications still go out.
		await pi.emit("agent_settled", { type: "agent_settled" }, ctxWithMode(undefined));
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxWithMode(undefined));

		assert.equal(sent.length, 1, "no mode → allow (backward compatible)");
	});

	it("sends notifications in json mode when mainAgentOnly is false", async () => {
		saveConfig(
			{
				...DEFAULT_CONFIG,
				botToken: "123:token",
				chatIds: ["10"],
				events: ["agent_settled"],
				mainAgentOnly: false,
			},
			process.env,
		);
		sent.length = 0;

		const pi = fakePi();
		register(pi);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctxWithMode("json"));
		await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxWithMode("json"));

		assert.equal(sent.length, 1, "mainAgentOnly=false explicitly opts into json-mode delivery");
	});

	it("shows mainAgentOnly in the status command output", async () => {
		saveConfig({ ...DEFAULT_CONFIG, mainAgentOnly: false }, process.env);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		await command.handler("status", ctx);
		const statusMessage =
			notifications
				.filter(([, message]) => message.startsWith("Telegram notifications"))
				.at(-1)?.[1] ?? "";
		assert.match(statusMessage, /mainAgentOnly:\s+false/);
	});

	it("applies set mainAgentOnly through the command", async () => {
		saveConfig(DEFAULT_CONFIG, process.env);
		const pi = fakePi();
		register(pi);
		const command = pi.commands.get("telegram")!;

		await command.handler("set mainAgentOnly false", ctx);
		await command.handler("status", ctx);
		const lastStatus =
			notifications
				.filter(([, message]) => message.startsWith("Telegram notifications"))
				.at(-1)?.[1] ?? "";
		assert.match(lastStatus, /mainAgentOnly:\s+false/);
	});
});
