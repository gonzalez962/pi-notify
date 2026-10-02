import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resetBellState, ringBell } from "../lib/bell.ts";

describe("bell", () => {
	it("skips ringing when not a TTY", () => {
		resetBellState();
		let written = "";
		const ok = ringBell(1000, (s) => {
			written += s;
		}, false);
		assert.equal(ok, false);
		assert.equal(written, "");
	});

	it("rings bell when TTY is true", () => {
		resetBellState();
		let written = "";
		const ok = ringBell(1000, (s) => {
			written += s;
		}, true);
		assert.equal(ok, true);
		assert.equal(written, "\x07");
	});

	it("debounces bell within 500ms window", () => {
		resetBellState();
		let writtenCount = 0;
		const writer = () => {
			writtenCount += 1;
		};

		const ok1 = ringBell(1000, writer, true);
		assert.equal(ok1, true);

		// Inside debounce window
		const ok2 = ringBell(1200, writer, true);
		assert.equal(ok2, false);
		assert.equal(writtenCount, 1);

		// Outside debounce window
		const ok3 = ringBell(1600, writer, true);
		assert.equal(ok3, true);
		assert.equal(writtenCount, 2);
	});
});
