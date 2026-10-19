import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HerdrTracker,
	getGentlePromptLabel,
	getHerdrSocketEndpoint,
	isHerdrActive,
} from "../lib/herdr.ts";
import { isHerdrActivePane } from "../lib/focus.ts";

describe("Herdr helper functions", () => {
	it("detects when Herdr environment is active", () => {
		const envActive = {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "herdr.sock",
			HERDR_PANE_ID: "w1:p1",
		};
		assert.equal(isHerdrActive(envActive), true);

		assert.equal(isHerdrActive({ HERDR_ENV: "0" }), false);
		assert.equal(isHerdrActive({ HERDR_ENV: "1" }), false);
		assert.equal(isHerdrActive({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "sock" }), false);
		assert.equal(isHerdrActive({}), false);
	});

	it("formats Windows named pipes and Unix domain sockets", () => {
		assert.equal(
			getHerdrSocketEndpoint("herdr-test.sock", "win32"),
			"\\\\.\\pipe\\herdr-test.sock",
		);
		assert.equal(
			getHerdrSocketEndpoint("/tmp/herdr-test.sock", "linux"),
			"/tmp/herdr-test.sock",
		);
		assert.equal(getHerdrSocketEndpoint(undefined), undefined);
	});

	it("detects active Herdr pane via isHerdrActivePane", () => {
		const env = {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p1",
		} as any;

		const activeMock = () => JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } });
		assert.equal(isHerdrActivePane(env, activeMock), true);

		const inactiveMock = () => JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
		assert.equal(isHerdrActivePane(env, inactiveMock), false);

		assert.equal(isHerdrActivePane({} as any), null);
	});

	it("uses the focused flag because pane current always returns the caller pane", () => {
		const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w4:p1" } as any;
		const ownPane = (focused: boolean) => () =>
			JSON.stringify({ result: { pane: { pane_id: "w4:p1", focused } } });
		assert.equal(isHerdrActivePane(env, ownPane(false)), false);
		assert.equal(isHerdrActivePane(env, ownPane(true)), true);
	});
});

