import { spawn } from "node:child_process";
import type { CommandConfig } from "./system-config.ts";

export interface MessageContext {
	sessionTitle?: string | null;
	agentName?: string | null;
	projectName?: string | null;
	timestamp?: string | null;
	turn?: number | null;
	durationMs?: number | null;
}

export function substituteTokens(template: string, event: string, message: string, ctx: MessageContext = {}): string {
	let result = template.replaceAll("{event}", event).replaceAll("{message}", message);
	result = result.replaceAll("{sessionTitle}", ctx.sessionTitle ?? "");
	result = result.replaceAll("{agentName}", ctx.agentName ?? "");
	result = result.replaceAll("{projectName}", ctx.projectName ?? "");
	result = result.replaceAll("{timestamp}", ctx.timestamp ?? "");
	result = result.replaceAll("{turn}", ctx.turn != null ? String(ctx.turn) : "");
	return result;
}

export function runCustomCommand(
	config: CommandConfig,
	event: string,
	message: string,
	ctx: MessageContext = {},
	spawnFn: typeof spawn = spawn,
): boolean {
	if (!config.enabled || !config.path || config.path.trim().length === 0) {
		return false;
	}

	if (config.minDuration > 0 && ctx.durationMs != null && ctx.durationMs < config.minDuration * 1000) {
		return false;
	}

	const command = substituteTokens(config.path.trim(), event, message, ctx);
	const args = (config.args ?? []).map((arg) => substituteTokens(arg, event, message, ctx));

	try {
		const proc = spawnFn(command, args, {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});

		proc.on("error", () => {
			// Do not throw or bubble up command failure
		});

		if (typeof proc.unref === "function") {
			proc.unref();
		}
		return true;
	} catch {
		return false;
	}
}
