import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	livenessExitCode,
	mergeGroupLiveness,
	mergeGroupBase,
	mergeGroupRefUrl,
	type GitHubGet,
	type GitHubResponse,
	STALE_EXIT_CODE,
} from "../../.github/actions/ci-runner-preflight/merge-group-live.mts";

const run = promisify(execFile);
const bash = execFileSync("bash", ["-c", "command -v bash"], {
	encoding: "utf8",
}).trim();
const wrapper = join(
	import.meta.dirname,
	"..",
	"..",
	".github/actions/ci-runner-preflight/merge-group-live.sh",
);
const sha = "fb9b55383250e5739b4edc56c87f2b5bd9a7c03c";
const ref =
	"refs/heads/gh-readonly-queue/main/pr-2598-3474ceb3c8de5f01e3f2462c194a6aa90d207973";
const env = {
	GITHUB_EVENT_NAME: "merge_group",
	GITHUB_REF: ref,
	GITHUB_SHA: sha,
	GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
	GITHUB_API_URL: "https://api.github.com",
	GITHUB_TOKEN: "token",
};
const answer =
	(status: number, body = ""): GitHubGet =>
	async () => ({ status, body });
const gone =
	(compare: GitHubResponse): GitHubGet =>
	async (url) =>
		url.includes("/compare/") ? compare : { status: 404, body: "{}" };
const refBody = (objectSha: string) =>
	JSON.stringify({ ref, object: { sha: objectSha, type: "commit" } });

describe("merge-group liveness", () => {
	it("asks the REST ref endpoint for the queue ref", () => {
		expect(
			mergeGroupRefUrl("https://api.github.com/", "Hobo-Labs/HoBo", ref),
		).toBe(
			"https://api.github.com/repos/Hobo-Labs/HoBo/git/ref/heads/gh-readonly-queue/main/pr-2598-3474ceb3c8de5f01e3f2462c194a6aa90d207973",
		);
	});

	it("skips every event but merge_group", async () => {
		const lookup: GitHubGet = async () => {
			throw new Error("looked up");
		};
		expect(
			await mergeGroupLiveness(
				{ ...env, GITHUB_EVENT_NAME: "pull_request" },
				lookup,
			),
		).toEqual({ kind: "not-merge-group" });
	});

	it("keeps a group whose ref still points at the run's SHA", async () => {
		const liveness = await mergeGroupLiveness(env, answer(200, refBody(sha)));
		expect(liveness).toEqual({ kind: "live", ref });
		expect(livenessExitCode(liveness)).toBe(0);
	});

	it("reads the base branch from the queue ref", () => {
		expect(mergeGroupBase(ref)).toBe("main");
		expect(mergeGroupBase("refs/heads/feature")).toBeUndefined();
	});

	it("stops a group whose ref is gone and whose SHA is not on the base", async () => {
		const urls: string[] = [];
		const liveness = await mergeGroupLiveness(env, async (url, token) => {
			urls.push(url);
			return gone({ status: 200, body: JSON.stringify({ status: "ahead" }) })(
				url,
				token,
			);
		});
		expect(liveness).toEqual({ kind: "left-queue", ref });
		expect(livenessExitCode(liveness)).toBe(STALE_EXIT_CODE);
		expect(urls.at(-1)).toBe(
			`https://api.github.com/repos/Hobo-Labs/HoBo/compare/main...${sha}`,
		);
		expect(
			await mergeGroupLiveness(
				env,
				gone({ status: 200, body: JSON.stringify({ status: "diverged" }) }),
			),
		).toEqual({ kind: "left-queue", ref });
	});

	it("finishes a group that landed on its base", async () => {
		for (const status of ["identical", "behind"]) {
			const liveness = await mergeGroupLiveness(
				env,
				gone({ status: 200, body: JSON.stringify({ status }) }),
			);
			expect(liveness).toEqual({ kind: "landed", ref, base: "main" });
			expect(livenessExitCode(liveness)).toBe(0);
		}
	});

	it("stops a group whose ref now names another SHA", async () => {
		const other = "69c502d97f23fa3a5d17f9230f0d56803a51c7a2";
		const liveness = await mergeGroupLiveness(env, answer(200, refBody(other)));
		expect(liveness).toEqual({ kind: "superseded", ref, queueSha: other });
		expect(livenessExitCode(liveness)).toBe(STALE_EXIT_CODE);
	});

	it("keeps the job running when the lookup cannot decide", async () => {
		for (const lookup of [
			answer(500),
			answer(403),
			answer(200, "not json"),
			gone({ status: 500, body: "" }),
			gone({ status: 200, body: "{}" }),
			(async () => {
				throw new Error("offline");
			}) satisfies GitHubGet,
		]) {
			const liveness = await mergeGroupLiveness(env, lookup);
			expect(liveness.kind).toBe("unknown");
			expect(livenessExitCode(liveness)).toBe(0);
		}
		const unset = await mergeGroupLiveness(
			{ ...env, GITHUB_REF: "" },
			answer(404),
		);
		expect(unset.kind).toBe("unknown");
	});
});

describe("merge-group liveness step", () => {
	let server: Server;
	let apiUrl = "";
	const statuses = new Map<string, { status: number; body: string }>();
	const seen: { url: string; authorization: string | undefined }[] = [];

	beforeAll(async () => {
		server = createServer((request, response) => {
			seen.push({
				url: request.url ?? "",
				authorization: request.headers.authorization,
			});
			const reply = statuses.get(request.url ?? "") ?? {
				status: 404,
				body: "{}",
			};
			response.writeHead(reply.status, { "content-type": "application/json" });
			response.end(reply.body);
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		// SAFETY: a server listening on a TCP host reports an AddressInfo.
		const { port } = server.address() as AddressInfo;
		apiUrl = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()));
	});

	const step = (overrides: Record<string, string>) =>
		run(bash, [wrapper], {
			env: {
				PATH: process.env.PATH,
				...env,
				GITHUB_API_URL: apiUrl,
				...overrides,
			},
		}).then(
			(result) => ({ code: 0, stdout: result.stdout }),
			(error: { code: number; stdout: string }) => ({
				code: error.code,
				stdout: error.stdout,
			}),
		);
	const path =
		"/repos/Hobo-Labs/HoBo/git/ref/heads/gh-readonly-queue/main/pr-2598-3474ceb3c8de5f01e3f2462c194a6aa90d207973";

	it("passes a queued group and sends the job token", async () => {
		statuses.set(path, { status: 200, body: refBody(sha) });
		const result = await step({});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("is still queued");
		expect(seen.at(-1)).toEqual({ url: path, authorization: "Bearer token" });
	});

	it("fails an evicted group's job", async () => {
		statuses.delete(path);
		statuses.set(`/repos/Hobo-Labs/HoBo/compare/main...${sha}`, {
			status: 200,
			body: JSON.stringify({ status: "ahead" }),
		});
		const result = await step({});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("::error::Merge group");
	});

	it("warns and continues when GitHub does not answer", async () => {
		statuses.set(path, { status: 502, body: "" });
		const result = await step({});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("::warning::Could not confirm");
	});

	it("warns and continues when the check itself cannot run", async () => {
		const emptyPath = mkdtempSync(join(tmpdir(), "merge-group-live-path-"));
		try {
			const result = await step({ PATH: emptyPath });
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(
				"::warning::The merge-group liveness check could not run",
			);
		} finally {
			rmSync(emptyPath, { recursive: true, force: true });
		}
	});
});