describe("HerdrTracker process formatting and states", () => {
	it("uses registry prompt label and ordered distinct tool suffixes", () => {
		const key = Symbol.for("gentle-pi.odd-phase-registry");
		const prior = (globalThis as any)[key];
		try {
			(globalThis as any)[key] = { label: () => "exploring…" };
			const tracker = new HerdrTracker();
			const handlers = new Map<string, any>();
			tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
			handlers.get("agent_start")?.();
			handlers.get("tool_execution_start")?.({ toolCallId: "g", toolName: "grep" });
			handlers.get("tool_execution_start")?.({ toolCallId: "r", toolName: "gentle_review" });
			assert.equal(tracker.getDesiredState().message, "Exploring - Grep/Gentle-review");
		} finally {
			if (prior === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = prior;
		}
	});

	it("republishes after tool start to pick up a later inferred phase", async () => {
		const key = Symbol.for("gentle-pi.odd-phase-registry");
		const prior = (globalThis as any)[key];
		let phase: string | undefined;
		try {
			(globalThis as any)[key] = { label: () => phase };
			const tracker = new HerdrTracker();
			const handlers = new Map<string, any>();
			tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
			handlers.get("agent_start")?.();
			handlers.get("tool_execution_start")?.({ toolCallId: "x", toolName: "grep" });
			phase = "deciding";
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(tracker.getDesiredState().message, "Deciding - Grep");
		} finally {
			if (prior === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = prior;
		}
	});

	it("normalizes ellipsis variants in prompt labels", () => {
		const key = Symbol.for("gentle-pi.odd-phase-registry");
		const previous = (globalThis as any)[key];
		try {
			(globalThis as any)[key] = { label: () => "checking..." };
			assert.equal(getGentlePromptLabel(), "Checking");
			(globalThis as any)[key] = { label: () => "working…" };
			assert.equal(getGentlePromptLabel(), "Working");
		} finally {
			if (previous === undefined) delete (globalThis as any)[key];
			else (globalThis as any)[key] = previous;
		}
	});

	it("formats MCP tools, overflow, fallback label, and stepped subagent", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const events = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: (name: string, cb: any) => events.set(name, cb) } });
		handlers.get("agent_start")?.();
		assert.equal(getGentlePromptLabel(), "Working");
		assert.equal(tracker.getDesiredState().message, "Working");
		for (const [id, toolName] of [["1", "mcp__custom-tools__grep"], ["2", "read"], ["3", "write"], ["4", "bash"]]) {
			handlers.get("tool_execution_start")?.({ toolCallId: id, toolName });
		}
		assert.equal(tracker.getDesiredState().message, "Working - Grep/Read/Write/+1");
		const oneSub = new HerdrTracker();
		const sh = new Map<string, any>();
		const se = new Map<string, any>();
		oneSub.wirePiEvents({ on: (name: string, cb: any) => sh.set(name, cb), events: { on: (name: string, cb: any) => se.set(name, cb) } });
		se.get("gentle-agents:activity")?.({ tasks: [{ id: "x", agent: "gentle-ai-worker", status: "running", lastStep: "editing src/app.ts" }] });
		assert.equal(oneSub.getDesiredState().message, "Working - Gentle-ai-worker: editing src/app.ts");
	});
	it("reports idle state when nothing is active", () => {
		const tracker = new HerdrTracker();
		const state = tracker.getDesiredState();
		assert.equal(state.state, "idle");
		assert.equal(state.message, undefined);
		assert.equal(state.displayAgent, undefined);
	});

	it("formats local tool execution", () => {
		const tracker = new HerdrTracker();
		const pi = {
			on: (name: string, cb: any) => {
				handlers.set(name, cb);
			},
			events: {
				on: (name: string, cb: any) => {
					eventHandlers.set(name, cb);
				},
			},
		};
		const handlers = new Map<string, any>();
		const eventHandlers = new Map<string, any>();
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();
		handlers.get("tool_execution_start")?.({ toolName: "bash" });

		const state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Bash");
		assert.equal(state.displayAgent, "pi [⏳ Working - Bash]");
	});

	it("formats subagent activity and combines with main tool", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const eventHandlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => eventHandlers.set(name, cb) },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();

		// Single subagent active
		eventHandlers.get("gentle-agents:activity")?.({
			tasks: [{ id: "t1", agent: "explore", status: "running", lastStep: "read" }],
		});

		let state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Explore: read");
		assert.equal(state.displayAgent, "pi [⏳ Working - Explore: read]");

		// Main agent also executes a tool
		handlers.get("tool_execution_start")?.({ toolName: "write" });
		state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Write/Explore");
		assert.equal(state.displayAgent, "pi [⏳ Working - Write/Explore]");

		// Tool ends
		handlers.get("tool_execution_end")?.({ toolName: "write" });
		state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Explore: read");
		assert.equal(state.displayAgent, "pi [⏳ Working - Explore: read]");
	});

	it("keeps working state when main agent settles but subagent is still running", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const eventHandlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => eventHandlers.set(name, cb) },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();

		// Start subagent
		eventHandlers.get("gentle-agents:activity")?.({
			tasks: [{ id: "t1", agent: "worker", status: "running", lastStep: "edit" }],
		});

		// Main agent settles
		handlers.get("agent_settled")?.({}, { isIdle: () => true });

		const state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Worker: edit");
		assert.equal(state.displayAgent, "pi [⏳ Working - Worker: edit]");

		// Subagent finishes
		eventHandlers.get("gentle-agents:activity")?.({ tasks: [] });

		const finalState = tracker.getDesiredState();
		assert.equal(finalState.state, "idle");
		assert.equal(finalState.message, "[success]");
		assert.equal(finalState.displayAgent, "pi [✅ success]");
	});

	it("reports blocked state when subagent is waiting for user input", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const eventHandlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => eventHandlers.set(name, cb) },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});

		eventHandlers.get("gentle-agents:activity")?.({
			tasks: [{ id: "t1", agent: "worker", status: "waiting", lastStep: "asked confirmation" }],
		});

		const state = tracker.getDesiredState();
		assert.equal(state.state, "blocked");
		assert.ok(state.message?.includes("esperando respuesta"));
		assert.ok(state.displayAgent?.includes("❓ worker: esperando"));
	});

	it("preserves parent tool when nested tool call finishes (parentToolCallId)", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();

		// Outer tool starts (e.g. codemode)
		handlers.get("tool_execution_start")?.({ toolCallId: "call_outer", toolName: "codemode" });
		let state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Codemode");

		// Nested tool starts (e.g. read with parentToolCallId)
		handlers.get("tool_execution_start")?.({ toolCallId: "call_outer/1", toolName: "read", parentToolCallId: "call_outer" });
		state = tracker.getDesiredState();
		assert.equal(state.message, "Working - Codemode/Read");

		// Nested tool finishes
		handlers.get("tool_execution_end")?.({ toolCallId: "call_outer/1", toolName: "read", parentToolCallId: "call_outer" });
		state = tracker.getDesiredState();
		// Parent tool MUST still be active!
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Codemode");

		// Outer tool finishes
		handlers.get("tool_execution_end")?.({ toolCallId: "call_outer", toolName: "codemode" });
		state = tracker.getDesiredState();
		assert.equal(state.message, "Working");
	});

	it("prioritizes subagent name and step when main tool is subagent_run", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const eventHandlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => eventHandlers.set(name, cb) },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();

		// subagent_run starts in task mode
		handlers.get("tool_execution_start")?.({ toolCallId: "call_sub", toolName: "subagent_run" });
		eventHandlers.get("gentle-agents:activity")?.({
			tasks: [{ id: "t1", agent: "gentle-ai-worker", status: "running", lastStep: "editing src/app.ts" }],
		});

		const state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Gentle-ai-worker: editing src/app.ts");
		assert.equal(state.displayAgent, "pi [⏳ Working - Gentle-ai-worker: editing src/app.ts]");
	});

	it("activates working state on before_agent_start and user_bash", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		assert.equal(tracker.getDesiredState().state, "idle");

		// before_agent_start activates working state immediately
		handlers.get("before_agent_start")?.({ prompt: "hello" });
		assert.equal(tracker.getDesiredState().state, "working");
		assert.equal(tracker.getDesiredState().message, "Working");

		// agent finishes
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		assert.equal(tracker.getDesiredState().state, "idle");

		// user_bash activates working state
		handlers.get("user_bash")?.({ command: "git status" });
		assert.equal(tracker.getDesiredState().state, "working");
		assert.equal(tracker.getDesiredState().message, "Working - Bash");
	});

	it("formats compaction and auto-retry states", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});

		// compaction start
		handlers.get("session_before_compact")?.();
		let state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Compactando contexto");

		// compaction ends
		handlers.get("session_compact")?.();
		state = tracker.getDesiredState();
		assert.equal(state.state, "idle");

		// auto retry
		handlers.get("auto_retry_start")?.({ attempt: 2, maxAttempts: 3 });
		state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Reintentando (2/3)");

		// auto retry ends
		handlers.get("auto_retry_end")?.();
		state = tracker.getDesiredState();
		assert.equal(state.state, "idle");
	});

	it("handles direct gentle-pi blocked choice/question events", () => {
		const tracker = new HerdrTracker();
		const eventHandlers = new Map<string, any>();
		const pi = {
			on: () => {},
			events: { on: (name: string, cb: any) => eventHandlers.set(name, cb) },
		};
		tracker.wirePiEvents(pi);

		eventHandlers.get("gentle-pi:ask-user-choice:blocked")?.({ active: true });
		let state = tracker.getDesiredState();
		assert.equal(state.state, "blocked");
		assert.equal(state.message, "esperando selección");

		eventHandlers.get("gentle-pi:ask-user-choice:blocked")?.({ active: false });
		state = tracker.getDesiredState();
		assert.equal(state.state, "idle");
	});

	it("bridges working state when background subagent result arrives before parent wakes", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const eventHandlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => eventHandlers.set(name, cb) },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});

		// Subagent is running in background while parent is idle
		eventHandlers.get("gentle-agents:activity")?.({
			tasks: [{ id: "t1", agent: "explore", status: "running", lastStep: "reading files" }],
		});
		assert.equal(tracker.getDesiredState().state, "working");

		// Subagent task finishes, gentle-agents:activity emits empty tasks
		eventHandlers.get("gentle-agents:activity")?.({ tasks: [] });
		// But gentle-agents.result arrives at message_end
		handlers.get("message_end")?.({
			message: {
				customType: "gentle-agents.result",
				details: { gentleAgents: { taskId: "t1" } },
			},
		});

		// Working state is preserved for parent orchestrator wake!
		assert.equal(tracker.getDesiredState().state, "working");
		assert.equal(tracker.getDesiredState().message, "Working");

		// Parent settles after processing subagent output
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		assert.equal(tracker.getDesiredState().state, "idle");
	});

	it("keeps working state and formats background jobs when main agent settles", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const events = new Map<string, any>();
		tracker.wirePiEvents({
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => events.set(name, cb) },
		});
		handlers.get("agent_start")?.();

		// Background job is running
		events.get("gentle-ai:jobs-sidebar")?.({
			snapshot: {
				jobs: [{ id: "job-1", label: "CI build", startedAt: Date.now() }],
			},
		});

		// Main agent settles while background job is still running
		handlers.get("agent_settled")?.({}, { isIdle: () => true });

		const state = tracker.getDesiredState();
		assert.equal(state.state, "working", "must not mark as idle while jobs run");
		assert.notEqual(state.message, "[success]", "must not mark as success while jobs run");
		assert.equal(state.message, "Working - Job: CI build");
		assert.equal(state.displayAgent, "pi [⏳ Working - Job: CI build]");

		// When job finishes and snapshot is empty
		events.get("gentle-ai:jobs-sidebar")?.({
			snapshot: { jobs: [] },
		});

		const settledState = tracker.getDesiredState();
		assert.equal(settledState.state, "idle");
		assert.equal(settledState.message, "[success]");
		assert.equal(settledState.displayAgent, "pi [✅ success]");
	});

	it("formats multiple background jobs and combinations with tools and subagents", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const events = new Map<string, any>();
		tracker.wirePiEvents({
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => events.set(name, cb) },
		});
		handlers.get("agent_start")?.();

		// Multiple jobs
		events.get("gentle-ai:jobs-sidebar")?.({
			snapshot: {
				jobs: [
					{ id: "j1", label: "test", startedAt: 1 },
					{ id: "j2", label: "lint", startedAt: 2 },
				],
			},
		});
		assert.equal(tracker.getDesiredState().message, "Working - 2 jobs");

		// Combined with active tool
		handlers.get("tool_execution_start")?.({ toolCallId: "t1", toolName: "read" });
		assert.equal(tracker.getDesiredState().message, "Working - Read/2 jobs");

		// Combined with tool and subagent
		events.get("gentle-agents:activity")?.({
			tasks: [{ id: "sub1", agent: "gentle-ai-worker", status: "running" }],
		});
		assert.equal(tracker.getDesiredState().message, "Working - Read/Gentle-ai-worker/2 jobs");

		handlers.get("tool_execution_end")?.({ toolCallId: "t1", toolName: "read" });
		assert.equal(tracker.getDesiredState().message, "Working - Gentle-ai-worker/2 jobs");
	});

	it("tracks background jobs from bash_background tool execution and job notices", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		});
		handlers.get("agent_start")?.();

		// bash_background tool starts a job
		handlers.get("tool_execution_end")?.({
			toolName: "bash_background",
			result: {
				details: {
					gentleJobs: { id: "job-42", label: "watch CI", status: "running" },
				},
			},
		});

		// Main agent settles
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		assert.equal(tracker.getDesiredState().state, "working");
		assert.equal(tracker.getDesiredState().message, "Working - Job: watch CI");

		// Job exit notice arrives via message_end
		handlers.get("message_end")?.({
			message: {
				customType: "gentle-jobs.notice",
				details: { gentleJobs: { id: "job-42" } },
			},
		});

		assert.equal(tracker.getDesiredState().state, "idle");
		assert.equal(tracker.getDesiredState().message, "[success]");
	});

	it("tracks background jobs from string count and job_stop", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const events = new Map<string, any>();
		tracker.wirePiEvents({
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => events.set(name, cb) },
		});
		handlers.get("agent_start")?.();

		// Status string event e.g. "⧗ 2 jobs"
		events.get("jobs:activity")?.("⧗ 2 jobs");
		assert.equal(tracker.getDesiredState().message, "Working - 2 jobs");

		// job_stop stops one job
		handlers.get("tool_execution_end")?.({
			toolName: "job_stop",
			result: {
				details: { gentleJobs: { id: "job-1" } },
			},
		});
		assert.equal(tracker.getDesiredState().message, "Working - 1 job");
	});

	it("ignores background jobs from a different session when sessionId is provided", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const events = new Map<string, any>();
		tracker.wirePiEvents({
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => events.set(name, cb) },
		});
		handlers.get("session_start")?.({}, { sessionId: "session-a" });
		handlers.get("agent_start")?.({}, { sessionId: "session-a" });

		// Event from session-b should be ignored
		events.get("gentle-ai:jobs-sidebar")?.({
			sessionId: "session-b",
			snapshot: {
				jobs: [{ id: "job-ext", label: "external", startedAt: 1 }],
			},
		});
		assert.equal(tracker.getActiveJobs().length, 0);

		// Event from matching session-a should be accepted
		events.get("gentle-ai:jobs-sidebar")?.({
			sessionId: "session-a",
			snapshot: {
				jobs: [{ id: "job-a", label: "own job", startedAt: 1 }],
			},
		});
		assert.equal(tracker.getActiveJobs().length, 1);
		assert.equal(tracker.getDesiredState().message, "Working - Job: own job");
	});

	it("tracks background jobs from monitor tool execution and regex text parsing", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		});
		handlers.get("agent_start")?.();

		// monitor tool output with text content format
		handlers.get("tool_execution_end")?.({
			toolName: "monitor",
			result: {
				content: [{ text: 'Started monitor "tail log" (mon-1) for up to 30s.' }],
			},
		});
		assert.equal(tracker.getActiveJobs().length, 1);
		assert.equal(tracker.getDesiredState().message, "Working - Job: tail log");

		// Stopped via job_stop text output
		handlers.get("tool_execution_end")?.({
			toolName: "job_stop",
			result: {
				content: [{ text: 'Stopped "tail log" (mon-1).' }],
			},
		});
		assert.equal(tracker.getActiveJobs().length, 0);
	});
});

