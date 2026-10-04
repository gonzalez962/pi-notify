import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveHerdrBranch } from "../lib/herdr-branch.ts";

function createGitFixture(): string {
	const cwd = mkdtempSync(path.join(tmpdir(), "herdr-branch-test-"));
	execFileSync("git", ["init", "--quiet", "-b", "fixture-branch"], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd });
	return cwd;
}

describe("resolveHerdrBranch", () => {
	it("returns the attached branch from an isolated Git fixture", async () => {
		const cwd = createGitFixture();
		assert.equal(await resolveHerdrBranch(cwd), "fixture-branch");
	});

	it("returns undefined for detached HEAD", async () => {
		const cwd = createGitFixture();
		execFileSync("git", ["checkout", "--quiet", "--detach"], { cwd });
		assert.equal(await resolveHerdrBranch(cwd), undefined);
	});

	it("returns undefined for a non-Git directory", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "herdr-non-git-test-"));
		assert.equal(await resolveHerdrBranch(cwd), undefined);
	});
});
