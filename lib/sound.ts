import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SystemEventType } from "./system-config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBOUNCE_MS = 1000;
const FULL_VOLUME_PERCENT = 100;
const FULL_VOLUME_PULSE = 65536;
export const SOUND_PROCESS_TIMEOUT_MS = 5_000;

type SoundProcess = {
	on: (event: string, listener: (...args: any[]) => void) => unknown;
	off?: (event: string, listener: (...args: any[]) => void) => unknown;
	removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
	kill?: (signal?: NodeJS.Signals | number) => boolean;
};

const activeSoundCancellations = new Set<() => void>();
const lastSoundTime: Record<string, number> = {};

export function getBundledSoundPath(event: string): string | null {
	const filename = `${event}.wav`;
	const candidates = [
		join(__dirname, "..", "sounds", filename),
		join(__dirname, "sounds", filename),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function getSoundFilePath(event: string, customPath: string | null): string | null {
	if (customPath && existsSync(customPath)) {
		return customPath;
	}
	return getBundledSoundPath(event);
}

function normalizeVolume(volume: number): number {
	if (!Number.isFinite(volume)) return 1;
	if (volume < 0) return 0;
	if (volume > 1) return 1;
	return volume;
}

export type SpawnFunction = typeof spawn;

async function runProcess(
	command: string,
	args: string[],
	spawnFn: SpawnFunction = spawn,
	timeoutMs = SOUND_PROCESS_TIMEOUT_MS,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let proc: SoundProcess | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const remove = (event: string, listener: (...args: any[]) => void): void => {
			if (typeof proc?.off === "function") proc.off(event, listener);
			else proc?.removeListener?.(event, listener);
		};
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			remove("error", onError);
			remove("close", onClose);
			activeSoundCancellations.delete(cancel);
		};
		const settle = (error?: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve();
		};
		const onError = (error: unknown): void => {
			settle(error instanceof Error ? error : new Error(String(error)));
		};
		const onClose = (code: number | null): void => {
			if (code === 0) settle();
			else settle(new Error(`Exit code ${code}`));
		};
		const cancel = (): void => {
			try {
				proc?.kill?.();
			} finally {
				settle(new Error("Sound process cancelled"));
			}
		};

		try {
			proc = spawnFn(command, args, {
				stdio: "ignore",
				detached: false,
				windowsHide: true,
			}) as SoundProcess;
			activeSoundCancellations.add(cancel);
			timer = setTimeout(() => {
				try {
					proc?.kill?.();
				} finally {
					settle(new Error(`Sound process timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);
			proc.on("error", onError);
			proc.on("close", onClose);
			if (settled) cleanup();
		} catch (error) {
			settle(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export async function playSound(
	event: SystemEventType,
	customPath: string | null = null,
	volume = 1,
	options: {
		platform?: string;
		spawnFn?: SpawnFunction;
		now?: number;
		timeoutMs?: number;
	} = {},
): Promise<boolean> {
	const now = options.now ?? Date.now();
	if (lastSoundTime[event] && now - lastSoundTime[event] < DEBOUNCE_MS) {
		return false;
	}
	lastSoundTime[event] = now;

	const soundPath = getSoundFilePath(event, customPath);
	if (!soundPath) return false;

	const normalizedVolume = normalizeVolume(volume);
	if (process.env.PI_NOTIFY_DISABLE_SYSTEM_SPAWN === "1") return true;
	const plat = options.platform ?? osPlatform();
	const runner = options.spawnFn ?? spawn;

	try {
		if (plat === "darwin") {
			await runProcess("afplay", ["-v", String(normalizedVolume), soundPath], runner, options.timeoutMs);
			return true;
		}
		if (plat === "linux") {
			const percentVolume = Math.round(normalizedVolume * FULL_VOLUME_PERCENT);
			const pulseVolume = Math.round(normalizedVolume * FULL_VOLUME_PULSE);
			const players = [
				{ command: "paplay", args: [`--volume=${pulseVolume}`, soundPath] },
				{ command: "aplay", args: [soundPath] },
				{
					command: "mpv",
					args: [
						"--no-video",
						"--no-terminal",
						"--script-opts=autoload-disabled=yes",
						"--keep-open=no",
						"--idle=no",
						`--volume=${percentVolume}`,
						soundPath,
					],
				},
				{ command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", `${percentVolume}`, soundPath] },
			];
			for (const player of players) {
				try {
					await runProcess(player.command, player.args, runner, options.timeoutMs);
					return true;
				} catch {
					continue;
				}
			}
			return false;
		}
		if (plat === "win32") {
			const script = "& { (New-Object Media.SoundPlayer $args[0]).PlaySync() }";
			await runProcess("powershell", ["-NoProfile", "-NonInteractive", "-Command", script, soundPath], runner, options.timeoutMs);
			return true;
		}
		return false;
	} catch {
		// Silent failure
		return false;
	}
}

export function cancelSoundProcesses(): void {
	for (const cancel of [...activeSoundCancellations]) cancel();
}

export function resetSoundState(): void {
	for (const key of Object.keys(lastSoundTime)) {
		delete lastSoundTime[key];
	}
}
