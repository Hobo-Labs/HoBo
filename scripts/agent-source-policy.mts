import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = spawnSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
});

if (repository.status !== 0 || !repository.stdout.trim()) {
	process.stderr.write("Source policy could not locate the repository.\n");
	process.exitCode = 2;
} else {
	const root = repository.stdout.trim();
	const guard = fileURLToPath(
		new URL("./check-source-policy.mts", import.meta.url),
	);
	const git = (args: string[]) =>
		spawnSync("git", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	const headResult = git(["rev-parse", "--verify", "HEAD^{commit}"]);
	const head = headResult.status === 0 ? headResult.stdout.trim() : undefined;
	const branchResult = git(["symbolic-ref", "--quiet", "HEAD"]);
	const branch =
		branchResult.status === 0 ? branchResult.stdout.trim() : "detached";
	const stateDirectory =
		process.env.HOBO_AGENT_POLICY_STATE_DIR ??
		join(tmpdir(), "hobo-agent-source-policy");
	const stateFile = join(
		stateDirectory,
		`${createHash("sha256").update(root).update("\0").update(branch).digest("hex")}.txt`,
	);
	let previousHead: string | undefined;
	let pending = false;
	let stateAvailable = true;
	try {
		mkdirSync(stateDirectory, { recursive: true });
		if (existsSync(stateFile)) {
			const [storedHead, status, lastChecked] = readFileSync(stateFile, "utf8")
				.trim()
				.split("\n");
			if (
				!storedHead ||
				!/^[a-f0-9]{40,64}$/u.test(storedHead) ||
				(status !== "clean" && status !== "pending") ||
				!lastChecked ||
				!/^\d+$/u.test(lastChecked)
			) {
				throw new Error("invalid checkpoint");
			}
			pending = status === "pending";
			if (pending || Date.now() - Number(lastChecked) <= 12 * 60 * 60 * 1000) {
				previousHead = storedHead;
			}
		}
	} catch (error) {
		process.stderr.write(
			`Source policy could not read its checkpoint: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 2;
		stateAvailable = false;
	}

	const bases = new Set<string>();
	const requestedBase = process.argv
		.slice(2)
		.find((arg) => arg.startsWith("--base="));
	if (requestedBase) bases.add(requestedBase);
	let checkpointBase: string | undefined;
	if (stateAvailable && head && previousHead !== head) {
		const commonAncestor = previousHead
			? git(["merge-base", previousHead, head])
			: undefined;
		if (commonAncestor?.status === 0) {
			checkpointBase = commonAncestor.stdout.trim();
		} else {
			const parent = git(["rev-parse", "--verify", "HEAD^1^{commit}"]);
			if (parent.status === 0) checkpointBase = parent.stdout.trim();
		}
		if (checkpointBase) bases.add(`--base=${checkpointBase}`);
	}

	let committedChangesClean = stateAvailable;
	for (const mode of ["--worktree", ...bases]) {
		const result = spawnSync(
			process.execPath,
			["--import", import.meta.resolve("tsx"), guard, mode],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
				maxBuffer: 4 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 45_000,
			},
		);
		if (result.status !== 0) {
			process.stderr.write(
				"Source policy requires self-documenting code and completed work.\n",
			);
			process.stderr.write(
				result.stderr ||
					result.error?.message ||
					`Guard exited ${result.status}.\n`,
			);
			process.exitCode = 2;
			if (mode !== "--worktree") committedChangesClean = false;
		}
	}
	const checkpoint = committedChangesClean ? head : checkpointBase;
	if (stateAvailable && checkpoint) {
		const temporaryStateFile = `${stateFile}.${process.pid}`;
		try {
			writeFileSync(
				temporaryStateFile,
				`${checkpoint}\n${committedChangesClean ? "clean" : "pending"}\n${Date.now()}\n`,
				"utf8",
			);
			renameSync(temporaryStateFile, stateFile);
		} catch (error) {
			rmSync(temporaryStateFile, { force: true });
			process.stderr.write(
				`Source policy could not write its checkpoint: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 2;
		}
	}
}
