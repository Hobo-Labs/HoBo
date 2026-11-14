/**
 * The pre-job hook run as GitHub's runner runs it (`sh`), against a local
 * HTTP stand-in for the sandbox's control endpoint (design §6.9 step 7):
 *
 * - The work key it posts is `<repo>#<jobId>@<runAttempt>`, the same form the
 *   work source offers, so a receipt's `observedWorkKey` joins its offer.
 * - Exit codes follow #1688's start fence: 0 allowed, 41 refused, 42 conflict
 *   (this single-use sandbox already allowed a job), 43 agent unreachable or
 *   an answer it cannot read (fail closed).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_EXIT, preJobHookScript } from "../../src/fleet-work/hook.js";

type Stand = Readonly<{
	url: string;
	posted: string[];
	close(): Promise<void>;
}>;

async function controlEndpoint(
	answer: (body: string) => Readonly<{ status: number; body: string }>,
): Promise<Stand> {
	const posted: string[] = [];
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			posted.push(body);
			const reply =
				request.method === "POST" && request.url === "/fence"
					? answer(body)
					: { status: 404, body: "" };
			response.writeHead(reply.status, { "Content-Type": "application/json" });
			response.end(reply.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		posted,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-fleet-hook-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const state = join(dir, "state");
	const event = join(dir, "event.json");
	writeFileSync(event, JSON.stringify({ ref: "refs/heads/main" }));
	return { dir, state, event };
}

function runHook(
	script: string,
	dir: string,
	env: Readonly<Record<string, string>>,
): Promise<number> {
	const path = join(dir, "pre-job.sh");
	writeFileSync(path, script, { mode: 0o555 });
	return new Promise((resolve, reject) => {
		const child = spawn("sh", [path], {
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve(code ?? -1));
	});
}

const pushJob = (event: string) => ({
	GITHUB_REPOSITORY: "acme/app",
	GITHUB_REF: "refs/heads/main",
	GITHUB_ACTOR_ID: "2",
	GITHUB_EVENT_NAME: "push",
	GITHUB_EVENT_PATH: event,
	GITHUB_RUN_ID: "100",
	GITHUB_RUN_ATTEMPT: "3",
	GITHUB_JOB: "build",
	GITHUB_JOB_ID: "9000",
});

describe("the pre-job hook", () => {
	it("posts the work key in the offer's form and exits 0 when allowed", async () => {
		const stand = await controlEndpoint(() => ({
			status: 200,
			body: '{"allow":true}',
		}));
		cleanups.push(() => stand.close());
		const { dir, state, event } = workspace();
		const code = await runHook(
			preJobHookScript(stand.url, { stateDir: state }),
			dir,
			pushJob(event),
		);
		expect(code).toBe(HOOK_EXIT.allowed);
		expect(code).toBe(0);
		expect(stand.posted.map((body) => JSON.parse(body))).toEqual([
			{
				workKey: "acme/app#9000@3",
				repository: "acme/app",
				ref: "refs/heads/main",
				author: "github:2",
				origin: "WORK_ORIGIN_INTERNAL",
			},
		]);
		expect(readFileSync(join(state, "fence"), "utf8").trim()).toBe("allow");
	});

	it("leaves the job id empty when the runner names none, so the key joins no offer", async () => {
		const stand = await controlEndpoint(() => ({
			status: 200,
			body: '{"allow":true}',
		}));
		cleanups.push(() => stand.close());
		const { dir, state, event } = workspace();
		const { GITHUB_JOB_ID: _ignored, ...env } = pushJob(event);
		await runHook(preJobHookScript(stand.url, { stateDir: state }), dir, env);
		expect(JSON.parse(stand.posted[0] ?? "{}").workKey).toBe("acme/app#@3");
	});

	it("exits 41 when the fence refuses", async () => {
		const stand = await controlEndpoint(() => ({
			status: 200,
			body: '{"allow":false}',
		}));
		cleanups.push(() => stand.close());
		const { dir, state, event } = workspace();
		const code = await runHook(
			preJobHookScript(stand.url, { stateDir: state }),
			dir,
			pushJob(event),
		);
		expect(code).toBe(HOOK_EXIT.refused);
		expect(code).toBe(41);
		expect(readFileSync(join(state, "fence"), "utf8").trim()).toBe("refuse");
	});

	it("exits 42 for a second job in a sandbox that already allowed one, without asking", async () => {
		const stand = await controlEndpoint(() => ({
			status: 200,
			body: '{"allow":true}',
		}));
		cleanups.push(() => stand.close());
		const { dir, state, event } = workspace();
		const script = preJobHookScript(stand.url, { stateDir: state });
		expect(await runHook(script, dir, pushJob(event))).toBe(0);
		const code = await runHook(script, dir, pushJob(event));
		expect(code).toBe(HOOK_EXIT.conflict);
		expect(code).toBe(42);
		expect(stand.posted).toHaveLength(1);
		expect(readFileSync(join(state, "fence"), "utf8").trim()).toBe("conflict");
	});

	it("exits 43 when the agent cannot be reached or its answer cannot be read", async () => {
		const gone = await controlEndpoint(() => ({ status: 200, body: "" }));
		const url = gone.url;
		await gone.close();
		const first = workspace();
		const unreachable = await runHook(
			preJobHookScript(url, { stateDir: first.state }),
			first.dir,
			pushJob(first.event),
		);
		expect(unreachable).toBe(HOOK_EXIT.unreachable);
		expect(unreachable).toBe(43);
		expect(readFileSync(join(first.state, "fence"), "utf8").trim()).toBe(
			"unreachable",
		);

		for (const reply of [
			{ status: 500, body: '{"allow":true}' },
			{ status: 200, body: "allow" },
		]) {
			const stand = await controlEndpoint(() => reply);
			cleanups.push(() => stand.close());
			const { dir, state, event } = workspace();
			expect(
				await runHook(
					preJobHookScript(stand.url, { stateDir: state }),
					dir,
					pushJob(event),
				),
			).toBe(43);
		}
	});
});
