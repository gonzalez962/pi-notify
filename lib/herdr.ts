import net from "node:net";
import path from "node:path";

// Windows Terminal / ConEmu OSC 9;4 progress sequences
export const WT_PROGRESS_WORKING = "\x1b]9;4;3\x07";
export const WT_PROGRESS_ERROR = "\x1b]9;4;2;100\x07";
export const WT_PROGRESS_WAITING = "\x1b]9;4;4;100\x07";
export const WT_PROGRESS_CLEAR = "\x1b]9;4;0\x07";

export const RETRY_DELAYS = [50, 150, 300, 500, 800, 1200, 1800, 2500, 3500];
export const KEEPALIVE_INTERVAL_MS = 2500;

export type HerdrAgentState = "working" | "blocked" | "idle";

export interface TrackedSubagent {
	id: string;
	agent: string;
	label?: string;
	status: string; // "running" | "queued" | "waiting" | "completed" | "failed"
	lastStep?: string;
	mode?: string;
}

export interface HerdrTrackerOptions {
	env?: NodeJS.ProcessEnv;
	platform?: string;
	writeStdout?: (chunk: string) => void;
	sendRequest?: (endpoint: string, request: unknown, timeoutMs?: number) => Promise<boolean>;
}

export function isHerdrActive(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && Boolean(env.HERDR_SOCKET_PATH) && Boolean(env.HERDR_PANE_ID);
}

export function getHerdrSocketEndpoint(
	socketPath?: string,
	platform: string = process.platform,
): string | undefined {
	if (!socketPath) return undefined;
	return platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

export async function sendHerdrRequestDefault(
	endpoint: string,
	request: unknown,
	timeoutMs = 500,
): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: boolean) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};

		const socket = net.createConnection(endpoint);
		socket.on("error", () => finish(false));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));

		timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref?.();
	});
}

export class HerdrTracker {
	private env: NodeJS.ProcessEnv;
	private platform: string;
	private writeStdout: (chunk: string) => void;
	private sendRequestFn: (endpoint: string, request: unknown, timeoutMs?: number) => Promise<boolean>;

	private isDisposed = false;
	private isMainAgentWorking = false;
	private currentToolName: string | null = null;
	private activeSubagents = new Map<string, TrackedSubagent>();
	private blockedCount = 0;
	private blockedMessage: string | undefined;
	private lastFatalError = false;
	private hasRunTask = false;
	private retryTimers: NodeJS.Timeout[] = [];
	private keepaliveTimer: NodeJS.Timeout | null = null;

	private lastReportedState: HerdrAgentState | undefined;
	private lastReportedMessage: string | undefined;
	private lastReportedDisplayAgent: string | undefined;
	private reportSeq = Date.now() * 1000;

	private sendInFlight = false;
	private queuedState:
		| {
				state: HerdrAgentState;
				message?: string;
				displayAgent?: string;
				clearDisplayAgent?: boolean;
				seq: number;
		  }
		| undefined;

	private getSessionNameFn?: () => string | undefined;

	constructor(options: HerdrTrackerOptions = {}) {
		this.env = options.env ?? process.env;
		this.platform = options.platform ?? process.platform;
		this.writeStdout = options.writeStdout ?? ((chunk) => {
			try {
				process.stdout.write(chunk);
			} catch {}
		});
		this.sendRequestFn = options.sendRequest ?? sendHerdrRequestDefault;
	}

	public setSessionNameAccessor(fn: () => string | undefined): void {
		this.getSessionNameFn = fn;
	}

	public isHerdrEnvironment(): boolean {
		return isHerdrActive(this.env);
	}

	public nextReportSeq(): number {
		this.reportSeq += 1;
		return this.reportSeq;
	}

	public getActiveSubagents(): TrackedSubagent[] {
		return Array.from(this.activeSubagents.values());
	}

	public getWaitingSubagent(): TrackedSubagent | undefined {
		return Array.from(this.activeSubagents.values()).find(
			(s) => s.status === "waiting" || (s.lastStep && s.lastStep.startsWith("asked")),
		);
	}

