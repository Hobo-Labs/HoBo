import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { RelayJobAnswerSchema } from "@hobo/ci";
import { expect, it } from "vitest";
import { z } from "zod";
import { GithubRunnerServiceClient } from "../src/runner-protocol/client.js";
import { FakeGithubRunnerService } from "../src/runner-protocol/fake-service.js";
import {
	jitSigningKey,
	parseJitConfig,
} from "../src/runner-protocol/jit-config.js";

const INTERACTION = z.object({
	description: z.string(),
	request: z.object({
		method: z.string(),
		path: z.string(),
		query: z.record(z.string(), z.array(z.string())).optional(),
		headers: z.record(z.string(), z.string()).optional(),
		body: z.json().optional(),
	}),
	response: z.object({ status: z.number(), body: z.json().optional() }),
	source: z.string().min(1),
});

const pact = z
	.object({ interactions: z.array(INTERACTION) })
	.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../contracts/github-runner-service.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);

const CLIENT_ID = "00000000-0000-4000-8000-0000000000c1";
const HOST_OF_PATH = (path: string) =>
	path.startsWith("/_apis/oauth2/token/")
		? "vstoken.actions.githubusercontent.com"
		: path.startsWith("/42/")
			? "run-actions-3-azure-eastus.actions.githubusercontent.com"
			: "broker.actions.githubusercontent.com";

it("executes every interaction of the GitHub runner service pact in order", async () => {
	const jit = parseJitConfig(
		new FakeGithubRunnerService().jitConfig("hobo-relay-pact", CLIENT_ID),
		{ runnerName: "hobo-relay-pact" },
	);
	const signer = createPublicKey(jitSigningKey(jit.rsaParameters));
	let next = 0;
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const interaction = pact.interactions[next];
		if (!interaction) throw new Error(`unexpected request ${request.url}`);
		next += 1;
		const url = new URL(request.url);
		expect(url.hostname, interaction.description).toBe(
			HOST_OF_PATH(interaction.request.path),
		);
		expect(request.method, interaction.description).toBe(
			interaction.request.method,
		);
		expect(url.pathname, interaction.description).toBe(
			interaction.request.path,
		);
		expect(
			Object.fromEntries(
				[...url.searchParams].map(([name, value]) => [name, [value]]),
			),
			interaction.description,
		).toEqual(interaction.request.query ?? {});
		for (const [name, value] of Object.entries(
			interaction.request.headers ?? {},
		))
			expect(
				request.headers.get(name),
				`${interaction.description}: ${name}`,
			).toBe(value);
		expect(init?.redirect).toBe("error");
		const text = await request.text();
		const expected = interaction.request.body;
		if (expected === undefined) expect(text).toBe("");
		else if (interaction.request.path.startsWith("/_apis/oauth2/token/")) {
			const form = new URLSearchParams(text);
			const pactForm = new URLSearchParams(String(expected));
			expect(form.get("grant_type")).toBe(pactForm.get("grant_type"));
			expect(form.get("client_assertion_type")).toBe(
				pactForm.get("client_assertion_type"),
			);
			const [header, payload, signature] = (
				form.get("client_assertion") ?? ""
			).split(".");
			expect(
				verify(
					"sha256",
					Buffer.from(`${header}.${payload}`),
					signer,
					Buffer.from(signature ?? "", "base64url"),
				),
			).toBe(true);
			expect(
				JSON.parse(Buffer.from(header ?? "", "base64url").toString()),
			).toEqual({
				alg: "RS256",
				typ: "JWT",
			});
			expect(
				JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
			).toMatchObject({
				iss: CLIENT_ID,
				sub: CLIENT_ID,
				aud: request.url,
			});
		} else expect(JSON.parse(text), interaction.description).toEqual(expected);
		return interaction.response.body === undefined
			? new Response(null, { status: interaction.response.status })
			: Response.json(interaction.response.body, {
					status: interaction.response.status,
				});
	};
	const client = new GithubRunnerServiceClient({
		relayJobs: { answer: true, label: "hobo-relay" },
		fetch: fetcher,
	});
	const session = await client.open(jit);
	const message = await session.nextJob(0);
	expect(message).toMatchObject({
		jobId: "44444444-4444-4444-8444-444444444444",
		planId: "22222222-2222-4222-8222-222222222222",
		repository: "octo/app",
		runId: 9001,
		runAttempt: 1,
		job: "title",
		event: "pull_request",
		actorId: "42",
		triggeringActorId: "43",
		private: true,
		fork: false,
		workflowRef: "octo/app/.github/workflows/ci.yml@refs/pull/7/merge",
	});
	expect(message?.inputs).toEqual([]);
	expect(
		message?.steps.map((step) => [
			step.uses,
			step.inputs.map((input) => [input.name, input.value]),
		]),
	).toEqual([["hobo-labs/hobo/checks/pr-title@v1", [["types", "feat,fix"]]]]);
	await session.complete(
		create(RelayJobAnswerSchema, {
			jobId: "44444444-4444-4444-8444-444444444444",
			planId: "22222222-2222-4222-8222-222222222222",
			conclusion: "succeeded",
			annotations: [{ level: "notice", message: "the title is a feat" }],
		}),
	);
	expect(await session.nextJob(0)).toBeUndefined();
	await session.close();
	expect(next).toBe(pact.interactions.length);
	for (const interaction of pact.interactions)
		expect(interaction.source, interaction.description).not.toBe("");
});
