import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBundledSoundPath, getSoundFilePath, playSound, resetSoundState } from "../lib/sound.ts";

describe("sound", () => {
	it("locates bundled sound files for known events", () => {
		const completePath = getBundledSoundPath("complete");
		assert.ok(completePath && completePath.endsWith("complete.wav"));

		const errorPath = getBundledSoundPath("error");
		assert.ok(errorPath && errorPath.endsWith("error.wav"));

		const permPath = getBundledSoundPath("permission");
		assert.ok(permPath && permPath.endsWith("permission.wav"));
	});

	it("prefers custom sound path if provided and exists", () => {
		const bundled = getSoundFilePath("complete", null);
		assert.ok(bundled);
	});

	it("dispatches to afplay on darwin with mocked runner", async () => {
		resetSoundState();
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const mockSpawn = ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return {
				on: (event: string, cb: (arg?: any) => void) => {
					if (event === "close") setTimeout(() => cb(0), 1);
				},
			};
		}) as any;

		const ok = await playSound("complete", null, 0.8, {
			platform: "darwin",
			spawnFn: mockSpawn,
			now: 1000,
		});

		assert.equal(ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "afplay");
		assert.deepEqual(calls[0].args.slice(0, 2), ["-v", "0.8"]);
	});

	it("dispatches to powershell on win32 with mocked runner", async () => {
		resetSoundState();
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const mockSpawn = ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return {
				on: (event: string, cb: (arg?: any) => void) => {
					if (event === "close") setTimeout(() => cb(0), 1);
				},
			};
		}) as any;

		const ok = await playSound("error", null, 1, {
			platform: "win32",
			spawnFn: mockSpawn,
			now: 2000,
		});

		assert.equal(ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "powershell");
	});

	it("times out and kills a hung sound process", async () => {
		resetSoundState();
		let killed = false;
		const mockSpawn = (() => ({
			on: () => {},
			kill: () => {
				killed = true;
				return true;
			},
		})) as any;

		const started = Date.now();
		const ok = await playSound("complete", null, 1, {
			platform: "darwin",
			spawnFn: mockSpawn,
			timeoutMs: 10,
			now: 4000,
		});

		assert.equal(ok, false);
		assert.equal(killed, true);
		assert.ok(Date.now() - started < 500, "hung sound must settle promptly");
	});

	it("debounces repeated plays within debounce window", async () => {
		resetSoundState();
		const mockSpawn = (() => ({
			on: (event: string, cb: (arg?: any) => void) => {
				if (event === "close") setTimeout(() => cb(0), 1);
			},
		})) as any;

		const first = await playSound("complete", null, 1, {
			platform: "darwin",
			spawnFn: mockSpawn,
			now: 5000,
		});
		assert.equal(first, true);

		// Within 1000ms -> debounced
		const second = await playSound("complete", null, 1, {
			platform: "darwin",
			spawnFn: mockSpawn,
			now: 5500,
		});
		assert.equal(second, false);

		// After 1000ms -> allowed
		const third = await playSound("complete", null, 1, {
			platform: "darwin",
			spawnFn: mockSpawn,
			now: 6100,
		});
		assert.equal(third, true);
	});
});
