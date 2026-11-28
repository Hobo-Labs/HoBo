import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type ChangedFileRecord = {
	path: string;
	status: string;
};

export type GitListingRunner = (args: readonly string[]) => string | undefined;

export function parseChangedFileRecords(raw: string): ChangedFileRecord[] {
	return raw
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => {
			const [status, firstPath, secondPath] = line.split("\t");
			return { status: status ?? "M", path: secondPath ?? firstPath ?? "" };
		})
		.filter((record): record is ChangedFileRecord => Boolean(record.path));
}

export function defaultGitRunner(cwd: string): GitListingRunner {
	return (args) => {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			shell: false,
			maxBuffer: 32 * 1024 * 1024,
		});
		if (result.error || result.status !== 0) return undefined;
		return result.stdout.trim();
	};
}

export function readMergeHeads(
	cwd: string,
	runGit: GitListingRunner = defaultGitRunner(cwd),
): readonly string[] {
	const rawPath = runGit(["rev-parse", "--git-path", "MERGE_HEAD"]);
	if (!rawPath) return [];
	const mergeHeadPath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
	let contents: string;
	try {
		contents = readFileSync(mergeHeadPath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	const commits: string[] = [];
	for (const line of contents.split(/\r?\n/u)) {
		const candidate = line.trim();
		if (!candidate) continue;
		const verified = runGit([
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${candidate}^{commit}`,
		]);
		if (verified) commits.push(verified);
	}
	return commits;
}

export function stagedChangedFileRecords(
	cwd: string,
	runGit: GitListingRunner = defaultGitRunner(cwd),
): ChangedFileRecord[] | undefined {
	const againstHeadRaw = runGit([
		"diff",
		"--cached",
		"--name-status",
		"--find-renames=100%",
		"--diff-filter=ACMR",
	]);
	if (againstHeadRaw === undefined) return undefined;
	const againstHead = parseChangedFileRecords(againstHeadRaw);
	const mergeHeads = readMergeHeads(cwd, runGit);
	if (mergeHeads.length === 0) return againstHead;

	const parentPathSets: Set<string>[] = [];
	for (const parent of mergeHeads) {
		const parentDiffRaw = runGit([
			"diff",
			"--cached",
			"--name-status",
			"--find-renames=100%",
			"--diff-filter=ACMR",
			parent,
		]);
		if (parentDiffRaw === undefined) return undefined;
		parentPathSets.push(
			new Set(
				parseChangedFileRecords(parentDiffRaw).map((record) => record.path),
			),
		);
	}
	return againstHead.filter((record) =>
		parentPathSets.every((paths) => paths.has(record.path)),
	);
}
