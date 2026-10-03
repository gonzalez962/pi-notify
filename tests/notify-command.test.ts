import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseNotifyCommand } from "../lib/command.ts";
import { loadConfig, saveConfig } from "../lib/config.ts";
import { loadSystemConfig, saveSystemConfig } from "../lib/system-config.ts";

const root = mkdtempSync(join(tmpdir(), "pi-notify-cmd-"));
process.env.PI_NOTIFY_CONFIG_HOME = root;
process.env.PI_NOTIFY_DISABLE_SYSTEM_SPAWN = "1";

interface FakePi {
	commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => any[] | null }>;
	registerCommand: (name: string, options: any) => void;
	on: () => void;
}

function fakePi(): FakePi {
	const commands = new Map<string, any>();
	return {
		commands,
		registerCommand(name, options) {
			commands.set(name, options);
		},
		on: () => {},
	};
}

let register: (pi: unknown) => void;

before(async () => {
	register = (await import("../extensions/telegram-notify.ts")).default as (pi: unknown) => void;
});

after(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("notify command", () => {
	it("parses notify subcommands correctly", () => {
		assert.deepEqual(parseNotifyCommand(""), { kind: "status" });
		assert.deepEqual(parseNotifyCommand("status"), { kind: "status" });
		assert.deepEqual(parseNotifyCommand("help"), { kind: "help" });
		assert.deepEqual(parseNotifyCommand("on"), { kind: "enable-all" });
		assert.deepEqual(parseNotifyCommand("off"), { kind: "disable-all" });
		assert.deepEqual(parseNotifyCommand("system on"), { kind: "system-enable" });
		assert.deepEqual(parseNotifyCommand("system off"), { kind: "system-disable" });
		assert.deepEqual(parseNotifyCommand("telegram on"), { kind: "telegram-enable" });
		assert.deepEqual(parseNotifyCommand("telegram off"), { kind: "telegram-disable" });
		assert.deepEqual(parseNotifyCommand("focus on"), { kind: "focus-enable" });
		assert.deepEqual(parseNotifyCommand("focus off"), { kind: "focus-disable" });
		assert.deepEqual(parseNotifyCommand("sound on"), { kind: "sound-enable" });
		assert.deepEqual(parseNotifyCommand("sound off"), { kind: "sound-disable" });
		assert.deepEqual(parseNotifyCommand("herdr-name on"), { kind: "herdr-name-enable" });
		assert.deepEqual(parseNotifyCommand("herdr-name off"), { kind: "herdr-name-disable" });
		assert.deepEqual(parseNotifyCommand("system focus on"), { kind: "focus-enable" });
		assert.deepEqual(parseNotifyCommand("system focus off"), { kind: "focus-disable" });
		assert.deepEqual(parseNotifyCommand("system sound on"), { kind: "sound-enable" });
		assert.deepEqual(parseNotifyCommand("system sound off"), { kind: "sound-disable" });
		assert.deepEqual(parseNotifyCommand("test foo bar"), { kind: "test", message: "foo bar" });
		assert.equal(parseNotifyCommand("system foo").kind, "error");
		assert.equal(parseNotifyCommand("focus foo").kind, "error");
		assert.equal(parseNotifyCommand("sound foo").kind, "error");
		assert.equal(parseNotifyCommand("invalid").kind, "error");
	});

	it("provides autocompletions for /notify", () => {
		const pi = fakePi();
		register(pi);
		const notifyCmd = pi.commands.get("notify");
		assert.ok(notifyCmd);
		assert.ok(notifyCmd.getArgumentCompletions);

		const baseCompletions = notifyCmd.getArgumentCompletions("") ?? [];
		assert.ok(baseCompletions.some((c: any) => c.value === "system"));
		assert.ok(baseCompletions.some((c: any) => c.value === "telegram"));
		assert.ok(baseCompletions.some((c: any) => c.value === "status"));

		const sysCompletions = notifyCmd.getArgumentCompletions("system ") ?? [];
		assert.ok(sysCompletions.some((c: any) => c.value === "system on"));
		assert.ok(sysCompletions.some((c: any) => c.value === "system off"));
	});

	it("toggles system and telegram channels independently via /notify", async () => {
		const notifications: string[] = [];
		const ctx = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
			},
		};

		const pi = fakePi();
		register(pi);
		const notifyCmd = pi.commands.get("notify")!;

		// Start with both enabled
		saveConfig({ ...loadConfig(), enabled: true });
		saveSystemConfig({ ...loadSystemConfig(), enabled: true });

		// Turn system off
		await notifyCmd.handler("system off", ctx);
		assert.equal(loadSystemConfig().enabled, false);
		assert.equal(loadConfig().enabled, true); // Telegram unaffected!

		// Turn telegram off
		await notifyCmd.handler("telegram off", ctx);
		assert.equal(loadSystemConfig().enabled, false);
		assert.equal(loadConfig().enabled, false);

		// Turn system on
		await notifyCmd.handler("system on", ctx);
		assert.equal(loadSystemConfig().enabled, true);
		assert.equal(loadConfig().enabled, false); // Telegram still off!

		// Turn telegram on
		await notifyCmd.handler("telegram on", ctx);
		assert.equal(loadSystemConfig().enabled, true);
		assert.equal(loadConfig().enabled, true);

		// Disable all
		await notifyCmd.handler("off", ctx);
		assert.equal(loadSystemConfig().enabled, false);
		assert.equal(loadConfig().enabled, false);

		// Enable all
		await notifyCmd.handler("on", ctx);
		assert.equal(loadSystemConfig().enabled, true);
		assert.equal(loadConfig().enabled, true);

		// Toggle focus suppression
		await notifyCmd.handler("focus off", ctx);
		assert.equal(loadSystemConfig().suppressWhenFocused, false);
		await notifyCmd.handler("focus on", ctx);
		assert.equal(loadSystemConfig().suppressWhenFocused, true);

		// Toggle sound
		await notifyCmd.handler("sound off", ctx);
		assert.equal(loadSystemConfig().sound, false);
		await notifyCmd.handler("sound on", ctx);
		assert.equal(loadSystemConfig().sound, true);

		// Toggle Herdr agent name
		await notifyCmd.handler("herdr-name on", ctx);
		assert.equal(loadSystemConfig().herdr.showAgentName, true);
		await notifyCmd.handler("herdr-name off", ctx);
		assert.equal(loadSystemConfig().herdr.showAgentName, false);
	});

	it("renders combined status output with /notify status", async () => {
		const notifications: string[] = [];
		const ctx = {
			ui: {
				notify: (msg: string) => notifications.push(msg),
			},
		};

		const pi = fakePi();
		register(pi);
		const notifyCmd = pi.commands.get("notify")!;

		await notifyCmd.handler("status", ctx);
		assert.equal(notifications.length, 1);
		assert.ok(notifications[0].includes("System channel:"));
		assert.ok(notifications[0].includes("Telegram channel:"));
	});
});
