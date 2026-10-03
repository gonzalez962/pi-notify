import { execFile } from "node:child_process";
import { platform as osPlatform } from "node:os";

const DEBOUNCE_MS = 1000;
export const SYSTEM_NOTIFICATION_TIMEOUT_MS = 5_000;
const lastNotificationTime: Record<string, number> = {};
const activeNotificationCancellations = new Set<() => void>();

type NotificationProcess = {
	on?: (event: string, listener: (...args: any[]) => void) => unknown;
	off?: (event: string, listener: (...args: any[]) => void) => unknown;
	removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
	kill?: (signal?: NodeJS.Signals | number) => boolean;
};

function runNotificationProcess(
	command: string,
	args: string[],
	execFileFn: typeof execFile,
	timeoutMs: number,
	onSuccess?: (stdout: string) => void,
): Promise<boolean> {
	return new Promise((resolve) => {
		let proc: NotificationProcess | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const remove = (event: string, listener: (...args: any[]) => void): void => {
			if (typeof proc?.off === "function") proc.off(event, listener);
			else proc?.removeListener?.(event, listener);
		};
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			remove("error", onError);
			activeNotificationCancellations.delete(cancel);
		};
		const settle = (result: boolean, stdout = ""): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (result) onSuccess?.(stdout);
			resolve(result);
		};
		const onError = (): void => settle(false);
		const cancel = (): void => {
			try {
				proc?.kill?.();
			} finally {
				settle(false);
			}
		};

		try {
			proc = execFileFn(command, args, (error, stdout) => settle(!error, String(stdout ?? ""))) as NotificationProcess;
			if (settled) return;
			proc?.on?.("error", onError);
			if (settled) return;
			activeNotificationCancellations.add(cancel);
			timer = setTimeout(() => {
				try {
					proc?.kill?.();
				} finally {
					settle(false);
				}
			}, timeoutMs);
		} catch {
			settle(false);
		}
	});
}

export function cancelSystemNotificationProcesses(): void {
	for (const cancel of [...activeNotificationCancellations]) cancel();
}

let lastLinuxNotificationId: number | null = null;

function sanitizeGhosttyField(value: string): string {
	return value.replace(/[;\x07\x1b\n\r]/g, "");
}

export function formatGhosttyNotificationSequence(
	title: string,
	message: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const escapedTitle = sanitizeGhosttyField(title);
	const escapedMessage = sanitizeGhosttyField(message);
	const payload = `\x1b]9;${escapedTitle}: ${escapedMessage}\x07`;
	if (env.TMUX) return `\x1bPtmux;\x1b${payload}\x1b\\`;
	return payload;
}

export function buildOsascriptNotificationArgs(title: string, message: string): string[] {
	return [
		"-e",
		"on run argv\n display notification (item 1 of argv) with title (item 2 of argv)\nend run",
		message,
		title,
	];
}

export function buildLinuxNotifySendArgs(options: {
	title: string;
	message: string;
	timeoutSec: number;
	iconPath?: string | null;
	appName?: string;
	grouping?: boolean;
	replaceId?: number | null;
}): string[] {
	const args: string[] = ["--app-name", options.appName ?? "pi"];
	if (options.iconPath) args.push("--icon", options.iconPath);
	args.push("--expire-time", String(Math.max(1, options.timeoutSec) * 1000));
	if (options.grouping && options.replaceId != null) args.push("--replace-id", String(options.replaceId));
	if (options.grouping) args.push("--print-id");
	args.push("--", options.title, options.message);
	return args;
}