describe("HerdrTracker agent state matrix", () => {
	function setup() {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const events = new Map<string, any>();
		tracker.wirePiEvents({
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => events.set(name, cb) },
		});
		return { tracker, handlers, events };
	}

	it("moves from initial idle through thinking/tool work to success and fatal-error idle", () => {
		const { tracker, handlers } = setup();
		assert.equal(tracker.getDesiredState().state, "idle");
		handlers.get("agent_start")?.();
		assert.equal(tracker.getDesiredState().state, "working");
		handlers.get("tool_execution_start")?.({ toolCallId: "read", toolName: "read" });
		assert.equal(tracker.getDesiredState().state, "working");
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		assert.deepEqual(tracker.getDesiredState(), { state: "idle", message: "[success]", displayAgent: "pi [✅ success]" });
		handlers.get("agent_start")?.();
		handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "error" }] });
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		assert.equal(tracker.getDesiredState().message, "[error]");
	});

	it("blocks during gentle_review consent ui_prompt despite the active tool", () => {
		const { tracker, handlers } = setup();
		handlers.get("agent_start")?.();
		handlers.get("tool_execution_start")?.({ toolCallId: "review", toolName: "gentle_review" });
		handlers.get("ui_prompt_start")?.({ reason: "ui_prompt", kind: "select", title: "Consent" });
		const state = tracker.getDesiredState();
		assert.equal(state.state, "blocked");
		assert.ok(state.message?.includes("esperando respuesta"));
		assert.ok(state.displayAgent?.includes("❓"));
	});

	it("blocks codemode while ask-user-question is awaiting input", () => {
		const { tracker, handlers, events } = setup();
		handlers.get("agent_start")?.();
		handlers.get("tool_execution_start")?.({ toolCallId: "code", toolName: "codemode" });
		events.get("gentle-pi:ask-user-question:blocked")?.({ active: true });
		const state = tracker.getDesiredState();
		assert.equal(state.state, "blocked");
		assert.ok(state.displayAgent?.includes("❓"));
	});

	it("keeps question blocker when another parallel tool becomes current", () => {
		const { tracker, handlers, events } = setup();
		handlers.get("agent_start")?.();
		handlers.get("tool_execution_start")?.({ toolCallId: "choice", toolName: "ask_user_choice" });
		events.get("gentle-pi:ask-user-choice:blocked")?.({ active: true });
		handlers.get("tool_execution_start")?.({ toolCallId: "bash", toolName: "bash" });
		assert.equal(tracker.getDesiredState().state, "blocked");
		handlers.get("tool_execution_end")?.({ toolCallId: "bash", toolName: "bash" });
		assert.equal(tracker.getDesiredState().state, "blocked");
		events.get("gentle-pi:ask-user-choice:blocked")?.({ active: false });
		assert.equal(tracker.getDesiredState().state, "working");
	});

	it("keeps herdr:blocked active while a non-ask tool runs", () => {
		const { tracker, handlers, events } = setup();
		handlers.get("agent_start")?.();
		events.get("herdr:blocked")?.({ active: true, label: "Choice awaiting input" });
		handlers.get("tool_execution_start")?.({ toolCallId: "edit", toolName: "edit" });
		const state = tracker.getDesiredState();
		assert.equal(state.state, "blocked");
		assert.equal(state.message, "Choice awaiting input");
		assert.ok(state.displayAgent?.includes("❓"));
	});

	it("clears blockers on prompt end and blocker end, then settles to success", () => {
		const { tracker, handlers, events } = setup();
		handlers.get("agent_start")?.();
		handlers.get("tool_execution_start")?.({ toolCallId: "review", toolName: "gentle_review" });
		handlers.get("ui_prompt_start")?.({});
		handlers.get("tool_execution_start")?.({ toolCallId: "parallel", toolName: "read" });
		assert.equal(tracker.getDesiredState().state, "blocked");
		handlers.get("ui_prompt_end")?.({});
		assert.equal(tracker.getDesiredState().state, "working");
		handlers.get("tool_execution_end")?.({ toolCallId: "review", toolName: "gentle_review" });
		events.get("gentle-pi:ask-user-question:blocked")?.({ active: true });
		events.get("gentle-pi:ask-user-question:blocked")?.({ active: false });
		assert.equal(tracker.getDesiredState().state, "working");
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		assert.equal(tracker.getDesiredState().message, "[success]");
	});

	it("remains blocked until all overlapping blockers end", () => {
		const { tracker, handlers, events } = setup();
		handlers.get("agent_start")?.();
		events.get("herdr:blocked")?.({ active: true, label: "Choice awaiting input" });
		events.get("gentle-pi:ask-user-choice:blocked")?.({ active: true });
		events.get("herdr:blocked")?.({ active: false });
		assert.equal(tracker.getDesiredState().state, "blocked");
		events.get("gentle-pi:ask-user-choice:blocked")?.({ active: false });
		assert.equal(tracker.getDesiredState().state, "working");
	});

	it("publishes blocked state to the Herdr pane during gentle_review consent", async () => {
		const sent: any[] = [];
		const tracker = new HerdrTracker({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "test.sock", HERDR_PANE_ID: "w1:p1" },
			sendRequest: async (_endpoint, request) => { sent.push(request); return true; },
			writeStdout: () => {},
		});
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
		handlers.get("agent_start")?.();
		handlers.get("tool_execution_start")?.({ toolCallId: "review", toolName: "gentle_review" });
		handlers.get("ui_prompt_start")?.({ kind: "select" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(sent.some((request) => request.method === "pane.report_agent" && request.params.state === "blocked"));
	});
});

