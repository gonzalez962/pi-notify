import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HerdrTracker,
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
});

describe("HerdrTracker process formatting and states", () => {
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
		assert.equal(state.message, "[bash]");
		assert.equal(state.displayAgent, "pi [⏳ bash]");
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
		assert.equal(state.message, "[explore: read]");
		assert.equal(state.displayAgent, "pi [⏳ explore: read]");

		// Main agent also executes a tool
		handlers.get("tool_execution_start")?.({ toolName: "write" });
		state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "[write (+1 sub)]");
		assert.equal(state.displayAgent, "pi [⏳ write (+1 sub)]");

		// Tool ends
		handlers.get("tool_execution_end")?.({ toolName: "write" });
		state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "[explore: read]");
		assert.equal(state.displayAgent, "pi [⏳ explore: read]");
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
		assert.equal(state.message, "[worker: edit]");
		assert.equal(state.displayAgent, "pi [⏳ worker: edit]");

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
		assert.equal(state.message, "[codemode]");

		// Nested tool starts (e.g. read with parentToolCallId)
		handlers.get("tool_execution_start")?.({ toolCallId: "call_outer/1", toolName: "read", parentToolCallId: "call_outer" });
		state = tracker.getDesiredState();
		assert.equal(state.message, "[read]");

		// Nested tool finishes
		handlers.get("tool_execution_end")?.({ toolCallId: "call_outer/1", toolName: "read", parentToolCallId: "call_outer" });
		state = tracker.getDesiredState();
		// Parent tool MUST still be active!
		assert.equal(state.state, "working");
		assert.equal(state.message, "[codemode]");

		// Outer tool finishes
		handlers.get("tool_execution_end")?.({ toolCallId: "call_outer", toolName: "codemode" });
		state = tracker.getDesiredState();
		assert.equal(state.message, "[pensando]");
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
		assert.equal(state.message, "[gentle-ai-worker: editing src/app.ts]");
		assert.equal(state.displayAgent, "pi [⏳ gentle-ai-worker: editing src/app.ts]");
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
		assert.equal(tracker.getDesiredState().message, "[pensando]");

		// agent finishes
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		assert.equal(tracker.getDesiredState().state, "idle");

		// user_bash activates working state
		handlers.get("user_bash")?.({ command: "git status" });
		assert.equal(tracker.getDesiredState().state, "working");
		assert.equal(tracker.getDesiredState().message, "[bash]");
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
		assert.equal(state.message, "[compactando contexto]");

		// compaction ends
		handlers.get("session_compact")?.();
		state = tracker.getDesiredState();
		assert.equal(state.state, "idle");

		// auto retry
		handlers.get("auto_retry_start")?.({ attempt: 2, maxAttempts: 3 });
		state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "[reintentando (2/3)]");

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
		assert.equal(tracker.getDesiredState().message, "[pensando]");

		// Parent settles after processing subagent output
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		assert.equal(tracker.getDesiredState().state, "idle");
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
		assert.equal(metaReport.params.display_agent, "pi [⏳ bash]");
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
		assert.equal(state.message, "[pensando]");
		assert.equal(state.displayAgent, "pi [⏳ pensando]");
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
			writeStdout: (chunk) => {
				lastWritten = chunk;
			},
		});

		// Working
		tracker.emitTerminalTitle("[bash]", "working");
		assert.ok(lastWritten.includes("⏳ [bash]"));
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
		assert.equal(state.message, "[read]");
		assert.equal(state.displayAgent, "pi [⏳ read]");
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
		assert.equal(state.message, "[exploring]");
		assert.equal(state.displayAgent, "pi [⏳ exploring]");

		delete (globalThis as any)[ODD_PHASE_REGISTRY];
	});

	it("transitions from [bash] to [exploring] or [pensando] when tool execution ends", () => {
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
		assert.equal(state.message, "[bash]");
		assert.equal(state.displayAgent, "pi [⏳ bash]");

		// Bash tool ends -> agent is now thinking and should show active exploring phase
		handlers.get("tool_execution_end")?.({ toolCallId: "call_1", toolName: "bash" }, ctx);
		state = tracker.getDesiredState();
		assert.equal(state.state, "working");
		assert.equal(state.message, "[exploring]");
		assert.equal(state.displayAgent, "pi [⏳ exploring]");

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
		assert.equal(state.message, "[pensando]");
		assert.equal(state.displayAgent, "[⏳ pensando]");

		// Tool running
		handlers.get("tool_execution_start")?.({ toolCallId: "call_1", toolName: "read" }, {});
		state = tracker.getDesiredState();
		assert.equal(state.message, "[read]");
		assert.equal(state.displayAgent, "[⏳ read]");

		// Success
		handlers.get("agent_settled")?.({}, { isIdle: () => true });
		state = tracker.getDesiredState();
		assert.equal(state.state, "idle");
		assert.equal(state.message, "[success]");
		assert.equal(state.displayAgent, "[✅ success]");
	});
});