export function buildWindowsNotificationScript(
	title: string,
	message: string,
	options: { appName?: string; iconPath?: string | null } = {},
): string {
	const safeTitle = title.replace(/'/g, "''");
	const safeMessage = message.replace(/'/g, "''");
	const defaultAumid = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
	const appId = options.appName && options.appName !== "pi" ? options.appName.replace(/'/g, "''") : defaultAumid;
	const iconXml = options.iconPath
		? `<image placement=''appLogoOverride'' src=''$([System.Security.SecurityElement]::Escape('${options.iconPath.replace(/'/g, "''")}'))''/>`
		: "";

	return [
		"try {",
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;",
		"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;",
		`$t = [System.Security.SecurityElement]::Escape('${safeTitle}');`,
		`$m = [System.Security.SecurityElement]::Escape('${safeMessage}');`,
		`$template = \"<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$m</text>${iconXml}</binding></visual><audio silent='true'/></toast>\";`,
		"$xml.LoadXml($template);",
		"$toast = [Windows.UI.Notifications.ToastNotification]::new($xml);",
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast);`,
		"} catch {",
		"Add-Type -AssemblyName System.Windows.Forms;",
		"$notify = New-Object System.Windows.Forms.NotifyIcon;",
		"$notify.Icon = [System.Drawing.SystemIcons]::Information;",
		"$notify.Visible = $true;",
		`$notify.ShowBalloonTip(5000, '${safeTitle}', '${safeMessage}', [System.Windows.Forms.ToolTipIcon]::Info);`,
		"Start-Sleep -Milliseconds 1000;",
		"$notify.Dispose();",
		"}",
	].join(" ");
}

export interface SystemNotificationOptions {
	title: string;
	message: string;
	timeoutSec?: number;
	iconPath?: string | null;
	notificationSystem?: "osascript" | "ghostty";
	linuxGrouping?: boolean;
	appName?: string;
	platform?: string;
	env?: NodeJS.ProcessEnv;
	now?: number;
	stdoutWriter?: (data: string) => void;
	execFileFn?: typeof execFile;
	timeoutMs?: number;
}

export async function sendSystemNotification(options: SystemNotificationOptions): Promise<boolean> {
	const now = options.now ?? Date.now();
	const debounceKey = `${options.title}:${options.message}`;
	if (lastNotificationTime[debounceKey] && now - lastNotificationTime[debounceKey] < DEBOUNCE_MS) return false;
	lastNotificationTime[debounceKey] = now;

	const plat = options.platform ?? osPlatform();
	const env = options.env ?? process.env;
	const notifSystem = options.notificationSystem ?? "osascript";
	const timeoutSec = options.timeoutSec ?? 5;
	if (env.PI_NOTIFY_DISABLE_SYSTEM_SPAWN === "1") return true;
	const runExecFile = options.execFileFn ?? execFile;

	if (notifSystem === "ghostty") {
		const seq = formatGhosttyNotificationSequence(options.title, options.message, env);
		const writer = options.stdoutWriter ?? ((s) => process.stdout.write(s));
		try {
			writer(seq);
			return true;
		} catch {
			return false;
		}
	}

	const timeoutMs = options.timeoutMs ?? SYSTEM_NOTIFICATION_TIMEOUT_MS;
	if (plat === "darwin") {
		return runNotificationProcess("osascript", buildOsascriptNotificationArgs(options.title, options.message), runExecFile, timeoutMs);
	}
	if (plat === "linux") {
		const args = buildLinuxNotifySendArgs({
			title: options.title,
			message: options.message,
			timeoutSec,
			iconPath: options.iconPath,
			appName: options.appName,
			grouping: options.linuxGrouping,
			replaceId: lastLinuxNotificationId,
		});
		return runNotificationProcess("notify-send", args, runExecFile, timeoutMs, (stdout) => {
			if (!options.linuxGrouping || !stdout) return;
			const parsed = Number.parseInt(stdout.trim(), 10);
			if (Number.isFinite(parsed)) lastLinuxNotificationId = parsed;
		});
	}
	if (plat === "win32") {
		const script = buildWindowsNotificationScript(options.title, options.message, {
			appName: options.appName,
			iconPath: options.iconPath,
		});
		return runNotificationProcess("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], runExecFile, timeoutMs);
	}
	return false;
}

export function resetNotificationState(): void {
	for (const key of Object.keys(lastNotificationTime)) delete lastNotificationTime[key];
	lastLinuxNotificationId = null;
}