	public getDesiredState(): {
		state: HerdrAgentState;
		message?: string;
		displayAgent?: string;
	} {
		const waitingSub = this.getWaitingSubagent();
		if (this.blockedCount > 0 || waitingSub) {
			const msg =
				this.blockedMessage ??
				(waitingSub ? `${waitingSub.agent}: esperando respuesta` : "esperando respuesta");
			const display = waitingSub
				? `pi [❓ ${waitingSub.agent}: esperando]`
				: "pi [❓ esperando respuesta]";
			return { state: "blocked", message: msg, displayAgent: display };
		}

		const hasSub = this.activeSubagents.size > 0;
		if (this.isMainAgentWorking || hasSub) {
			let desc: string;
			let display: string;
			if (this.isMainAgentWorking && this.currentToolName) {
				const suffix = hasSub ? ` (+${this.activeSubagents.size} sub)` : "";
				desc = `[${this.currentToolName}${suffix}]`;
				display = `pi [⏳ ${this.currentToolName}${suffix}]`;
			} else if (hasSub) {
				if (this.activeSubagents.size === 1) {
					const sub = Array.from(this.activeSubagents.values())[0]!;
					const step =
						sub.lastStep &&
						sub.lastStep !== "queued" &&
						sub.lastStep !== "starting" &&
						sub.lastStep !== "done"
							? `: ${sub.lastStep}`
							: "";
					desc = `[${sub.agent}${step}]`;
					display = `pi [⏳ ${sub.agent}${step}]`;
				} else {
					const names = Array.from(this.activeSubagents.values())
						.map((s) => s.agent)
						.join(", ");
					const label =
						this.activeSubagents.size <= 2 ? names : `${this.activeSubagents.size} subagentes`;
					desc = `[${label}]`;
					display = `pi [⏳ ${label}]`;
				}
			} else {
				const suffix = hasSub ? ` (+${this.activeSubagents.size} sub)` : "";
				desc = `[pensando${suffix}]`;
				display = `pi [⏳ pensando${suffix}]`;
			}

			return { state: "working", message: desc, displayAgent: display };
		}

		if (!this.hasRunTask) {
			return { state: "idle", message: undefined, displayAgent: undefined };
		}

		if (this.lastFatalError) {
			return { state: "idle", message: "[error]", displayAgent: "pi [❌ error]" };
		}

		return { state: "idle", message: undefined, displayAgent: "pi [✅ listo]" };
	}

	public getBaseTitle(): string {
		const cwd = path.basename(process.cwd());
		let session: string | undefined;
		try {
			session = this.getSessionNameFn?.();
		} catch {
			session = undefined;
		}
		return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
	}

	public emitTerminalTitle(desc?: string, state: HerdrAgentState = "idle"): void {
		const base = this.getBaseTitle();
		let title = base;
		let progressSeq = WT_PROGRESS_CLEAR;

		if (state === "working") {
			const label = desc ?? "[pensando...]";
			title = `⏳ ${label} ${base}`;
			progressSeq = WT_PROGRESS_WORKING;
		} else if (state === "blocked") {
			const label = desc ?? "[esperando respuesta]";
			title = `❓ ${label} ${base}`;
			progressSeq = WT_PROGRESS_WAITING;
		} else if (state === "idle") {
			if (this.hasRunTask) {
				title = this.lastFatalError ? `❌ ${base}` : `✅ ${base}`;
				progressSeq = this.lastFatalError ? WT_PROGRESS_ERROR : WT_PROGRESS_CLEAR;
			} else {
				title = base;
				progressSeq = WT_PROGRESS_CLEAR;
			}
		}

		this.writeStdout(`${progressSeq}\x1b]0;${title}\x07\x1b]2;${title}\x07`);
	}

	private clearTimers(): void {
		for (const t of this.retryTimers) {
			clearTimeout(t);
		}
		this.retryTimers = [];
		if (this.keepaliveTimer !== null) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
	}

	private scheduleRetries(desc?: string, state: HerdrAgentState = "idle"): void {
		this.clearTimers();
		for (const delay of RETRY_DELAYS) {
			const t = setTimeout(() => {
				if (this.isDisposed) return;
				try {
					this.emitTerminalTitle(desc, state);
				} catch {}
			}, delay);
			t.unref?.();
			this.retryTimers.push(t);
		}

		this.keepaliveTimer = setInterval(() => {
			if (this.isDisposed) {
				this.clearTimers();
				return;
			}
			try {
				this.emitTerminalTitle(desc, state);
			} catch {
				this.clearTimers();
			}
		}, KEEPALIVE_INTERVAL_MS);
		this.keepaliveTimer.unref?.();
	}

	private async executeSend(request: unknown): Promise<void> {
		const endpoint = getHerdrSocketEndpoint(this.env.HERDR_SOCKET_PATH, this.platform);
		if (!endpoint) return;
		if (await this.sendRequestFn(endpoint, request, 500)) return;
		await this.sendRequestFn(endpoint, request, 1500);
	}

