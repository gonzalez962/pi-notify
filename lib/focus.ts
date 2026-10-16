import { execFileSync, execSync } from "node:child_process";
import { platform as osPlatform } from "node:os";

const LINUX_TERMINAL_APPS = new Set<string>([
	"ghostty",
	"konsole",
	"gnome-terminal",
	"xterm",
	"urxvt",
	"alacritty",
	"kitty",
	"wezterm",
	"wezterm-gui",
	"tilix",
	"terminator",
	"xfce4-terminal",
	"lxterminal",
	"mate-terminal",
	"deepin-terminal",
	"foot",
	"footclient",
	"herdr",
]);

const MAC_TERMINAL_APPS = new Set<string>([
	"terminal",
	"iterm2",
	"ghostty",
	"wezterm-gui",
	"alacritty",
	"kitty",
	"hyper",
	"warp",
	"tabby",
	"cursor",
	"visual studio code",
	"code",
	"code insiders",
	"zed",
	"rio",
	"herdr",
]);

export function execWithTimeout(
	command: string,
	timeoutMs = 500,
	execFn: (cmd: string, opts: unknown) => string = execSync as any,
): string | null {
	try {
		const out = execFn(command, {
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		return typeof out === "string" ? out.trim() : null;
	} catch {
		return null;
	}
}

export function execFileWithTimeout(
	file: string,
	args: readonly string[],
	timeoutMs = 500,
	execFileFn: (file: string, args: readonly string[], opts: unknown) => string = execFileSync as any,
): string | null {
	try {
		const out = execFileFn(file, args, {
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		return typeof out === "string" ? out.trim() : null;
	} catch {
		return null;
	}
}

export function isTmuxActivePane(
	env: NodeJS.ProcessEnv = process.env,
	execFn = execWithTimeout,
): boolean | null {
	if (!env.TMUX) return null;
	const out = execFn('tmux display-message -p "#{session_attached}:#{window_active}:#{pane_active}"');
	if (!out) return null;
	return out === "1:1:1";
}

export function isHerdrActivePane(
	env: NodeJS.ProcessEnv = process.env,
	execFn = execWithTimeout,
): boolean | null {
	if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return null;
	const out = execFn("herdr pane current --current");
	if (!out) return null;
	try {
		const data = JSON.parse(out);
		const pane = data?.result?.pane ?? data?.pane;
		// `pane current` resolves the caller's pane, so its id always matches;
		// only the `focused` flag tells whether the user is looking at it.
		if (typeof pane?.focused === "boolean") return pane.focused;
		const focusedPaneId = data?.result?.pane?.pane_id || data?.pane?.pane_id || data?.pane_id;
		if (focusedPaneId) {
			return String(focusedPaneId) === String(env.HERDR_PANE_ID);
		}
	} catch {
		if (out.includes(env.HERDR_PANE_ID)) return true;
	}
	return null;
}

export function isWezTermActivePane(
	env: NodeJS.ProcessEnv = process.env,
	execFn = execWithTimeout,
): boolean | null {
	if (!env.WEZTERM_PANE) return null;
	const out = execFn("wezterm cli list-clients --format json");
	if (!out) return null;
	try {
		const data = JSON.parse(out);
		if (!Array.isArray(data)) return null;
		for (const client of data) {
			if (String(client?.focused_pane_id) === String(env.WEZTERM_PANE)) {
				return true;
			}
		}
		return false;
	} catch {
		return null;
	}
}

export function isTerminalFocused(options: {
	platform?: string;
	env?: NodeJS.ProcessEnv;
	execFn?: (cmd: string, timeoutMs?: number) => string | null;
	execFileFn?: (file: string, args: readonly string[], timeoutMs?: number) => string | null;
} = {}): boolean {
	const env = options.env ?? process.env;
	if (env.PI_NOTIFY_DISABLE_SYSTEM_SPAWN === "1") return false;
	const plat = options.platform ?? osPlatform();
	const exec = options.execFn ?? ((cmd, ms) => execWithTimeout(cmd, ms));
	const execF = options.execFileFn ?? ((file, args, ms) => execFileWithTimeout(file, args, ms));

	try {
		const herdr = isHerdrActivePane(env, exec);
		if (herdr === false) return false;

		const wez = isWezTermActivePane(env, exec);
		if (wez === false) return false;

		const tmux = isTmuxActivePane(env, exec);
		if (tmux === false) return false;

		if (plat === "darwin") {
			const script = 'tell application "System Events" to get name of first application process whose frontmost is true';
			const out = execF("osascript", ["-e", script], 600);
			if (!out) return false;
			const name = out.trim().toLowerCase();
			if (MAC_TERMINAL_APPS.has(name)) {
				if ((name === "code" || name === "visual studio code" || name === "code insiders") && env.TERM_PROGRAM !== "vscode") {
					return false;
				}
				if (name === "cursor" && env.TERM_PROGRAM !== "cursor") {
					return false;
				}
				return true;
			}
			return false;
		}

		if (plat === "linux") {
			if (env.HYPRLAND_INSTANCE_SIGNATURE) {
				const out = exec("hyprctl activewindow -j");
				if (out) {
					try {
						const json = JSON.parse(out);
						const cls = String(json?.class ?? "").toLowerCase();
						if (cls && LINUX_TERMINAL_APPS.has(cls)) return true;
					} catch {}
				}
			}

			if (env.SWAYSOCK) {
				const out = exec("swaymsg -t get_tree");
				if (out) {
					try {
						const tree = JSON.parse(out);
						const findFocused = (node: any): string | null => {
							if (node?.focused === true) return String(node.app_id || node.window_properties?.class || "");
							for (const child of node?.nodes ?? []) {
								const res = findFocused(child);
								if (res) return res;
							}
							for (const child of node?.floating_nodes ?? []) {
								const res = findFocused(child);
								if (res) return res;
							}
							return null;
						};
						const cls = findFocused(tree)?.toLowerCase();
						if (cls && LINUX_TERMINAL_APPS.has(cls)) return true;
					} catch {}
				}
			}

			// X11 fallback with xdotool
			const xwin = exec("xdotool getactivewindow getwindowclassname");
			if (xwin) {
				const cls = xwin.trim().toLowerCase();
				if (LINUX_TERMINAL_APPS.has(cls)) return true;
			}
			return false;
		}

		if (plat === "win32") {
			const script = [
				"Add-Type -TypeDefinition @'",
				"using System;",
				"using System.Runtime.InteropServices;",
				"public class WinFocus {",
				'  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
				'  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
				"}",
				"'@;",
				"$hwnd = [WinFocus]::GetForegroundWindow();",
				"$procId = 0;",
				"$null = [WinFocus]::GetWindowThreadProcessId($hwnd, [ref]$procId);",
				"if ($procId -gt 0) { (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName }",
			].join("\n");
			const out = execF("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 1500);
			if (!out) return false;
			const proc = out.trim().toLowerCase();
			const winTerminals = new Set([
				"windowsterminal",
				"cmd",
				"powershell",
				"pwsh",
				"alacritty",
				"wezterm-gui",
				"herdr",
			]);
			if (env.TERM_PROGRAM === "vscode") winTerminals.add("code");
			if (env.TERM_PROGRAM === "cursor") winTerminals.add("cursor");
			return winTerminals.has(proc);
		}

		return false;
	} catch {
		// Fail-open: if detection fails, do not suppress
		return false;
	}
}
