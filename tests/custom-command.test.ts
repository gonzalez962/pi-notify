import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCustomCommand, substituteTokens } from "../lib/custom-command.ts";

describe("custom-command", () => {
	it("substitutes tokens accurately without altering surrounding text", () => {
		const out = substituteTokens("echo '{event}' '{message}' {turn}", "complete", "done successfully", {
			turn: 4,
		});
		assert.equal(out, "echo 'complete' 'done successfully' 4");
	});

	it("skips execution when command is not enabled", () => {
		let spawned = false;
		const mockSpawn = () => {
			spawned = true;
			return {} as any;
		};

		const ran = runCustomCommand(
			{ enabled: false, path: "/bin/sh", args: [], minDuration: 0 },
			"complete",
			"done",
			{},
			mockSpawn as any,
		);
		assert.equal(ran, false);
		assert.equal(spawned, false);
	});

	it("skips execution when duration is under minDuration", () => {
		let spawned = false;
		const mockSpawn = () => {
			spawned = true;
			return {} as any;
		};

		const ran = runCustomCommand(
			{ enabled: true, path: "/bin/my-script", args: [], minDuration: 10 },
			"complete",
			"done",
			{ durationMs: 4000 }, // 4s < 10s
			mockSpawn as any,
		);
		assert.equal(ran, false);
		assert.equal(spawned, false);
	});

	it("spawns command with array arguments avoiding shell interpolation", () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const mockSpawn = (cmd: string, args: string[], _opts: any) => {
			calls.push({ cmd, args });
			return {
				on: () => {},
				unref: () => {},
			} as any;
		};

		const ran = runCustomCommand(
			{
				enabled: true,
				path: "/bin/notifier",
				args: ["--event", "{event}", "--message", "{message}"],
				minDuration: 0,
			},
			"permission",
			"tool rm -rf need approval",
			{ durationMs: 5000 },
			mockSpawn as any,
		);

		assert.equal(ran, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "/bin/notifier");
		assert.deepEqual(calls[0].args, ["--event", "permission", "--message", "tool rm -rf need approval"]);
	});
});
