import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Sandbox } from "@vercel/sandbox";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
	PREPARE_SANDBOX_RUNNER,
	START_SANDBOX_RUNNER,
	sandboxRunnerBootstrapPort,
	startSandboxRunner,
} from "../src/sandbox-runner-bootstrap.js";

it("executes the real Vercel SDK session contract without putting JIT in command requests", async () => {
	const pact = z
		.object({
			interactions: z.array(
				z.object({
					request: z.object({ method: z.string(), path: z.string() }),
					response: z.object({ status: z.number() }),
				}),
			),
		})
		.parse(
			JSON.parse(
				readFileSync(
					new URL("./sandbox-bootstrap.pact.json", import.meta.url),
					"utf8",
				),
			),
		);
	expect(pact.interactions).toHaveLength(5);
	const secret = "c2luZ2xlLXVzZS1maXh0dXJl";
	const command = {
		id: "cmd-fixture",
		name: "bash",
		args: [],
		cwd: "/vercel/sandbox",
		sessionId: "session-fixture",
		startedAt: 1,
		exitCode: null,
	};
	const session = {
		id: "session-fixture",
		memory: 2048,
		vcpus: 1,
		region: "iad1",
		timeout: 300000,
		status: "running",
		requestedAt: 1,
		startedAt: 1,
		createdAt: 1,
		updatedAt: 1,
		cwd: "/somewhere-else",
	};
	const sandbox = {
		name: "hobo-fixture",
		persistent: false,
		createdAt: 1,
		updatedAt: 1,
		currentSessionId: "session-fixture",
		status: "running",
	};
	const matched: string[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const interaction = pact.interactions[matched.length];
		if (!interaction) throw new Error("unexpected SDK interaction");
		expect(new URL(url).pathname).toBe(interaction.request.path);
		expect(init.method).toBe(interaction.request.method);
		matched.push(interaction.request.path);
		if (matched.length === 1) {
			expect(JSON.parse(String(init.body))).toMatchObject({
				persistent: false,
				resources: { vcpus: 1 },
			});
			return Response.json(
				{ sandbox, session, routes: [] },
				{ status: interaction.response.status },
			);
		}
		if (matched.length === 2 || matched.length === 4) {
			const tar = gunzipSync(
				Buffer.from(z.instanceof(Uint8Array).parse(init.body)),
			);
			if (matched.length === 2) {
				expect(
					tar.includes(Buffer.from("vercel/sandbox/hobo-ci-runner.tar.gz")),
				).toBe(true);
				expect(tar.includes(Buffer.from("fixture-archive"))).toBe(true);
			} else {
				expect(tar.includes(Buffer.from("vercel/sandbox/.hobo-ci-jit"))).toBe(
					true,
				);
				expect(tar.includes(Buffer.from(secret))).toBe(true);
			}
			return Response.json({}, { status: interaction.response.status });
		}
		const body = JSON.parse(String(init.body));
		expect(JSON.stringify(body)).not.toContain(secret);
		expect(body).toMatchObject({ command: "bash", cwd: "/vercel/sandbox" });
		if (matched.length === 3) {
			expect(body.args).toEqual(["-c", PREPARE_SANDBOX_RUNNER]);
			expect(body.wait).toBe(true);
			return new Response(
				`${JSON.stringify({ command })}\n${JSON.stringify({ command: { ...command, exitCode: 0 } })}\n`,
				{
					status: interaction.response.status,
					headers: { "content-type": "application/x-ndjson" },
				},
			);
		}
		expect(body.args).toEqual(["-c", START_SANDBOX_RUNNER]);
		return Response.json({ command }, { status: interaction.response.status });
	});
	try {
		const actual = await Sandbox.create({
			token: "fixture-token",
			teamId: "team-fixture",
			projectId: "project-fixture",
			persistent: false,
			resources: { vcpus: 1 },
		});
		const port = sandboxRunnerBootstrapPort(actual.currentSession());
		await port.writeFiles([
			{
				path: "/vercel/sandbox/hobo-ci-runner.tar.gz",
				content: Buffer.from("fixture-archive"),
				mode: 0o600,
			},
		]);
		await port.runCommand({
			cmd: "bash",
			args: ["-c", PREPARE_SANDBOX_RUNNER],
			cwd: "/vercel/sandbox",
			detached: false,
		});
		expect(await startSandboxRunner(port, secret)).toMatchObject({
			cmdId: "cmd-fixture",
		});
		expect(matched).toHaveLength(pact.interactions.length);
	} finally {
		vi.unstubAllGlobals();
	}
});