describe("HerdrTracker diagnostics", () => {
	it("is silent by default and emits bounded redacted activity, state, and IPC traces when enabled", async () => {
		const lines: string[] = [];
		const sent: unknown[] = [];
		const tracker = new HerdrTracker({
			env: { PI_NOTIFY_HERDR_DIAGNOSTICS: "1", HERDR_ENV: "1", HERDR_SOCKET_PATH: "secret-socket-path", HERDR_PANE_ID: "secret-pane" },
			writeStdout: () => {},
			writeDiagnostic: (line) => lines.push(line),
			sendRequest: async (_endpoint, request) => { sent.push(request); return true; },
		});
		const handlers = new Map<string, any>();
		const events = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: (name: string, cb: any) => events.set(name, cb) } });
		const secret = "PRIVATE_PROMPT_SESSION_AGENT_MESSAGE";
		handlers.get("session_start")?.({}, {});
		events.get("gentle-agents:activity")?.({ tasks: [{ id: secret, agent: secret, label: secret, lastStep: secret, status: "running" }] });
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		events.get("gentle-agents:activity")?.({ tasks: [] });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(lines.some((line) => line.includes('"event":"activity_received"')));
		assert.ok(lines.some((line) => line.includes('"event":"desired_state"')));
		assert.ok(lines.some((line) => line.includes('"event":"ipc_send"')));
		const stateTraces = lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === "desired_state");
		assert.ok(stateTraces.some((entry) => entry.state === "working"));
		assert.ok(stateTraces.some((entry) => entry.state === "idle"));
		assert.ok(lines.every((line) => !line.includes(secret)));
		assert.ok(lines.every((line) => !line.includes("secret-socket-path") && !line.includes("secret-pane")));
		assert.ok(sent.length > 0);
	});

	it("records IPC retry outcomes and isolates diagnostic writer failures", async () => {
		let calls = 0;
		const tracker = new HerdrTracker({
			env: { PI_NOTIFY_HERDR_DIAGNOSTICS: "1", HERDR_ENV: "1", HERDR_SOCKET_PATH: "sock", HERDR_PANE_ID: "pane" },
			writeStdout: () => {},
			writeDiagnostic: () => { throw new Error("diagnostic output failed"); },
			sendRequest: async () => ++calls > 1,
		});
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
		handlers.get("agent_start")?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(calls >= 2, "failed first IPC send should still retry");
		assert.equal(tracker.getDesiredState().state, "working");
	});

	it("reports failed IPC attempt followed by retry success", async () => {
		const lines: string[] = [];
		let calls = 0;
		const tracker = new HerdrTracker({
			env: { PI_NOTIFY_HERDR_DIAGNOSTICS: "1", HERDR_ENV: "1", HERDR_SOCKET_PATH: "sock", HERDR_PANE_ID: "pane" },
			writeStdout: () => {},
			writeDiagnostic: (line) => lines.push(line),
			sendRequest: async () => ++calls > 1,
		});
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
		handlers.get("agent_start")?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(lines.some((line) => line.includes('"attempt":1,"success":false')));
		assert.ok(lines.some((line) => line.includes('"attempt":2,"success":true,"retry":true')));
	});

	it("preserves one-attempt thrown-send rejection parity with diagnostics enabled and disabled", async () => {
		for (const enabled of [false, true]) {
			let calls = 0;
			const rejection = new Error("send rejected");
			const tracker = new HerdrTracker({
				env: { ...(enabled ? { PI_NOTIFY_HERDR_DIAGNOSTICS: "1" } : {}), HERDR_SOCKET_PATH: "sock", HERDR_PANE_ID: "pane" },
				writeStdout: () => {},
				writeDiagnostic: () => {},
				sendRequest: async () => { calls++; throw rejection; },
			});
			await assert.rejects((tracker as any).executeSend({ method: "pane.report_agent" }), rejection);
			assert.equal(calls, 1);
		}
	});

	it("keeps every diagnostic record valid JSON within the record and character caps", () => {
		const lines: string[] = [];
		const tracker = new HerdrTracker({
			env: { PI_NOTIFY_HERDR_DIAGNOSTICS: "1" },
			writeDiagnostic: (line) => lines.push(line),
			writeStdout: () => {},
		});
		for (let i = 0; i < 700; i++) tracker.publishState(true);
		assert.equal(lines.length, 500);
		for (const line of lines) {
			assert.ok(line.length <= 500);
			assert.doesNotThrow(() => JSON.parse(line));
		}
	});

	it("redacts arbitrary oversized IPC method names", async () => {
		const lines: string[] = [];
		const tracker = new HerdrTracker({
			env: { PI_NOTIFY_HERDR_DIAGNOSTICS: "1", HERDR_SOCKET_PATH: "sock", HERDR_PANE_ID: "pane" },
			writeDiagnostic: (line) => lines.push(line),
			sendRequest: async () => true,
		});
		await (tracker as any).executeSend({ method: `secret-${"x".repeat(1000)}` });
		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => JSON.parse(line).method === "unknown"));
		assert.ok(lines.every((line) => !line.includes("secret-") && line.length <= 500));
	});

	it("does not invoke diagnostic writer when diagnostics are disabled", () => {
		let writes = 0;
		const tracker = new HerdrTracker({ env: {}, writeDiagnostic: () => writes++ });
		tracker.handleSubagentActivity({ tasks: [{ status: "running" }] });
		tracker.publishState(true);
		assert.equal(writes, 0);
	});
});

