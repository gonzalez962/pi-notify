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
		assert.equal(finalState.message, undefined);
		assert.equal(finalState.displayAgent, "pi [✅ listo]");
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
});
