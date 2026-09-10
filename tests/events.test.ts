import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ATTENTION_EVENTS,
	SUPPORTED_EVENTS,
	describeEvent,
	eventDescription,
	eventTitle,
	isSupportedEvent,
	lastAssistantText,
	messageText,
	truncate,
} from "../lib/events.ts";

describe("supported events", () => {
	it("excludes hooks whose handler must return a decision", () => {
		for (const name of ["project_trust", "session_before_switch", "session_before_compact", "context"]) {
			assert.equal(isSupportedEvent(name), false, `${name} must not be notifiable`);
		}
	});

	it("excludes the high-frequency hooks that fire during a normal run", () => {
		for (const name of [
			"turn_start",
			"turn_end",
			"message_end",
			"tool_call",
			"tool_result",
			"tool_execution_start",
			"tool_execution_end",
			"input",
			"before_agent_start",
			"agent_start",
			"model_select",
			"after_provider_response",
		]) {
			assert.equal(isSupportedEvent(name), false, `${name} is too noisy to notify`);
		}
	});

	it("keeps the attention hooks inside the supported set", () => {
		for (const name of ATTENTION_EVENTS) {
			assert.equal(isSupportedEvent(name), true, `${name} must be notifiable`);
		}
		assert.deepEqual(ATTENTION_EVENTS, ["agent_settled", "ui_prompt_start"]);
	});

	it("removes agent_end from the public supported/subscribable set", () => {
		// agent_end fires once per low-level run (so retries and compactions
		// duplicate the notification). agent_settled is the single
		// user-notifiable completion hook and carries the cached last answer.
		assert.equal(isSupportedEvent("agent_end"), false);
		assert.equal((SUPPORTED_EVENTS as readonly string[]).includes("agent_end"), false);
	});

	it("gives every supported hook a human title and description", () => {
		for (const name of SUPPORTED_EVENTS) {
			assert.notEqual(eventTitle(name), name, `${name} has no title`);
			assert.notEqual(eventDescription(name), "", `${name} has no description`);
		}
	});
});

describe("truncate", () => {
	it("adds an ellipsis only when it cuts", () => {
		assert.equal(truncate("hello", 10), "hello");
		assert.equal(truncate("hello", 3), "he…");
		assert.equal(truncate("hello", 0), "");
	});
});

describe("messageText", () => {
	it("joins text blocks and collapses whitespace", () => {
		const message = { content: [{ type: "text", text: "a\n\n  b" }, { type: "image" }] };
		assert.equal(messageText(message), "a b");
	});

	it("returns an empty string for unusable input", () => {
		assert.equal(messageText(null), "");
		assert.equal(messageText({ content: 42 }), "");
	});
});

describe("lastAssistantText", () => {
	it("picks the last non-empty assistant message", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: [{ type: "text", text: "question" }] },
			{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		];
		assert.equal(lastAssistantText(messages), "final answer");
	});

	it("skips assistant messages that carry no text", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "kept" }] },
			{ role: "assistant", content: [{ type: "toolCall" }] },
		];
		assert.equal(lastAssistantText(messages), "kept");
	});

	it("handles a missing message list", () => {
		assert.equal(lastAssistantText(undefined), "");
	});
});

describe("describeEvent", () => {
	it("does not treat agent_end as a notifiable hook in the formatter", () => {
		// agent_end is intentionally NOT a public subscribable hook anymore.
		// The formatter must not pretend it produces a notification: the title
		// falls back to the raw hook name and the body stays empty.
		const payload = describeEvent("agent_end", {
			messages: [{ role: "assistant", content: [{ type: "text", text: "ignored" }] }],
		});
		assert.equal(payload.title, "agent_end");
		assert.equal(payload.body, undefined);
	});

	it("uses the answer attached to agent_settled", () => {
		const payload = describeEvent("agent_settled", { answer: "tests are green" });
		assert.equal(payload.title, "Task finished");
		assert.equal(payload.body, "tests are green");
	});

	it("reports the question Pi is blocked on", () => {
		const payload = describeEvent("ui_prompt_start", { kind: "confirm", title: "Allow guarded command?" });
		assert.equal(payload.title, "Waiting for your answer");
		assert.deepEqual(payload.fields, [
			["Kind", "confirm"],
			["Question", "Allow guarded command?"],
		]);
	});

	it("reports compaction failures", () => {
		const payload = describeEvent("session_compact_failed", {
			reason: "overflow",
			aborted: false,
			errorMessage: "provider rejected the request",
		});
		assert.deepEqual(payload.fields, [
			["Reason", "overflow"],
			["Aborted", "no"],
			["Error", "provider rejected the request"],
		]);
	});

	it("never throws on an unknown or empty payload", () => {
		assert.equal(describeEvent("agent_settled", undefined).title, "Task finished");
		assert.equal(describeEvent("not_a_hook", {}).title, "not_a_hook");
	});
});