	private async drainQueue(): Promise<void> {
		if (this.sendInFlight) return;
		this.sendInFlight = true;
		try {
			while (this.queuedState) {
				const next = this.queuedState;
				this.queuedState = undefined;
				const paneId = this.env.HERDR_PANE_ID!;
				const source = "herdr:pi";

				// 1. Report agent state
				await this.executeSend({
					id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
					method: "pane.report_agent",
					params: {
						pane_id: paneId,
						source,
						agent: "pi",
						state: next.state,
						message: next.message,
						seq: next.seq,
					},
				});

				// 2. Report metadata (display_agent, title, tokens)
				if (next.clearDisplayAgent) {
					await this.executeSend({
						id: `${source}:meta:${Date.now()}:${Math.random().toString(36).slice(2)}`,
						method: "pane.report_metadata",
						params: {
							pane_id: paneId,
							source,
							agent: "pi",
							clear_display_agent: true,
							clear_title: true,
							seq: this.nextReportSeq(),
						},
					});
				} else if (next.displayAgent) {
					await this.executeSend({
						id: `${source}:meta:${Date.now()}:${Math.random().toString(36).slice(2)}`,
						method: "pane.report_metadata",
						params: {
							pane_id: paneId,
							source,
							agent: "pi",
							display_agent: next.displayAgent,
							title: next.displayAgent,
							tokens: {
								subagents: String(this.activeSubagents.size),
								tool: this.currentToolName ?? undefined,
							},
							seq: this.nextReportSeq(),
						},
					});
				}
			}
		} finally {
			this.sendInFlight = false;
			if (this.queuedState) {
				void this.drainQueue();
			}
		}
	}

	public publishState(force = false): void {
		if (this.isDisposed) return;
		const next = this.getDesiredState();
		const displayChanged = next.displayAgent !== this.lastReportedDisplayAgent;

		if (
			!force &&
			next.state === this.lastReportedState &&
			next.message === this.lastReportedMessage &&
			!displayChanged
		) {
			return;
		}

		const clearDisplay =
			displayChanged && !next.displayAgent && this.lastReportedDisplayAgent !== undefined;

		this.lastReportedState = next.state;
		this.lastReportedMessage = next.message;
		this.lastReportedDisplayAgent = next.displayAgent;

		this.emitTerminalTitle(next.message, next.state);

		if (next.state === "idle" && this.hasRunTask) {
			this.scheduleRetries(next.message, next.state);
		} else {
			this.clearTimers();
		}

		if (this.isHerdrEnvironment()) {
			this.queuedState = {
				state: next.state,
				message: next.message,
				displayAgent: next.displayAgent,
				clearDisplayAgent: clearDisplay,
				seq: this.nextReportSeq(),
			};
			if (!this.sendInFlight) {
				void this.drainQueue();
			}
		}
	}

	public handleSubagentActivity(data: unknown): void {
		if (this.isDisposed || !data || typeof data !== "object") return;
		const payload = data as { tasks?: TrackedSubagent[] };
		this.activeSubagents.clear();
		if (Array.isArray(payload.tasks)) {
			for (const t of payload.tasks) {
				const st = String(t.status ?? "");
				if (st === "running" || st === "queued" || st === "waiting") {
					this.hasRunTask = true;
					this.activeSubagents.set(String(t.id), {
						id: String(t.id),
						agent: String(t.agent ?? "subagent"),
						label: t.label,
						status: st,
						lastStep: t.lastStep ? String(t.lastStep) : undefined,
						mode: t.mode ? String(t.mode) : undefined,
					});
				}
			}
		}
		this.publishState();
	}

	public handleToolExecutionEnd(event: { toolName?: string; result?: any }): void {
		if (this.isDisposed || !event?.toolName) return;
		if (event.toolName === "subagent_run" || event.toolName === "subagent") {
			const details = event.result?.details?.gentleAgents;
			if (details?.taskId) {
				const st = String(details.status ?? "running");
				if (st === "running" || st === "queued" || st === "waiting") {
					this.activeSubagents.set(String(details.taskId), {
						id: String(details.taskId),
						agent: String(details.agent ?? "subagent"),
						status: st,
						mode: String(details.mode ?? ""),
					});
				}
			} else {
				const content = Array.isArray(event.result?.content) ? event.result.content : [];
				const text = content.map((c: any) => c?.text ?? "").join("\n");
				const match = text.match(/Started\s+(\S+)\s+in the background as task\s+(\S+)/i);
				if (match) {
					const agent = match[1]!;
					const taskId = match[2]?.replace(/[.:]$/, "")!;
					this.activeSubagents.set(taskId, {
						id: taskId,
						agent,
						status: "running",
						mode: "background",
					});
				}
			}
		} else if (event.toolName === "subagent_cancel") {
			const content = Array.isArray(event.result?.content) ? event.result.content : [];
			const text = content.map((c: any) => c?.text ?? "").join("\n");
			const match = text.match(/Cancelled task\s+(\S+)/i);
			if (match) {
				const taskId = match[1]?.replace(/[.:]$/, "")!;
				this.activeSubagents.delete(taskId);
			}
		}
	}

