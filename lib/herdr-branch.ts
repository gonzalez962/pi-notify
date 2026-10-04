import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 1_000;

/** Resolve the checked-out branch without blocking the event loop. Unavailable refs (including detached HEAD) are omitted. */
export function resolveHerdrBranch(cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
		}, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			const branch = stdout.trim();
			resolve(branch || undefined);
		});
	});
}
