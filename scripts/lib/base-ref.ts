import { spawnSync } from "node:child_process";

function git(args: string[]): string | undefined {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

export function isCommit(ref: string): boolean {
	return (
		git([
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${ref}^{commit}`,
		]) !== undefined
	);
}

export function reachRemedy(ref: string): string {
	const shallow = git(["rev-parse", "--is-shallow-repository"]) === "true";
	return shallow && /^HEAD[~^]/u.test(ref)
		? "This clone is shallow: deepen it (git fetch --deepen=1, or git fetch --unshallow) or pass --base=<ref>."
		: "Fetch it (git fetch origin main) or pass --base=<ref>.";
}
