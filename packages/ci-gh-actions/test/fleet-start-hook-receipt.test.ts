import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const hook = fileURLToPath(
	new URL("../templates/fleet-pre-job-hook.sh", import.meta.url),
);
const secret = "x".repeat(64);
const executionKey = {
	githubJob: {
		kind: "github-job",
		accountId: "account",
		engineId: "gh-actions",
		installationId: "10",
		repositoryId: "101",
		runId: "900",
		jobId: "1",
		runAttempt: 1,
	},
};
const receipt = {
	ok: true,
	slotId: "slot-1",
	claimId: "claim-1",
	accountId: "account",
	profileId: "profile",
	runnerName: "hobo-slot-1",
	executionKey,
};
async function runHook(
	status: number,
	responseBody: string,
	overrides: Record<string, string> = {},
) {
	let requestBody = "";
	const server = createServer((request, response) => {
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			requestBody += chunk;
		});
		request.on("end", () => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(responseBody);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = z
		.object({ port: z.number().int().positive() })
		.parse(server.address());
	const env = {
		...process.env,
		HOBO_START_FENCE_URL: `http://127.0.0.1:${address.port}/fence`,
		HOBO_SLOT_ID: "slot-1",
		HOBO_CLAIM_ID: "claim-1",
		HOBO_BINDING_SECRET: secret,
		HOBO_ACCOUNT_ID: "account",
		HOBO_PROFILE_ID: "profile",
		HOBO_EXECUTION_KEY_JSON: JSON.stringify(executionKey),
		GITHUB_REPOSITORY: "org/repo",
		GITHUB_RUN_ID: "900",
		GITHUB_JOB: "build",
		GITHUB_RUN_ATTEMPT: "1",
		RUNNER_NAME: "hobo-slot-1",
		...overrides,
	};
	try {
		const child = spawn("bash", [hook], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		return { code, stdout, stderr, requestBody };
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}
describe("strict runner start-hook receipts", () => {
	it("accepts an explicit matching authorization receipt", async () => {
		const result = await runHook(200, JSON.stringify(receipt));
		expect(result.code).toBe(0);
		expect(JSON.parse(result.requestBody)).toMatchObject({
			slotId: "slot-1",
			claimId: "claim-1",
			bindingSecret: secret,
			executionKey,
		});
		expect(result.stdout + result.stderr).not.toContain(secret);
	});
	it.each([
		{ status: 302, body: JSON.stringify(receipt) },
		{ status: 204, body: "" },
		{ status: 200, body: JSON.stringify({ ok: false }) },
		{ status: 200, body: JSON.stringify({ ...receipt, ok: false }) },
		{ status: 200, body: JSON.stringify({ ok: true }) },
		{ status: 200, body: "not-json" },
		{ status: 200, body: JSON.stringify({ ...receipt, slotId: "different" }) },
		{ status: 200, body: JSON.stringify({ ...receipt, claimId: "different" }) },
		{
			status: 200,
			body: JSON.stringify({ ...receipt, accountId: "different" }),
		},
		{
			status: 200,
			body: JSON.stringify({ ...receipt, profileId: "different" }),
		},
		{
			status: 200,
			body: JSON.stringify({ ...receipt, runnerName: "different" }),
		},
		{
			status: 200,
			body: JSON.stringify({
				...receipt,
				executionKey: { githubJob: { ...executionKey.githubJob, jobId: "2" } },
			}),
		},
		{
			status: 200,
			body: JSON.stringify({
				...receipt,
				executionKey: {
					githubJob: { ...executionKey.githubJob, runAttempt: 2 },
				},
			}),
		},
		{
			status: 200,
			body: JSON.stringify({
				...receipt,
				executionKey: {
					githubJob: { ...executionKey.githubJob, extra: "unexpected" },
				},
			}),
		},
		{ status: 200, body: "x".repeat(65_537) },
		{
			status: 200,
			body: JSON.stringify({ ...receipt, padding: "x".repeat(65_537) }),
		},
		{ status: 503, body: "unavailable" },
	])("fails closed for HTTP $status and invalid or mismatched receipts", async ({
		status,
		body,
	}) => {
		const result = await runHook(status, body);
		expect(result.code).not.toBe(0);
		expect(result.stdout + result.stderr).not.toContain(secret);
	});
	it("rejects a receipt for a job key that disagrees with the runner's run context", async () => {
		const result = await runHook(200, JSON.stringify(receipt), {
			GITHUB_RUN_ID: "901",
		});
		expect(result.code).not.toBe(0);
		expect(result.requestBody).toBe("");
	});
	it("rejects an unexpected field in the requested job key before contacting the endpoint", async () => {
		const result = await runHook(200, JSON.stringify(receipt), {
			HOBO_EXECUTION_KEY_JSON: JSON.stringify({
				githubJob: { ...executionKey.githubJob, extra: "unexpected" },
			}),
		});
		expect(result.code).not.toBe(0);
		expect(result.requestBody).toBe("");
	});
	it.each([
		["HOBO_EXECUTION_KEY_JSON", "{bad-json"],
		["GITHUB_RUN_ATTEMPT", "2"],
	])("rejects malformed or stale job context before contacting the endpoint", async (field, value) => {
		const result = await runHook(200, JSON.stringify(receipt), {
			[field]: value,
		});
		expect(result.code).not.toBe(0);
		expect(result.requestBody).toBe("");
		expect(result.stderr).not.toContain(secret);
	});
	it("rejects generated changes to receipt identity", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(
					"slotId",
					"claimId",
					"accountId",
					"profileId",
					"runnerName",
					"jobId",
				),
				fc.string({ minLength: 1, maxLength: 12 }),
				async (field, replacement) => {
					const changed =
						field === "jobId"
							? {
									...receipt,
									executionKey: {
										githubJob: {
											...executionKey.githubJob,
											jobId: replacement,
										},
									},
								}
							: { ...receipt, [field]: replacement };
					fc.pre(JSON.stringify(changed) !== JSON.stringify(receipt));
					const result = await runHook(200, JSON.stringify(changed));
					expect(result.code).not.toBe(0);
				},
			),
			{ seed: 614476, numRuns: 25 },
		);
	}, 20_000);
});
