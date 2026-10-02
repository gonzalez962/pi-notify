import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { DEFAULT_CONFIG, saveConfig } from "../lib/config.ts";
import { DEFAULT_SYSTEM_CONFIG, saveSystemConfig } from "../lib/system-config.ts";
import { resetSystemDrivers, setSystemDrivers } from "../extensions/telegram-notify.ts";

const root = mkdtempSync(join(tmpdir(), "pi-channel-iso-"));
process.env.PI_NOTIFY_CONFIG_HOME = root;
process.env.PI_NOTIFY_DISABLE_SYSTEM_SPAWN = "1";

interface FakePi {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	commands: Map<string, any>;
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

let register: (pi: unknown) => void;
const sentTelegram: any[] = [];
const systemNotifications: any[] = [];
const systemSounds: any[] = [];
const systemBells: number[] = [];
const systemCommands: any[] = [];
let terminalFocused = false;

before(async () => {
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		sentTelegram.push(JSON.parse(String(init.body)));
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	}) as unknown as typeof fetch;

	setSystemDrivers({
		sendNotification: async (opts) => {
			systemNotifications.push(opts);
			return true;
		},
		playSound: async (ev, path, vol) => {
			systemSounds.push({ ev, path, vol });
			return true;
		},
		ringBell: () => {
			systemBells.push(Date.now());
			return true;
		},
		isFocused: () => terminalFocused,
		runCommand: (cfg, ev, msg, ctx) => {
			systemCommands.push({ cfg, ev, msg, ctx });
			return true;
		},
	});

	register = (await import("../extensions/telegram-notify.ts")).default as (pi: unknown) => void;
});

after(() => {
	resetSystemDrivers();
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	sentTelegram.length = 0;
	systemNotifications.length = 0;
	systemSounds.length = 0;
	systemBells.length = 0;
	systemCommands.length = 0;
	terminalFocused = false;
});

describe("channel isolation and edge cases", () => {
	const ctx = {
		mode: "tui",
		cwd: join(root, "project-alpha"),
		ui: { notify: () => {} },
	};

	it("delivers Telegram and skips System when System is disabled", async () => {
		saveConfig({
			...DEFAULT_CONFIG,
			enabled: true,
			botToken: "123:token",
			chatIds: ["100"],
			events: ["agent_settled"],
		});
		saveSystemConfig({
			...DEFAULT_SYSTEM_CONFIG,
			enabled: false,
		});

		const pi = fakePi();
		register(pi);

		await pi.emit("agent_end", {
			messages: [{ role: "assistant", content: "Done with task" }],
		}, ctx);
		await pi.emit("agent_settled", {}, ctx);

		assert.equal(sentTelegram.length, 1);
		assert.equal(systemNotifications.length, 0);
		assert.equal(systemSounds.length, 0);
	});

	it("triggers System alerts and skips Telegram when Telegram is disabled", async () => {
		saveConfig({
			...DEFAULT_CONFIG,
			enabled: false,
			botToken: "123:token",
			chatIds: ["100"],
			events: ["agent_settled"],
		});
		saveSystemConfig({
			...DEFAULT_SYSTEM_CONFIG,
			enabled: true,
		});

		const pi = fakePi();
		register(pi);

		await pi.emit("agent_end", {
			messages: [{ role: "assistant", content: "Done with task" }],
		}, ctx);
		await pi.emit("agent_settled", {}, ctx);

		assert.equal(sentTelegram.length, 0);
		assert.equal(systemNotifications.length, 1);
		assert.equal(systemSounds.length, 1);
		assert.equal(systemNotifications[0].title, "Pi (project-alpha)");
	});

	it("suppresses agent_settled on both channels when aborted", async () => {
		saveConfig({
			...DEFAULT_CONFIG,
			enabled: true,
			botToken: "123:token",
			chatIds: ["100"],
			events: ["agent_settled"],
		});
		saveSystemConfig({
			...DEFAULT_SYSTEM_CONFIG,
			enabled: true,
			events: {
				...DEFAULT_SYSTEM_CONFIG.events,
				user_cancelled: { sound: true, notification: true, command: false, bell: false },
			},
		});

		const pi = fakePi();
		register(pi);

		// Agent end with aborted stopReason
		await pi.emit("agent_end", {
			messages: [{ role: "assistant", content: "cancelled work", stopReason: "aborted" }],
		}, ctx);

		// user_cancelled fired on system channel
		assert.equal(systemNotifications.length, 1);
		assert.ok(systemNotifications[0].message.includes("cancelled by user"));

		// agent_settled follows
		await pi.emit("agent_settled", {}, ctx);

		// Neither channel receives complete/agent_settled!
		assert.equal(sentTelegram.length, 0);
		assert.equal(systemNotifications.length, 1); // Still only the user_cancelled one
	});

	it("suppresses alerts on both channels for headless json subagents", async () => {
		saveConfig({
			...DEFAULT_CONFIG,
			enabled: true,
			botToken: "123:token",
			chatIds: ["100"],
			mainAgentOnly: true,
		});
		saveSystemConfig({
			...DEFAULT_SYSTEM_CONFIG,
			enabled: true,
			mainAgentOnly: true,
		});

		const pi = fakePi();
		register(pi);

		const subagentCtx = {
			mode: "json", // Headless subagent process
			cwd: ctx.cwd,
			ui: ctx.ui,
		};

		await pi.emit("agent_end", {
			messages: [{ role: "assistant", content: "Subagent answer" }],
		}, subagentCtx);
		await pi.emit("agent_settled", {}, subagentCtx);

		assert.equal(sentTelegram.length, 0);
		assert.equal(systemNotifications.length, 0);
		assert.equal(systemSounds.length, 0);
	});

	it("suppresses visual and audio system alerts when terminal is focused", async () => {
		saveConfig({ ...DEFAULT_CONFIG, enabled: false });
		saveSystemConfig({
			...DEFAULT_SYSTEM_CONFIG,
			enabled: true,
			suppressWhenFocused: true,
			bell: true,
			events: {
				...DEFAULT_SYSTEM_CONFIG.events,
				complete: { sound: true, notification: true, command: true, bell: true },
			},
		});

		terminalFocused = true; // Terminal is currently active

		const pi = fakePi();
		register(pi);

		await pi.emit("agent_end", {
			messages: [{ role: "assistant", content: "Done" }],
		}, ctx);
		await pi.emit("agent_settled", {}, ctx);

		// Notification and sound are suppressed!
		assert.equal(systemNotifications.length, 0);
		assert.equal(systemSounds.length, 0);
		// Bell still rings
		assert.equal(systemBells.length, 1);
	});

	it("suppresses complete system alert when duration is less than minDuration", async () => {
		saveConfig({ ...DEFAULT_CONFIG, enabled: false });
		saveSystemConfig({
			...DEFAULT_SYSTEM_CONFIG,
			enabled: true,
			minDuration: 10, // Must take at least 10 seconds
		});

		const pi = fakePi();
		register(pi);

		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_end", {
			messages: [{ role: "assistant", content: "Quick completion" }],
		}, ctx);
		// Completed almost immediately (duration < 10s)
		await pi.emit("agent_settled", {}, ctx);

		assert.equal(systemNotifications.length, 0);
		// Ensure complete sound was not triggered
		assert.equal(systemSounds.some((s) => s.ev === "complete"), false);
	});
});
