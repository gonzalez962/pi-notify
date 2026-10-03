import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildLinuxNotifySendArgs,
	buildOsascriptNotificationArgs,
	buildWindowsNotificationScript,
	formatGhosttyNotificationSequence,
	resetNotificationState,
	sendSystemNotification,
} from "../lib/system-notify.ts";

describe("system-notify", () => {
	it("formats ghostty OSC 9 sequence with tmux passthrough when in tmux", () => {
		const seq = formatGhosttyNotificationSequence("Title", "Message", { TMUX: "1" });
		assert.ok(seq.startsWith("\x1bPtmux;\x1b\x1b]9;Title: Message\x07\x1b\\"));
	});

	it("formats ghostty OSC 9 sequence without tmux when not in tmux", () => {
		const seq = formatGhosttyNotificationSequence("Title", "Message", {});
		assert.equal(seq, "\x1b]9;Title: Message\x07");
	});

	it("builds osascript notification arguments", () => {
		const args = buildOsascriptNotificationArgs("My Title", "My Message");
		assert.equal(args.length, 4);
		assert.equal(args[0], "-e");
		assert.equal(args[2], "My Message");
		assert.equal(args[3], "My Title");
	});

	it("builds linux notify-send arguments with app-name and expire-time", () => {
		const args = buildLinuxNotifySendArgs({
			title: "Hello",
			message: "World",
			timeoutSec: 7,
			appName: "pi-test",
			grouping: true,
			replaceId: 42,
		});
		assert.ok(args.includes("--app-name"));
		assert.ok(args.includes("pi-test"));
		assert.ok(args.includes("--expire-time"));
		assert.ok(args.includes("7000"));
		assert.ok(args.includes("--replace-id"));
		assert.ok(args.includes("42"));
	});

	it("builds safe powershell script for windows notifications with WinRT toast and balloon fallback", () => {
		const script = buildWindowsNotificationScript("Title's test", "Message's body", {
			appName: "CustomAppId",
			iconPath: "C:\\icons\\logo.png",
		});
		assert.ok(script.includes("Title''s test"));
		assert.ok(script.includes("Message''s body"));
		assert.ok(script.includes("ToastNotificationManager"));
		assert.ok(script.includes("ToastGeneric"));
		assert.ok(script.includes("audio silent=''true''") || script.includes("audio silent='true'"));
		assert.ok(script.includes("CustomAppId"));
		assert.ok(script.includes("appLogoOverride"));
		assert.ok(script.includes("ShowBalloonTip"));
	});

	it("times out and kills a hung notification process", async () => {
		resetNotificationState();
		let killed = false;
		const mockExecFile = (() => ({
			on: () => {},
			kill: () => {
				killed = true;
				return true;
			},
		})) as any;

		const started = Date.now();
		const ok = await sendSystemNotification({
			title: "Hung",
			message: "M",
			platform: "darwin",
			execFileFn: mockExecFile,
			timeoutMs: 10,
			now: 3000,
		});

		assert.equal(ok, false);
		assert.equal(killed, true);
		assert.ok(Date.now() - started < 500, "hung notification must settle promptly");
	});

	it("debounces identical notifications within 1000ms", async () => {
		resetNotificationState();
		const calls: any[] = [];
		const mockExecFile = ((cmd: string, args: string[], cb: () => void) => {
			calls.push({ cmd, args });
			cb();
		}) as any;

		const ok1 = await sendSystemNotification({
			title: "T",
			message: "M",
			platform: "darwin",
			execFileFn: mockExecFile,
			now: 1000,
		});
		assert.equal(ok1, true);

		// Inside debounce
		const ok2 = await sendSystemNotification({
			title: "T",
			message: "M",
			platform: "darwin",
			execFileFn: mockExecFile,
			now: 1500,
		});
		assert.equal(ok2, false);
		assert.equal(calls.length, 1);

		// Outside debounce
		const ok3 = await sendSystemNotification({
			title: "T",
			message: "M",
			platform: "darwin",
			execFileFn: mockExecFile,
			now: 2100,
		});
		assert.equal(ok3, true);
		assert.equal(calls.length, 2);
	});
});
