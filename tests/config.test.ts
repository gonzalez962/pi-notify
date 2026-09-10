import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	DEFAULT_CONFIG,
	configPath,
	loadConfig,
	normalizeChatIds,
	normalizeConfig,
	normalizeEvents,
	redactToken,
	resolveBotToken,
	saveConfig,
	validateForSend,
} from "../lib/config.ts";
import { SUPPORTED_EVENTS } from "../lib/events.ts";

const roots: string[] = [];

function tempEnv(): NodeJS.ProcessEnv {
	const root = mkdtempSync(join(tmpdir(), "pi-notify-"));
	roots.push(root);
	return { PI_NOTIFY_CONFIG_HOME: root } as NodeJS.ProcessEnv;
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("normalizeChatIds", () => {
	it("keeps numeric, negative and @username ids", () => {
		assert.deepEqual(normalizeChatIds(["123", "-1001234567890", "@my_channel"]), [
			"123",
			"-1001234567890",
			"@my_channel",
		]);
	});

	it("accepts numbers and drops duplicates and junk", () => {
		assert.deepEqual(normalizeChatIds([123, "123", "", "  ", "not an id", null, "@ab"]), ["123"]);
	});

	it("returns an empty list for non-arrays", () => {
		assert.deepEqual(normalizeChatIds("123"), []);
	});
});

describe("normalizeEvents", () => {
	it("drops unknown hooks", () => {
		assert.deepEqual(normalizeEvents(["agent_settled", "not_a_hook", "agent_settled"]), ["agent_settled"]);
	});

	it("expands the wildcard to every supported hook", () => {
		assert.deepEqual(normalizeEvents(["*"]), [...SUPPORTED_EVENTS]);
	});

	it("never returns a decision hook", () => {
		assert.deepEqual(normalizeEvents(["project_trust", "session_before_compact", "context", "tool_call"]), []);
	});

	it("silently discards agent_end so old configs fall back to defaults", () => {
		// agent_end is no longer subscribable; configs that still name it must
		// not produce notifications from it. The list collapses to empty and
		// the caller falls back to DEFAULT_CONFIG.events.
		assert.deepEqual(normalizeEvents(["agent_end"]), []);
	});

	it("never expands the wildcard to agent_end", () => {
		const all = normalizeEvents(["*"]);
		assert.equal(all.includes("agent_end"), false);
	});
});

describe("normalizeConfig", () => {
	it("falls back to defaults for garbage input", () => {
		assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
		assert.deepEqual(normalizeConfig("nope"), DEFAULT_CONFIG);
		assert.deepEqual(normalizeConfig([]), DEFAULT_CONFIG);
	});

	it("clamps timeouts into a sane range", () => {
		assert.equal(normalizeConfig({ timeoutMs: 5 }).timeoutMs, 1_000);
		assert.equal(normalizeConfig({ timeoutMs: 10_000_000 }).timeoutMs, 120_000);
		assert.equal(normalizeConfig({ timeoutMs: "fast" }).timeoutMs, DEFAULT_CONFIG.timeoutMs);
	});

	it("rejects unknown parse modes", () => {
		assert.equal(normalizeConfig({ parseMode: "Markdown" }).parseMode, "HTML");
		assert.equal(normalizeConfig({ parseMode: "MarkdownV2" }).parseMode, "MarkdownV2");
	});

	it("restores the default hook set when every hook was invalid", () => {
		assert.deepEqual(normalizeConfig({ events: ["bogus"] }).events, DEFAULT_CONFIG.events);
	});

	it("restores the default hook set when only agent_end is listed (silent discard)", () => {
		// Existing user configs that still name agent_end must not regress to
		// producing notifications from agent_end. The hook list collapses and
		// the defaults take over.
		assert.deepEqual(normalizeConfig({ events: ["agent_end"] }).events, DEFAULT_CONFIG.events);
	});
});

describe("workspaceName", () => {
	it("defaults to an empty string in DEFAULT_CONFIG", () => {
		assert.equal(DEFAULT_CONFIG.workspaceName, "");
	});

	it("keeps a valid workspaceName and trims surrounding whitespace", () => {
		assert.equal(normalizeConfig({ workspaceName: "team-alpha" }).workspaceName, "team-alpha");
		assert.equal(normalizeConfig({ workspaceName: "  team-alpha  " }).workspaceName, "team-alpha");
	});

	it("collapses a whitespace-only value to empty (disabled)", () => {
		assert.equal(normalizeConfig({ workspaceName: "   " }).workspaceName, "");
		assert.equal(normalizeConfig({ workspaceName: "" }).workspaceName, "");
	});

	it("falls back to empty for non-string values", () => {
		assert.equal(normalizeConfig({ workspaceName: 42 }).workspaceName, "");
		assert.equal(normalizeConfig({ workspaceName: null }).workspaceName, "");
		assert.equal(normalizeConfig({ workspaceName: true }).workspaceName, "");
	});

	it("round-trips through save and load", () => {
		const env = tempEnv();
		saveConfig({ ...DEFAULT_CONFIG, workspaceName: "team-alpha" }, env);
		assert.equal(loadConfig(env).workspaceName, "team-alpha");

		saveConfig({ ...DEFAULT_CONFIG, workspaceName: "" }, env);
		assert.equal(loadConfig(env).workspaceName, "");
	});

	it("preserves a workspaceName that contains spaces and punctuation", () => {
		const env = tempEnv();
		const value = "R&D — team/alpha";
		saveConfig({ ...DEFAULT_CONFIG, workspaceName: value }, env);
		assert.equal(loadConfig(env).workspaceName, value);
	});

	it("backfills workspaceName when an older config on disk has none", () => {
		const env = tempEnv();
		// Simulate a config file written before workspaceName existed. The object
		// must truly lack the `workspaceName` property — spreading DEFAULT_CONFIG
		// is not enough because the default now contains the key.
		const oldShape = { ...DEFAULT_CONFIG };
		delete oldShape.workspaceName;
		assert.equal(
			Object.prototype.hasOwnProperty.call(oldShape, "workspaceName"),
			false,
			"the simulated legacy config must not carry workspaceName",
		);
		writeFileSync(
			configPath(env),
			JSON.stringify({ ...oldShape, botToken: "x", chatIds: ["1"] }),
			"utf8",
		);
		const loaded = loadConfig(env);
		assert.equal(loaded.workspaceName, "");
		assert.equal(loaded.botToken, "x");
		assert.deepEqual(loaded.chatIds, ["1"]);
	});

	it("truncates persisted workspaceName over 100 code units to exactly 100", () => {
		const env = tempEnv();
		const overlong = "a".repeat(150);
		writeFileSync(
			configPath(env),
			JSON.stringify({ ...DEFAULT_CONFIG, workspaceName: overlong }),
			"utf8",
		);
		const loaded = loadConfig(env);
		assert.equal(loaded.workspaceName.length, 100);
		assert.equal(loaded.workspaceName, "a".repeat(100));
	});

	it("trims whitespace on persisted workspaceName before applying the 100-unit cap", () => {
		const env = tempEnv();
		// 4 leading + 100 letters + 4 trailing + 30 more letters → trims to the
		// 100-letter core (the trailing extras are dropped by the cap, not the trim).
		const padded = `    ${"a".repeat(130)}    `;
		writeFileSync(
			configPath(env),
			JSON.stringify({ ...DEFAULT_CONFIG, workspaceName: padded }),
			"utf8",
		);
		const loaded = loadConfig(env);
		assert.equal(loaded.workspaceName.length, 100);
		assert.equal(loaded.workspaceName, "a".repeat(100));
	});
});

describe("mainAgentOnly", () => {
	it("defaults to true so subagent json processes stay quiet", () => {
		assert.equal(DEFAULT_CONFIG.mainAgentOnly, true);
		assert.equal(normalizeConfig({}).mainAgentOnly, true);
	});

	it("preserves false when explicitly configured", () => {
		assert.equal(normalizeConfig({ mainAgentOnly: false }).mainAgentOnly, false);
	});

	it("falls back to true on non-boolean values", () => {
		assert.equal(normalizeConfig({ mainAgentOnly: "yes" }).mainAgentOnly, true);
		assert.equal(normalizeConfig({ mainAgentOnly: 1 }).mainAgentOnly, true);
	});

	it("round-trips through save and load", () => {
		const env = tempEnv();
		saveConfig({ ...DEFAULT_CONFIG, mainAgentOnly: false }, env);
		assert.equal(loadConfig(env).mainAgentOnly, false);

		saveConfig({ ...DEFAULT_CONFIG, mainAgentOnly: true }, env);
		assert.equal(loadConfig(env).mainAgentOnly, true);
	});
});

describe("loadConfig / saveConfig", () => {
	it("returns defaults when no config file exists", () => {
		assert.deepEqual(loadConfig(tempEnv()), DEFAULT_CONFIG);
	});

	it("round-trips a saved config", () => {
		const env = tempEnv();
		saveConfig({ ...DEFAULT_CONFIG, chatIds: ["42"], events: ["ui_prompt_start"] }, env);
		const loaded = loadConfig(env);
		assert.deepEqual(loaded.chatIds, ["42"]);
		assert.deepEqual(loaded.events, ["ui_prompt_start"]);
		assert.match(readFileSync(configPath(env), "utf8"), /"chatIds"/);
	});

	it("survives a corrupt config file", () => {
		const env = tempEnv();
		saveConfig(DEFAULT_CONFIG, env);
		writeFileSync(configPath(env), "{ not json", "utf8");
		assert.deepEqual(loadConfig(env), DEFAULT_CONFIG);
	});
});

describe("resolveBotToken", () => {
	it("prefers the dedicated environment variable", () => {
		const config = { ...DEFAULT_CONFIG, botToken: "stored" };
		assert.equal(resolveBotToken(config, { PI_NOTIFY_TELEGRAM_BOT_TOKEN: "from-env" } as NodeJS.ProcessEnv), "from-env");
	});

	it("falls back to TELEGRAM_BOT_TOKEN then to the stored token", () => {
		const config = { ...DEFAULT_CONFIG, botToken: "stored" };
		assert.equal(resolveBotToken(config, { TELEGRAM_BOT_TOKEN: "generic" } as NodeJS.ProcessEnv), "generic");
		assert.equal(resolveBotToken(config, {} as NodeJS.ProcessEnv), "stored");
	});
});

describe("redactToken", () => {
	it("keeps only the bot id", () => {
		assert.equal(redactToken("123456:AAHsecretvalue"), "123456:******");
		assert.equal(redactToken(""), "(not set)");
	});
});

describe("validateForSend", () => {
	it("reports every missing precondition", () => {
		const problems = validateForSend({ ...DEFAULT_CONFIG, enabled: false, events: [] }, "");
		assert.deepEqual(problems.map((problem) => problem.field), ["enabled", "botToken", "chatIds", "events"]);
	});

	it("is silent for a complete config", () => {
		const config = { ...DEFAULT_CONFIG, chatIds: ["1"] };
		assert.deepEqual(validateForSend(config, "123:abc"), []);
	});
});
