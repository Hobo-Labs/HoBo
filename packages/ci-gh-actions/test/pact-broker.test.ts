import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { pactBrokerClient } from "../scripts/pact-broker.js";

const execute = promisify(execFile);

it.each([
	true,
	false,
])("gates deployment on the verified local relay contract (verified=%s)", async (verified) => {
	const selected: string[][] = [];
	const server = createServer((request, response) => {
		const query = new URL(request.url ?? "", "http://localhost").searchParams;
		const versions = query.getAll("q[][version]");
		selected.push(versions);
		response.setHeader("Content-Type", "application/json");
		response.end(
			JSON.stringify({
				summary: {
					deployable: verified,
					success: verified ? 1 : 0,
					failed: 0,
					unknown: verified ? 0 : 1,
				},
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = z.object({ port: z.number() }).parse(server.address());
		const args = [
			"--import",
			"tsx",
			fileURLToPath(new URL("../scripts/pact-broker.ts", import.meta.url)),
			"--gate",
			"--broker-url",
			`http://127.0.0.1:${port}`,
			"--version",
			"hobo-build",
		];
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PACT_BROKER_TOKEN: "",
			NO_PROXY: `127.0.0.1,localhost,${process.env.NO_PROXY ?? ""}`,
		};
		const operation = execute(process.execPath, args, { env, timeout: 15000 });
		if (verified) await expect(operation).resolves.toHaveProperty("stdout");
		else await expect(operation).rejects.toThrow(/Pact deployment blocked/);
		expect(selected).toEqual([["hobo-build", "hobo-build"]]);
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
	}
});

it.each([
	"http://broker.example",
	"https://user:secret@broker.example",
	"https://broker.example/path",
	"https://broker.example?token=secret",
])("refuses unsafe broker address %s before sending credentials", (address) => {
	expect(() => pactBrokerClient(address, "fixture-token")).toThrow(
		/HTTPS origin or loopback/,
	);
});

it.each([
	{ deployable: true, success: 1, failed: 0, unknown: 0, expected: true },
	{ deployable: false, success: 0, failed: 1, unknown: 0, expected: false },
	{ deployable: false, success: 0, failed: 0, unknown: 1, expected: false },
	{ deployable: null, success: 0, failed: 0, unknown: 1, expected: false },
	{ deployable: true, success: 0, failed: 0, unknown: 0, expected: false },
	{ deployable: true, success: 1, failed: 0, unknown: 1, expected: false },
])("queries exact versions and fails closed for matrix summary $deployable/$unknown/$success", async ({
	expected,
	...summary
}) => {
	let authorization: string | undefined;
	let selectors: string[] = [];
	const server = createServer((request, response) => {
		authorization = request.headers.authorization;
		selectors = new URL(
			request.url ?? "",
			"http://localhost",
		).searchParams.getAll("q[][version]");
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ summary }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = z.object({ port: z.number() }).parse(server.address());
		expect(
			await pactBrokerClient(
				`http://127.0.0.1:${port}`,
				"fixture-token",
			).canDeploy("consumer-sha", "provider-sha"),
		).toBe(expected);
		expect(selectors).toEqual(["consumer-sha", "provider-sha"]);
		expect(authorization).toBe("Bearer fixture-token");
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
	}
});

it.each([
	200, 302, 503,
])("refuses malformed, redirected or unavailable broker responses (%s)", async (status) => {
	const server = createServer((_request, response) => {
		response.writeHead(status, {
			"Content-Type": "application/json",
			Location: "https://unexpected.example",
		});
		response.end('{"unexpected":true}');
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = z.object({ port: z.number() }).parse(server.address());
		await expect(
			pactBrokerClient(`http://127.0.0.1:${port}`).canDeploy(
				"consumer",
				"provider",
			),
		).rejects.toThrow();
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
	}
});