	public wirePiEvents(pi: any): void {
		if (!pi?.on) return;

		this.setSessionNameAccessor(() => {
			try {
				return typeof pi?.getSessionName === "function" ? pi.getSessionName() : undefined;
			} catch {
				return undefined;
			}
		});

		if (pi.events?.on) {
			pi.events.on("gentle-agents:activity", (data: unknown) => this.handleSubagentActivity(data));
			pi.events.on("subagent:activity", (data: unknown) => this.handleSubagentActivity(data));
			pi.events.on("herdr:blocked", (data: any) => {
				if (!data?.active) {
					this.blockedCount = Math.max(0, this.blockedCount - 1);
					if (this.blockedCount === 0) this.blockedMessage = undefined;
					this.publishState();
					return;
				}
				this.blockedCount += 1;
				this.blockedMessage = data.label;
				this.publishState();
			});
		}

		pi.on("session_start", (_event: unknown, ctx: any) => {
			this.isDisposed = false;
			this.isMainAgentWorking = false;
			this.currentToolName = null;
			this.activeSubagents.clear();
			this.blockedCount = 0;
			this.blockedMessage = undefined;
			this.lastFatalError = false;
			this.hasRunTask = false;
			this.clearTimers();
			this.publishState(true);
		});

		pi.on("agent_start", () => {
			this.hasRunTask = true;
			this.isMainAgentWorking = true;
			this.lastFatalError = false;
			this.clearTimers();
			this.publishState();
		});

		pi.on("turn_start", () => {
			this.hasRunTask = true;
			this.isMainAgentWorking = true;
			this.clearTimers();
			this.publishState();
		});

		pi.on("tool_execution_start", (event: any) => {
			this.currentToolName = event?.toolName ?? null;
			this.publishState();
		});

		pi.on("tool_execution_end", (event: any) => {
			this.currentToolName = null;
			if (event) this.handleToolExecutionEnd(event);
			this.publishState();
		});

		pi.on("ui_prompt_start", () => {
			this.blockedCount += 1;
			this.publishState();
		});

		pi.on("ui_prompt_end", () => {
			this.blockedCount = Math.max(0, this.blockedCount - 1);
			this.publishState();
		});

		pi.on("message_end", (event: any) => {
			const msg = event?.message;
			if (msg?.customType === "gentle-agents.result") {
				const taskId = msg?.details?.gentleAgents?.taskId;
				if (taskId && this.activeSubagents.has(taskId)) {
					this.activeSubagents.delete(taskId);
					this.publishState();
				}
			}
		});

		pi.on("agent_end", (event: any) => {
			const lastMsg = event?.messages?.[event?.messages?.length - 1];
			const isFatal =
				lastMsg &&
				"stopReason" in lastMsg &&
				(lastMsg.stopReason === "error" || lastMsg.stopReason === "aborted");
			if (isFatal) {
				this.lastFatalError = true;
			}
		});

		pi.on("agent_settled", (_event: unknown, ctx: any) => {
			if (ctx?.isIdle?.() !== true && typeof ctx?.isIdle === "function") return;
			this.isMainAgentWorking = false;
			this.currentToolName = null;
			this.publishState();
		});

		pi.on("session_shutdown", () => {
			this.dispose();
		});
	}

	public dispose(): void {
		this.isDisposed = true;
		this.isMainAgentWorking = false;
		this.currentToolName = null;
		this.activeSubagents.clear();
		this.clearTimers();
		this.emitTerminalTitle(undefined, "idle");
		if (this.isHerdrEnvironment() && this.lastReportedDisplayAgent) {
			const paneId = this.env.HERDR_PANE_ID!;
			const source = "herdr:pi";
			void this.executeSend({
				id: `${source}:meta:${Date.now()}:${Math.random().toString(36).slice(2)}`,
				method: "pane.report_metadata",
				params: {
					pane_id: paneId,
					source,
					agent: "pi",
					clear_display_agent: true,
					clear_title: true,
					seq: this.nextReportSeq(),
				},
			});
			this.lastReportedDisplayAgent = undefined;
		}
	}
}

let defaultHerdrTracker: HerdrTracker | null = null;

export function initHerdrTracker(pi: any, options?: HerdrTrackerOptions): HerdrTracker {
	if (!defaultHerdrTracker) {
		defaultHerdrTracker = new HerdrTracker(options);
		defaultHerdrTracker.wirePiEvents(pi);
	}
	return defaultHerdrTracker;
}

export function getActiveHerdrTracker(): HerdrTracker | null {
	return defaultHerdrTracker;
}

export function resetActiveHerdrTracker(): void {
	if (defaultHerdrTracker) {
		defaultHerdrTracker.dispose();
		defaultHerdrTracker = null;
	}
}
