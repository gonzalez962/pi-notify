import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	DEFAULT_SYSTEM_CONFIG,
	formatTimestamp,
	incrementTurnCount,
	interpolateMessage,
	loadSystemConfig,
	loadTurnCount,
	normalizeSystemConfig,
	resetSessionTurnCount,
	saveSystemConfig,
	saveTurnCount,
	systemConfigPath,
} from "../lib/system-config.ts";

describe("system-config", () => {
	let testDir: string;
	let testEnv: NodeJS.ProcessEnv;

	before(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-system-config-"));
		testEnv = { ...process.env, PI_NOTIFY_CONFIG_HOME: testDir };
		resetSessionTurnCount();
	});

	after(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns defaults for null or garbage input", () => {
		const normalized = normalizeSystemConfig(null);
		assert.equal(normalized.enabled, true);
		assert.equal(normalized.sound, true);
		assert.equal(normalized.notification, true);
		assert.equal(normalized.bell, false);
		assert.equal(normalized.minDuration, 0);
		assert.equal(normalized.command.enabled, false);
	});

	it("normalizes boolean and numeric fields cleanly", () => {
		const config = normalizeSystemConfig({
			enabled: false,
			timeout: 10,
			minDuration: 15,
			notificationSystem: "ghostty",
			volumes: { complete: 0.5, unknown_event: 2 },
			events: {
				complete: { sound: false, notification: true },
				permission: true,
			},
		});
		assert.equal(config.enabled, false);
		assert.equal(config.timeout, 10);
		assert.equal(config.minDuration, 15);
		assert.equal(config.notificationSystem, "ghostty");
		assert.equal(config.volumes.complete, 0.5);
		assert.equal(config.events.complete.sound, false);
		assert.equal(config.events.complete.notification, true);
		assert.equal(config.events.permission.sound, true);
		assert.equal(config.events.permission.notification, true);
	});

	it("round-trips through saveSystemConfig and loadSystemConfig", () => {
		const initial = loadSystemConfig(testEnv);
		assert.equal(initial.enabled, true);

		saveSystemConfig({ ...initial, enabled: false, minDuration: 42 }, testEnv);
		const loaded = loadSystemConfig(testEnv);
		assert.equal(loaded.enabled, false);
		assert.equal(loaded.minDuration, 42);
	});

	it("manages persistent turn count across sessions", () => {
		saveTurnCount(5, testEnv);
		assert.equal(loadTurnCount(testEnv), 5);

		resetSessionTurnCount();
		const next = incrementTurnCount(testEnv);
		assert.equal(next, 6);
		assert.equal(loadTurnCount(testEnv), 6);
	});

	it("interpolates message tokens and strips trailing separators", () => {
		const template = "Session: {sessionTitle} - Project: {projectName} ({timestamp}) [turn {turn}]";
		const res = interpolateMessage(template, {
			sessionTitle: "MyTask",
			projectName: "PiRepo",
			timestamp: "12:00:00",
			turn: 3,
		});
		assert.equal(res, "Session: MyTask - Project: PiRepo (12:00:00) [turn 3]");

		// Strips trailing separator when session title is empty
		const emptyTitleRes = interpolateMessage("Session needs permission: {sessionTitle}", {
			sessionTitle: "",
		});
		assert.equal(emptyTitleRes, "Session needs permission");
	});

	it("formats timestamps consistently", () => {
		const d = new Date(2025, 0, 1, 9, 5, 7);
		assert.equal(formatTimestamp(d), "09:05:07");
	});
});
