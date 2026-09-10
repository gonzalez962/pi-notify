import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HELP_TEXT, applySetting, parseCommand } from "../lib/command.ts";
import { ATTENTION_EVENTS, SUPPORTED_EVENTS } from "../lib/events.ts";

describe("parseCommand", () => {
	it("defaults to status", () => {
		assert.deepEqual(parseCommand(""), { kind: "status" });
		assert.deepEqual(parseCommand("   "), { kind: "status" });
	});

	it("maps on/off aliases", () => {
		assert.deepEqual(parseCommand("on"), { kind: "enable" });
		assert.deepEqual(parseCommand("enable"), { kind: "enable" });
		assert.deepEqual(parseCommand("off"), { kind: "disable" });
	});

	it("reads the token verbatim", () => {
		assert.deepEqual(parseCommand("token 123:AA-Bb_cc"), { kind: "token", value: "123:AA-Bb_cc" });
		assert.equal(parseCommand("token").kind, "error");
	});

	it("parses chat add/remove with several ids", () => {
		assert.deepEqual(parseCommand("chat add 1 -100 @news"), { kind: "add-chat", values: ["1", "-100", "@news"] });
		assert.deepEqual(parseCommand("chat remove 1"), { kind: "remove-chat", values: ["1"] });
		assert.equal(parseCommand("chat").kind, "error");
		assert.equal(parseCommand("chat drop 1").kind, "error");
	});

	it("validates hook names and expands 'all'", () => {
		assert.deepEqual(parseCommand("events agent_settled session_start"), {
			kind: "events",
			values: ["agent_settled", "session_start"],
		});
		assert.deepEqual(parseCommand("events all"), { kind: "events", values: [...SUPPORTED_EVENTS] });
		assert.deepEqual(parseCommand("events attention"), { kind: "events", values: [...ATTENTION_EVENTS] });
		assert.deepEqual(parseCommand("events"), { kind: "list-events" });
		assert.deepEqual(parseCommand("events list"), { kind: "list-events" });
		// agent_end is no longer subscribable, so a config that still names it
		// must come back as an error and never produce a notification.
		const bad = parseCommand("events agent_end nope");
		assert.equal(bad.kind, "error");
		assert.match(bad.kind === "error" ? bad.message : "", /agent_end/);
	});

	it("parses set mainAgentOnly true|false", () => {
		assert.deepEqual(parseCommand("set mainAgentOnly true"), {
			kind: "set",
			key: "mainAgentOnly",
			value: "true",
		});
		assert.deepEqual(parseCommand("set mainAgentOnly false"), {
			kind: "set",
			key: "mainAgentOnly",
			value: "false",
		});
	});

	it("rejects unknown settings and subcommands", () => {
		assert.equal(parseCommand("set nope 1").kind, "error");
		assert.equal(parseCommand("set silent").kind, "error");
		assert.equal(parseCommand("frobnicate").kind, "error");
		assert.deepEqual(parseCommand("set silent true"), { kind: "set", key: "silent", value: "true" });
	});

	it("carries an optional test message", () => {
		assert.deepEqual(parseCommand("test"), { kind: "test", message: undefined });
		assert.deepEqual(parseCommand("test hello there"), { kind: "test", message: "hello there" });
	});

	it("parses set workspaceName, supporting multi-word values and normalizing whitespace", () => {
		assert.deepEqual(parseCommand("set workspaceName My Cool Workspace"), {
			kind: "set",
			key: "workspaceName",
			value: "My Cool Workspace",
		});
		assert.deepEqual(parseCommand("set workspaceName   trim me   "), {
			kind: "set",
			key: "workspaceName",
			value: "trim me",
		});
		// Consecutive whitespace collapses to a single space — the parser splits
		// on /\s+/ and joins with a single space, so users do not get to claim
		// exact spacing.
		assert.deepEqual(parseCommand("set workspaceName My   Cool\tWorkspace"), {
			kind: "set",
			key: "workspaceName",
			value: "My Cool Workspace",
		});
	});

	it("accepts 'none' as an explicit clear token for workspaceName", () => {
		assert.deepEqual(parseCommand("set workspaceName none"), {
			kind: "set",
			key: "workspaceName",
			value: "none",
		});
	});

	it("rejects an empty workspaceName value", () => {
		assert.equal(parseCommand("set workspaceName").kind, "error");
		assert.equal(parseCommand("set workspaceName   ").kind, "error");
	});

	it("mentions workspaceName in the help text", () => {
		assert.match(HELP_TEXT, /workspaceName/);
		assert.match(HELP_TEXT, /set <key> <value>/);
	});
});

describe("applySetting", () => {
	it("normalizes the parse mode case-insensitively", () => {
		assert.deepEqual(applySetting("parseMode", "html").patch, { parseMode: "HTML" });
		assert.equal(applySetting("parseMode", "Markdown").ok, false);
	});

	it("accepts booleans only as true/false", () => {
		assert.deepEqual(applySetting("silent", "TRUE").patch, { silent: true });
		assert.equal(applySetting("includeProject", "1").ok, false);
	});

	it("accepts non-negative integers for the numeric settings", () => {
		assert.deepEqual(applySetting("throttleMs", "5000").patch, { throttleMs: 5_000 });
		assert.equal(applySetting("timeoutMs", "-1").ok, false);
		assert.equal(applySetting("timeoutMs", "abc").ok, false);
	});

	it("accepts true/false for mainAgentOnly (case-insensitive)", () => {
		assert.deepEqual(applySetting("mainAgentOnly", "TRUE").patch, { mainAgentOnly: true });
		assert.deepEqual(applySetting("mainAgentOnly", "False").patch, { mainAgentOnly: false });
		assert.equal(applySetting("mainAgentOnly", "yes").ok, false);
	});

	it("sets workspaceName verbatim and treats 'none' (case-insensitive) as an explicit clear", () => {
		assert.deepEqual(applySetting("workspaceName", "My Cool Workspace").patch, {
			workspaceName: "My Cool Workspace",
		});
		assert.deepEqual(applySetting("workspaceName", "none").patch, { workspaceName: "" });
		assert.deepEqual(applySetting("workspaceName", "None").patch, { workspaceName: "" });
		assert.deepEqual(applySetting("workspaceName", "NONE").patch, { workspaceName: "" });
	});

	it("rejects an empty workspaceName value", () => {
		assert.equal(applySetting("workspaceName", "").ok, false);
		assert.equal(applySetting("workspaceName", "   ").ok, false);
	});

	it("accepts workspaceName up to 100 Unicode code units (boundary inclusive)", () => {
		const at100 = "a".repeat(100);
		const result = applySetting("workspaceName", at100);
		assert.equal(result.ok, true);
		assert.deepEqual(result.patch, { workspaceName: at100 });
	});

	it("rejects workspaceName over 100 Unicode code units with a clear error", () => {
		const at101 = "a".repeat(101);
		const result = applySetting("workspaceName", at101);
		assert.equal(result.ok, false);
		assert.match(result.message, /100/);
		// The clear token is still accepted regardless of cap reasoning.
		const clear = applySetting("workspaceName", "none");
		assert.equal(clear.ok, true);
	});
});
