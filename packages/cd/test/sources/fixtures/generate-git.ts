// Records the Git smart-HTTP v2 fixtures in git.json from a real `git
// upload-pack`, so the driver is tested against bytes a real server produced.
// Re-run after changing the request builders:
//   node --import tsx packages/cd/test/sources/fixtures/generate-git.ts
// Dates and identities are fixed, so the output is reproducible.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fetchRequest,
	lsRefsRequest,
} from "../../../src/sources/drivers/git.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "hobo-cd-git-fixture-"));
const BASE = "https://git.example.com/acme/web.git";

let tick = 0;
function git(args: readonly string[], input?: string | Buffer): Buffer {
	tick += 1;
	const stamp = `${1_798_000_000 + tick * 3600} +0000`;
	return execFileSync("git", [...args], {
		cwd: repo,
		input,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.com",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.com",
			GIT_AUTHOR_DATE: stamp,
			GIT_COMMITTER_DATE: stamp,
			GIT_PROTOCOL: "version=2",
			GIT_CONFIG_NOSYSTEM: "1",
			HOME: repo,
		},
	});
}

function write(path: string, content: string): void {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), content);
}

function commit(message: string): string {
	git(["add", "-A"]);
	git(["commit", "-q", "-m", message]);
	return git(["rev-parse", "HEAD"]).toString().trim();
}

git(["init", "-q", "--initial-branch=main", "."]);
git(["config", "uploadpack.allowFilter", "true"]);
git(["config", "protocol.version", "2"]);

const infoRefs = Buffer.concat([
	Buffer.from("001e# service=git-upload-pack\n0000"),
	git(["upload-pack", "--http-backend-info-refs", "."]),
]);

type Recorded = {
	method: string;
	url: string;
	body?: string;
	response: string;
};
const sets: Record<string, Recorded[]> = {};
const commits: Record<string, string> = {};

function record(
	name: string,
	extraFetches: ReadonlyArray<readonly [readonly string[], string]>,
): void {
	const exchanges: Recorded[] = [
		{
			method: "GET",
			url: `${BASE}/info/refs?service=git-upload-pack`,
			response: infoRefs.toString("base64"),
		},
	];
	for (const prefix of ["refs/heads/main", "refs/tags/"]) {
		const body = lsRefsRequest(prefix, "sha1");
		exchanges.push({
			method: "POST",
			url: `${BASE}/git-upload-pack`,
			body,
			response: git(["upload-pack", "--stateless-rpc", "."], body).toString(
				"base64",
			),
		});
	}
	for (const [wants, filter] of extraFetches) {
		const body = fetchRequest(wants, filter, "sha1");
		exchanges.push({
			method: "POST",
			url: `${BASE}/git-upload-pack`,
			body,
			response: git(["upload-pack", "--stateless-rpc", "."], body).toString(
				"base64",
			),
		});
	}
	sets[name] = exchanges;
}

// t1: one commit, deploy + src; tagged v1.0.0 (lightweight).
write("deploy/app.cue", "replicas: 1\n");
write("src/a.txt", "one\n");
commits.c1 = commit("c1");
git(["tag", "v1.0.0"]);
record("t1", [
	[[commits.c1], "tree:0"],
	[[commits.c1], "blob:none"],
]);

// t2: change only src/; tagged v1.1.0 (annotated, so ls-refs peels it).
write("src/a.txt", "two\n");
commits.c2 = commit("c2");
git(["tag", "-a", "v1.1.0", "-m", "v1.1.0"]);
record("t2", [
	[[commits.c2], "tree:0"],
	[[commits.c2], "blob:none"],
]);

// t3: change deploy/; tagged v1.2.0.
write("deploy/app.cue", "replicas: 2\n");
commits.c3 = commit("c3");
git(["tag", "v1.2.0"]);
record("t3", [
	[[commits.c3], "tree:0"],
	[[commits.c3], "blob:none"],
	[[commits.c1, commits.c2, commits.c3], "tree:0"],
	[[commits.c1, commits.c2, commits.c3], "blob:none"],
]);

writeFileSync(
	join(here, "git.json"),
	`${JSON.stringify({ base: BASE, commits, sets }, null, "\t")}\n`,
);
process.stdout.write(`wrote ${join(here, "git.json")}\n`);
