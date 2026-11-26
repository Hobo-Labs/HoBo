import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
	loadAdoProject,
	parseAdoLiveTarget,
	verifyLiveAdoPipeline,
} from "../src/index.js";
import {
	adoPact,
	adoPrelude,
	adoSuccess,
	adoTarget,
	createAdoPactBroker,
} from "./fixtures/pact-broker.js";

async function loopback(sequence: readonly string[]) {
	const broker = createAdoPactBroker(sequence);
	const failures: string[] = [];
	const server = createServer(async (incoming, outgoing) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			const headers = new Headers();
			for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
				const name = incoming.rawHeaders[index];
				const value = incoming.rawHeaders[index + 1];
				if (name && value !== undefined) headers.append(name, value);
			}
			const body = Buffer.concat(chunks).toString("utf8");
			const init: RequestInit = {
				method: incoming.method ?? "GET",
				headers,
				redirect: "error",
				signal: new AbortController().signal,
			};
			if (body) init.body = body;
			const response = await broker.fetch(
				`https://dev.azure.com${incoming.url}`,
				init,
			);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(await response.text());
		} catch (error) {
			failures.push(
				error instanceof Error ? error.message : "contract failure",
			);
			outgoing.writeHead(500).end();
		}
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (!address || Object.prototype.toString.call(address) !== "[object Object]")
		throw new Error("local Pact broker has no address");
	const port = Object.getOwnPropertyDescriptor(address, "port")?.value;
	const { project, pipeline } = await loadAdoProject(
		new URL("../../..", import.meta.url).pathname,
		"packages/ci-ado/examples/ci.json",
	);
	let connections = 0;
	const transport: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		expect(url.origin).toBe("https://dev.azure.com");
		expect(init?.redirect).toBe("error");
		expect(init?.signal).toBeDefined();
		connections += 1;
		// Test-only routing; the shipped endpoint parser still refuses arbitrary hosts.
		return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
	};
	return {
		broker,
		get connections() {
			return connections;
		},
		run: () =>
			verifyLiveAdoPipeline(
				parseAdoLiveTarget(JSON.stringify(adoTarget)),
				project,
				pipeline,
				{
					fetch: transport,
					hostEnvironment: { ADO_TEST_PAT: "fixture-pat" },
					pollMilliseconds: 1,
				},
			),
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			expect(failures).toEqual([]);
			broker.assertComplete();
		},
	};
}

it("brokers the shipped Azure client through real loopback HTTP using every success interaction", async () => {
	const f = await loopback(adoSuccess);
	try {
		await expect(f.run()).resolves.toMatchObject({
			runId: 42,
			result: "succeeded",
		});
		expect(f.connections).toBe(adoSuccess.length);
	} finally {
		await f.close();
	}
});

it("brokers real HTTP cancellation and terminal reconciliation", async () => {
	const f = await loopback([
		...adoPrelude,
		"observe wrong source",
		"cancel unfinished pipeline",
		"observe cancelled pipeline",
	]);
	try {
		await expect(f.run()).rejects.toThrow(/provenance/);
	} finally {
		await f.close();
	}
});

it("refuses an HTTP credential redirect without opening a second destination", async () => {
	const f = await loopback(["refuse credential redirect"]);
	try {
		await expect(f.run()).rejects.toThrow();
		expect(f.connections).toBe(1);
	} finally {
		await f.close();
	}
});

it.each([
	"method",
	"query",
	"headers",
	"commit",
	"extra-body",
	"redirect-policy",
])("the Pact broker rejects %s drift independently of client error handling", async (mutation) => {
	const broker = createAdoPactBroker(["queue pinned pipeline once"]);
	const interaction = adoPact.interactions.find(
		(row) => row.description === "queue pinned pipeline once",
	);
	if (!interaction?.request.headers)
		throw new Error("missing queue Pact headers");
	let path = interaction.request.path;
	let body = JSON.stringify(interaction.request.body);
	if (mutation === "query")
		path = path.replace("pipelineVersion=12", "pipelineVersion=13");
	if (mutation === "commit")
		body = body.replace("a".repeat(40), "b".repeat(40));
	if (mutation === "extra-body")
		body = body.replace('"resources":', '"previewRun":true,"resources":');
	await expect(
		broker.fetch(`https://dev.azure.com${path}`, {
			method: mutation === "method" ? "PUT" : "POST",
			headers: mutation === "headers" ? {} : interaction.request.headers,
			body,
			redirect: mutation === "redirect-policy" ? "follow" : "error",
			signal: new AbortController().signal,
		}),
	).rejects.toThrow(/Pact request mismatch/);
	expect(broker.failures).toHaveLength(1);
});
