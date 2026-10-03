import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTerminalFocused, isTmuxActivePane, isWezTermActivePane } from "../lib/focus.ts";

describe("focus detection", () => {
	it("detects active tmux pane when attached and active", () => {
		const env = { TMUX: "1" } as any;
		const mockExec = () => "1:1:1";
		assert.equal(isTmuxActivePane(env, mockExec), true);

		const inactiveExec = () => "1:1:0";
		assert.equal(isTmuxActivePane(env, inactiveExec), false);
	});

	it("returns null when not in tmux", () => {
		assert.equal(isTmuxActivePane({} as any), null);
	});

	it("detects active WezTerm pane", () => {
		const env = { WEZTERM_PANE: "4" } as any;
		const mockExec = () => JSON.stringify([{ focused_pane_id: 4 }]);
		assert.equal(isWezTermActivePane(env, mockExec), true);

		const inactiveExec = () => JSON.stringify([{ focused_pane_id: 2 }]);
		assert.equal(isWezTermActivePane(env, inactiveExec), false);
	});

	it("detects focused terminal on darwin via osascript", () => {
		const mockExecF = (_file: string, _args: readonly string[]) => "Ghostty";
		const focused = isTerminalFocused({
			platform: "darwin",
			env: {},
			execFileFn: mockExecF,
		});
		assert.equal(focused, true);

		const unfocused = isTerminalFocused({
			platform: "darwin",
			env: {},
			execFileFn: () => "Safari",
		});
		assert.equal(unfocused, false);
	});

	it("detects focused terminal on linux under hyprland", () => {
		const mockExec = (cmd: string) => {
			if (cmd.includes("hyprctl")) {
				return JSON.stringify({ class: "kitty" });
			}
			return null;
		};
		const focused = isTerminalFocused({
			platform: "linux",
			env: { HYPRLAND_INSTANCE_SIGNATURE: "test" },
			execFn: mockExec,
		});
		assert.equal(focused, true);
	});

	it("detects focused terminal on win32 via powershell", () => {
		const mockExecF = (_file: string, _args: readonly string[]) => "herdr\r\n";
		const focused = isTerminalFocused({
			platform: "win32",
			env: {},
			execFileFn: mockExecF,
		});
		assert.equal(focused, true);

		const unfocused = isTerminalFocused({
			platform: "win32",
			env: {},
			execFileFn: () => "chrome\r\n",
		});
		assert.equal(unfocused, false);

		const wtFocused = isTerminalFocused({
			platform: "win32",
			env: {},
			execFileFn: () => "windowsterminal",
		});
		assert.equal(wtFocused, true);

		// VS Code foreground should only count as terminal focus if running inside VS Code
		const codeOutside = isTerminalFocused({
			platform: "win32",
			env: { TERM_PROGRAM: "herdr" },
			execFileFn: () => "code",
		});
		assert.equal(codeOutside, false);

		const codeInside = isTerminalFocused({
			platform: "win32",
			env: { TERM_PROGRAM: "vscode" },
			execFileFn: () => "code",
		});
		assert.equal(codeInside, true);
	});

	it("evaluates OS focus when running in active Herdr pane", () => {
		const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" } as any;
		const mockExec = (cmd: string) => {
			if (cmd.includes("herdr pane current")) {
				return JSON.stringify({ result: { pane: { pane_id: "w1:p1", focused: true } } });
			}
			return null;
		};

		// Active Herdr pane, but user is currently in Chrome -> MUST NOT be focused (notifications/sounds must fire!)
		const unfocused = isTerminalFocused({
			platform: "win32",
			env,
			execFn: mockExec,
			execFileFn: () => "chrome",
		});
		assert.equal(unfocused, false);

		// Active Herdr pane and Herdr window is focused on desktop -> focused
		const focused = isTerminalFocused({
			platform: "win32",
			env,
			execFn: mockExec,
			execFileFn: () => "herdr",
		});
		assert.equal(focused, true);
	});

	it("returns false when Herdr pane is inactive even if Herdr window is focused", () => {
		const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" } as any;
		const mockExec = (cmd: string) => {
			if (cmd.includes("herdr pane current")) {
				// User switched to another pane in Herdr
				return JSON.stringify({ result: { pane: { pane_id: "w1:p2", focused: true } } });
			}
			return null;
		};

		const unfocused = isTerminalFocused({
			platform: "win32",
			env,
			execFn: mockExec,
			execFileFn: () => "herdr",
		});
		assert.equal(unfocused, false);
	});

	it("detects herdr as terminal app on darwin and linux", () => {
		const darwinFocused = isTerminalFocused({
			platform: "darwin",
			env: {},
			execFileFn: () => "herdr",
		});
		assert.equal(darwinFocused, true);

		const linuxFocused = isTerminalFocused({
			platform: "linux",
			env: { HYPRLAND_INSTANCE_SIGNATURE: "test" },
			execFn: () => JSON.stringify({ class: "herdr" }),
		});
		assert.equal(linuxFocused, true);
	});

	it("fails open when detection throws or encounters unsupported platform", () => {
		const throwsExec = () => {
			throw new Error("unsupported");
		};
		const focused = isTerminalFocused({
			platform: "unknown-os",
			env: {},
			execFn: throwsExec,
		});
		assert.equal(focused, false);
	});
});