describe("HerdrTracker socket communication", () => {
	it("sends pane.report_agent and pane.report_metadata over mock socket in Herdr env", async () => {
		const sentRequests: any[] = [];
		const mockSend = async (_endpoint: string, request: unknown) => {
			sentRequests.push(request);
			return true;
		};

		const env = {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "test.sock",
			HERDR_PANE_ID: "w1:p1",
		};

		const tracker = new HerdrTracker({
			env,
			sendRequest: mockSend,
			writeStdout: () => {},
		});

		const handlers = new Map<string, any>();
		const eventHandlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => eventHandlers.set(name, cb) },
			getSessionName: () => "feature-review",
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();
		handlers.get("tool_execution_start")?.({ toolName: "bash" });

		// Give async drainQueue time
		await new Promise((r) => setTimeout(r, 20));

		assert.ok(sentRequests.length >= 1);
		const agentReports = sentRequests.filter((r) => r.method === "pane.report_agent");
		assert.ok(agentReports.length >= 1);
		const lastAgentReport = agentReports[agentReports.length - 1];
		assert.equal(lastAgentReport.params.pane_id, "w1:p1");
		assert.equal(lastAgentReport.params.source, "herdr:pi");
		assert.equal(lastAgentReport.params.state, "working");

		const metaReport = sentRequests.find((r) => r.method === "pane.report_metadata");
		assert.ok(metaReport);
		assert.equal(metaReport.params.display_agent, "pi [⏳ Working - Bash]");
	});

	it("does not publish queued metadata after dispose while agent IPC is delayed", async () => {
		const sent: any[] = [];
		let releaseAgent!: () => void;
		let agentStarted!: () => void;
		const started = new Promise<void>((resolve) => { agentStarted = resolve; });
		const tracker = new HerdrTracker({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "test.sock", HERDR_PANE_ID: "w1:p1" },
			sendRequest: async (_endpoint, request) => {
				sent.push(request);
				if (request.method === "pane.report_agent") {
					agentStarted();
					await new Promise<void>((resolve) => { releaseAgent = resolve; });
				}
				return true;
			},
			writeStdout: () => {},
		});
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
		handlers.get("agent_start")?.();
		handlers.get("tool_execution_start")?.({ toolName: "bash" });
		await started;
		assert.equal(sent.some((request) => request.method === "pane.report_agent"), true, "report_agent reached the held sender before dispose");
		tracker.dispose();
		releaseAgent();
		await new Promise((resolve) => setTimeout(resolve, 20));

		const metadata = sent.filter((request) => request.method === "pane.report_metadata");
		assert.equal(metadata.length, 1);
		assert.equal(metadata[0].params.clear_display_agent, true);
	});

	it("clears branch metadata on dispose and ignores a late branch resolution", async () => {
		const sent: any[] = [];
		let resolveBranch!: (branch: string | undefined) => void;
		let resolutions = 0;
		const tracker = new HerdrTracker({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "test.sock", HERDR_PANE_ID: "w1:p1" },
			resolveBranch: () => ++resolutions === 1
				? Promise.resolve("current-branch")
				: new Promise((resolve) => { resolveBranch = resolve; }),
			sendRequest: async (_endpoint, request) => { sent.push(request); return true; },
			writeStdout: () => {},
		});
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
		handlers.get("agent_start")?.({}, { cwd: process.cwd() });
		await new Promise((resolve) => setTimeout(resolve, 10));
		handlers.get("agent_start")?.({}, { cwd: process.cwd() });
		await new Promise((resolve) => setTimeout(resolve, 10));
		tracker.dispose();
		resolveBranch("late-branch");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const metadata = sent.filter((request) => request.method === "pane.report_metadata");
		const cleared = metadata.find((request) => request.params.clear_title && request.params.clear_display_agent);
		assert.ok(cleared);
		assert.equal(cleared.params.tokens.branch, "");
		assert.equal(metadata.some((request) => request.params.tokens?.branch === "late-branch"), false);
	});

	it("clears old branch immediately when cwd changes, even if the new directory is unavailable", async () => {
		const sent: any[] = [];
		let currentBranch: string | undefined = "old-branch";
		let deferNewCwd = false;
		const tracker = new HerdrTracker({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "test.sock", HERDR_PANE_ID: "w1:p1" },
			resolveBranch: async (cwd) => {
				if (cwd === "unavailable-new-cwd" && deferNewCwd) return new Promise(() => {});
				return currentBranch;
			},
			sendRequest: async (_endpoint, request) => { sent.push(request); return true; },
			writeStdout: () => {},
		});
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
		const initialCwd = "existing-cwd";
		handlers.get("agent_start")?.({}, { cwd: initialCwd });
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(sent.some((request) => request.method === "pane.report_metadata" && request.params.tokens?.branch === "old-branch"));

		const before = sent.filter((request) => request.method === "pane.report_metadata").length;
		currentBranch = undefined;
		deferNewCwd = true;
		handlers.get("agent_start")?.({}, { cwd: "unavailable-new-cwd" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const metadata = sent.filter((request) => request.method === "pane.report_metadata");
		assert.ok(metadata.length > before);
		assert.equal(metadata.at(-1)?.params.tokens?.branch ?? "", "");
		tracker.dispose();
	});

	it("reports branch token and refreshes it when the branch changes without state changes", async () => {
		const sent: any[] = [];
		let branch: string | undefined = "feat/one";
		const tracker = new HerdrTracker({
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "test.sock", HERDR_PANE_ID: "w1:p1" },
			resolveBranch: async (cwd) => { assert.equal(cwd, process.cwd()); return branch; },
			sendRequest: async (_endpoint, request) => { sent.push(request); return true; },
			writeStdout: () => {},
		});
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
		handlers.get("agent_start")?.({}, { cwd: process.cwd() });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(sent.some((request) => request.method === "pane.report_metadata" && request.params.tokens.branch === "feat/one"));

		const before = sent.filter((request) => request.method === "pane.report_metadata").length;
		branch = "feat/two";
		handlers.get("agent_start")?.({}, { cwd: process.cwd() });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const metadata = sent.filter((request) => request.method === "pane.report_metadata");
		assert.ok(metadata.length > before);
		assert.equal(metadata.at(-1)?.params.tokens.branch, "feat/two");

		branch = undefined;
		handlers.get("agent_start")?.({}, { cwd: process.cwd() });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const cleared = sent.filter((request) => request.method === "pane.report_metadata");
		assert.equal(cleared.at(-1)?.params.tokens.branch, "");
	});

	it("formats thinking state when agent starts without a tool", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();

		const state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working");
		assert.equal(state.displayAgent, "pi [⏳ Working]");
	});

	it("child producer marker prevents lifecycle hooks from publishing Herdr titles or pane results", async () => {
		const writes: string[] = [];
		const sent: unknown[] = [];
		const tracker = new HerdrTracker({
			env: {
				GENTLE_PI_AGENTS_CHILD: "1",
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: "test.sock",
				HERDR_PANE_ID: "w1:p1",
			},
			writeStdout: (chunk) => writes.push(chunk),
			sendRequest: async (_endpoint, request) => { sent.push(request); return true; },
		});
		const handlers = new Map<string, any>();
		tracker.wirePiEvents({ on: (name: string, cb: any) => handlers.set(name, cb), events: { on: () => {} } });
		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();
		handlers.get("agent_end")?.({ messages: [{ stopReason: "error" }] });
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		handlers.get("session_shutdown")?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(writes, []);
		assert.deepEqual(sent, []);
	});

	it("formats fatal error on agent_end stopReason", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.();
		handlers.get("agent_end")?.({
			messages: [{ role: "assistant", stopReason: "error" }],
		});
		handlers.get("agent_settled")?.({}, { isIdle: () => true });

		const state = tracker.getDesiredState();
		assert.equal(state.state, "idle");
		assert.equal(state.message, "[error]");
		assert.equal(state.displayAgent, "pi [❌ error]");
	});

	it("emits terminal titles matching PowerShell indicators", () => {
		let lastWritten = "";
		const tracker = new HerdrTracker({
			env: {},
			writeStdout: (chunk) => {
				lastWritten = chunk;
			},
		});

		// Working
		tracker.emitTerminalTitle("Working - Bash", "working");
		assert.ok(lastWritten.includes("⏳ Working - Bash"));
		assert.ok(lastWritten.includes("\x1b]9;4;3\x07"));

		// Blocked
		tracker.emitTerminalTitle("[esperando respuesta]", "blocked");
		assert.ok(lastWritten.includes("❓ [esperando respuesta]"));
		assert.ok(lastWritten.includes("\x1b]9;4;4;100\x07"));

		// Idle (clean start)
		tracker.emitTerminalTitle(undefined, "idle");
		assert.ok(lastWritten.includes("\x1b]9;4;0\x07"));
	});

	it("preserves working and exploring state when tool executes, clearing or ignoring stale blockers", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const eventHandlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: (name: string, cb: any) => eventHandlers.set(name, cb) },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});

		// Stale blocker event from previous turn (e.g. prompt or question that was cancelled)
		eventHandlers.get("gentle-pi:ask-user-question:blocked")?.({ active: true });
		assert.equal(tracker.getDesiredState().state, "blocked");

		// User submits a new message / turn starts
		handlers.get("before_agent_start")?.();
		handlers.get("agent_start")?.();

		// Main agent runs read tool (exploring)
		handlers.get("tool_execution_start")?.({ toolName: "read" });

		const state = tracker.getDesiredState();
		// Must NOT be blocked with 'esperando respuesta' while tool is running!
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working - Read");
		assert.equal(state.displayAgent, "pi [⏳ Working - Read]");
	});

	it("formats gentle-pi ODD phase during thinking instead of generic pensando", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		};
		tracker.wirePiEvents(pi);

		const sessionId = "test-odd-session";
		const ODD_PHASE_REGISTRY = Symbol.for("gentle-pi.odd-phase-registry");
		(globalThis as any)[ODD_PHASE_REGISTRY] = {
			get: (id: string) => (id === sessionId ? "exploring" : undefined),
			phases: new Map([[sessionId, { phase: "exploring" }]]),
		};

		const ctx = {
			sessionManager: { getSessionId: () => sessionId },
		};

		handlers.get("session_start")?.({}, ctx);
		handlers.get("agent_start")?.({}, ctx);

		const state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Exploring");
		assert.equal(state.displayAgent, "pi [⏳ Exploring]");

		delete (globalThis as any)[ODD_PHASE_REGISTRY];
	});

	it("transitions from Working - Bash to Exploring or Working when tool execution ends", () => {
		const tracker = new HerdrTracker();
		const handlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		};
		tracker.wirePiEvents(pi);

		const sessionId = "test-transition-session";
		const ODD_PHASE_REGISTRY = Symbol.for("gentle-pi.odd-phase-registry");
		(globalThis as any)[ODD_PHASE_REGISTRY] = {
			get: (id: string) => (id === sessionId ? "exploring" : undefined),
			phases: new Map([[sessionId, { phase: "exploring" }]]),
		};

		const ctx = {
			sessionManager: { getSessionId: () => sessionId },
		};

		handlers.get("session_start")?.({}, ctx);
		handlers.get("agent_start")?.({}, ctx);

		// Bash tool starts
		handlers.get("tool_execution_start")?.({ toolCallId: "call_1", toolName: "bash" }, ctx);
		let state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Exploring - Bash");
		assert.equal(state.displayAgent, "pi [⏳ Exploring - Bash]");

		// Bash tool ends -> agent is now thinking and should show active exploring phase
		handlers.get("tool_execution_end")?.({ toolCallId: "call_1", toolName: "bash" }, ctx);
		state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Exploring");
		assert.equal(state.displayAgent, "pi [⏳ Exploring]");

		// Agent settles -> should show [success]
		handlers.get("agent_settled")?.({}, { ...ctx, isIdle: () => true });
		state = tracker.getDesiredState();
		assert.equal(state.state, "idle");
		assert.equal(state.message, "[success]");
		assert.equal(state.displayAgent, "pi [✅ success]");

		delete (globalThis as any)[ODD_PHASE_REGISTRY];
	});

	it("omits agent name prefix when showAgentPrefix is false to free pane space", () => {
		const tracker = new HerdrTracker({ showAgentPrefix: false });
		const handlers = new Map<string, any>();
		const pi = {
			on: (name: string, cb: any) => handlers.set(name, cb),
			events: { on: () => {} },
		};
		tracker.wirePiEvents(pi);

		handlers.get("session_start")?.({}, {});
		handlers.get("agent_start")?.({}, {});

		// Working state without 'pi ' prefix
		let state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "Working");
		assert.equal(state.displayAgent, "[⏳ Working]");

		// Tool running
		handlers.get("tool_execution_start")?.({ toolCallId: "call_1", toolName: "read" }, {});
		state = tracker.getDesiredState();
		assert.equal(state.message, "Working - Read");
		assert.equal(state.displayAgent, "[⏳ Working - Read]");

		// Success
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		state = tracker.getDesiredState();
		assert.equal(state.state, "idle");
		assert.equal(state.message, "[success]");
		assert.equal(state.displayAgent, "[✅ success]");
	});
});
