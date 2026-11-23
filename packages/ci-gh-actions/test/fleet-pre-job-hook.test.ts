import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const hook = resolve("templates/fleet-pre-job-hook.sh");
const secret = "fixture-binding-secret-0123456789abcdef";
const githubJob = {
	kind: "github-job",
	accountId: "account-1",
	engineId: "github",
	installationId: "10",
	repositoryId: "101",
	runId: "900",
	jobId: "23",
	runAttempt: 2,
};
const env = {
	PATH: process.env.PATH,
	HOBO_SLOT_ID: "slot-1",
	HOBO_CLAIM_ID: "claim-1",
	HOBO_BINDING_SECRET: secret,
	HOBO_ACCOUNT_ID: "account-1",
	HOBO_PROFILE_ID: "isolated-linux",
	HOBO_EXECUTION_KEY_JSON: JSON.stringify({ githubJob }),
	GITHUB_REPOSITORY: "owner/repository",
	GITHUB_RUN_ID: "900",
	GITHUB_RUN_ATTEMPT: "2",
	GITHUB_JOB: "build",
	RUNNER_NAME: "hobo-slot-1",
};

type RequestBody = {
	slotId: string;
	claimId: string;
	runnerName: string;
	bindingSecret: string;
	executionKey: { githubJob: typeof githubJob };
};

type Handler = (body: RequestBody, response: ServerResponse) => void;
let directory: string;
let certificate: string;
let server: ReturnType<typeof createServer>;
let origin: string;
let handler: Handler;
let received: RequestBody[];

function receipt(body: RequestBody) {
	return {
		authorized: true,
		slotId: body.slotId,
		claimId: body.claimId,
		runnerName: body.runnerName,
		executionKey: body.executionKey,
	};
}

function sendJson(
	response: ServerResponse,
	value: ReturnType<typeof receipt>,
	status = 200,
) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

async function runHook(overrides: Record<string, string> = {}) {
	const child = spawn("bash", [hook], {
		env: {
			...env,
			NODE_EXTRA_CA_CERTS: certificate,
			HOBO_START_FENCE_URL: `${origin}/start`,
			...overrides,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.setEncoding("utf8").on("data", (text) => {
		output += text;
	});
	child.stderr.setEncoding("utf8").on("data", (text) => {
		output += text;
	});
	const [code] = await once(child, "close");
	return { code, output };
}

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "hobo-start-fence-"));
	const key = join(directory, "key.pem");
	certificate = join(directory, "certificate.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-sha256",
			"-nodes",
			"-days",
			"1",
			"-keyout",
			key,
			"-out",
			certificate,
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ stdio: "ignore" },
	);
	server = createServer(
		{ key: readFileSync(key), cert: readFileSync(certificate) },
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body: RequestBody = JSON.parse(
					Buffer.concat(chunks).toString("utf8"),
				);
				received.push(body);
				handler(body, response);
			});
		},
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!(address instanceof Object) || !("port" in address))
		throw new Error("HTTPS server did not bind");
	origin = `https://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolveClose, rejectClose) =>
		server.close((error) => (error ? rejectClose(error) : resolveClose())),
	);
	rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
	received = [];
	handler = (body, response) => sendJson(response, receipt(body));
});

describe("strict pre-job hook", () => {
	it("accepts only a matching HTTPS authorization receipt", async () => {
		const result = await runHook();
		expect(result.code).toBe(0);
		expect(result.output).not.toContain(secret);
		expect(received).toHaveLength(1);
		expect(received[0]?.bindingSecret).toBe(secret);
		expect(received[0]?.executionKey.githubJob).toEqual(githubJob);
	});

	it.each([
		301, 302, 307, 308, 204, 400, 500,
	])("rejects HTTP %i", async (status) => {
		handler = (body, response) => {
			response.writeHead(status, {
				location: `${origin}/followed`,
				"content-type": "application/json",
			});
			response.end(JSON.stringify(receipt(body)));
		};
		const result = await runHook();
		expect(result.code).not.toBe(0);
		expect(result.output).not.toContain(secret);
		expect(received).toHaveLength(1);
	});

	it("rejects a receipt for a different job", async () => {
		handler = (body, response) =>
			sendJson(response, {
				...receipt(body),
				executionKey: { githubJob: { ...githubJob, jobId: "other" } },
			});
		expect((await runHook()).code).not.toBe(0);
	});

	it("rejects unstructured and oversized success responses", async () => {
		handler = (_body, response) => {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("ok");
		};
		expect((await runHook()).code).not.toBe(0);
		handler = (_body, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ text: "x".repeat(20000) }));
		};
		expect((await runHook()).code).not.toBe(0);
	});

	it("rejects stale runner context before sending the credential", async () => {
		expect((await runHook({ GITHUB_RUN_ID: "901" })).code).not.toBe(0);
		expect((await runHook({ GITHUB_RUN_ATTEMPT: "1" })).code).not.toBe(0);
		expect((await runHook({ RUNNER_NAME: "hobo-other" })).code).not.toBe(0);
		expect(received).toHaveLength(0);
	});

	it("rejects plaintext transport and invalid timeouts before sending the credential", async () => {
		expect(
			(await runHook({ HOBO_START_FENCE_URL: "http://127.0.0.1:1234/start" }))
				.code,
		).not.toBe(0);
		expect(
			(await runHook({ HOBO_START_FENCE_TIMEOUT_SEC: "0" })).code,
		).not.toBe(0);
		expect(
			(await runHook({ HOBO_START_FENCE_TIMEOUT_SEC: "61" })).code,
		).not.toBe(0);
		expect(received).toHaveLength(0);
	});

	it("fails closed when the controller does not respond before the deadline", async () => {
		handler = (_body, response) => {
			const timer = setTimeout(() => response.end(), 500);
			response.on("close", () => clearTimeout(timer));
		};
		const result = await runHook({ HOBO_START_FENCE_TIMEOUT_SEC: "0.1" });
		expect(result.code).not.toBe(0);
		expect(result.output).not.toContain(secret);
	});
});
