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
