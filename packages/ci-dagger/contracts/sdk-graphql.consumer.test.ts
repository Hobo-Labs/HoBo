import { once } from "node:events";
import { createServer } from "node:http";
import { executePipeline, parsePipeline } from "@hobo/ci";
import { expect, it } from "vitest";
import { createDaggerBackend } from "../src/backend.js";
import pact from "./sdk-graphql.pact.json" with { type: "json" };

it("drives the default connector through the real SDK and exact engine HTTP boundary", async () => {
	const seen = new Set<string>();
	const failures: string[] = [];
	const image = `example.test/toolchain@sha256:${"a".repeat(64)}`;
	const server = createServer(async (request, response) => {
		try {
			expect(request.method).toBe("POST");
			expect(request.url).toBe("/query");
			expect(request.headers.authorization).toBe(
				`Basic ${Buffer.from("local-contract-token:").toString("base64")}`,
			);
			const chunks: Buffer[] = [];
			for await (const chunk of request)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			const query = String(JSON.parse(Buffer.concat(chunks).toString()).query);
			// Generated SDK operations form a single chain. Arguments are stripped only
			// for constructing the matching GraphQL response nesting, never for assertions.
			const structure = query
				.replaceAll(/"(?:\\.|[^"\\])*"/g, '"value"')
				.replaceAll(/\([^)]*\)/g, "");
			const fields = Array.from(
				structure.matchAll(/(?:\{|\})\s*([A-Za-z][A-Za-z0-9_]*)/g),
				(match) => match[1],
			);
			const leaf = fields.at(-1);
			const interaction = pact.interactions.find(
				(row) => row.request.operation === leaf,
			);
			if (!interaction)
				throw new Error(`unmatched GraphQL operation: ${query}`);
			if (query.includes("withExec")) {
				expect(query).toContain(`address: ${JSON.stringify(image)}`);
				expect(query).toContain("expect: ANY");
				expect(query.replaceAll(/\s/g, "")).toContain(
					'args:["timeout","--signal=TERM","--kill-after=5s","30s","write","first"]',
				);
			}
			seen.add(interaction.description);
			let nested: object | string | number = interaction.response.value;
			for (const field of fields.reverse()) {
				if (!field) throw new Error("missing field");
				nested = { [field]: nested };
			}
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ data: nested }));
		} catch (error) {
			failures.push(
				error instanceof Error ? error.message : "contract failure",
			);
			response
				.writeHead(500)
				.end('{"errors":[{"message":"consumer contract mismatch"}]}');
		}
	});
	const oldPort = process.env.DAGGER_SESSION_PORT;
	const oldToken = process.env.DAGGER_SESSION_TOKEN;
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (!address || Object.prototype.toString.call(address) !== "[object Object]")
		throw new Error("missing local server address");
	const port = Object.getOwnPropertyDescriptor(address, "port")?.value;
	try {
		process.env.DAGGER_SESSION_PORT = String(port);
		process.env.DAGGER_SESSION_TOKEN = "local-contract-token";
		const pipeline = parsePipeline(
			JSON.stringify({
				id: "real-sdk-contract",
				accountId: "a",
				timeoutSeconds: 30,
				steps: [{ id: "write", argv: ["write", "first"], cwd: ".", env: {} }],
				artifactPaths: [],
			}),
		);
		const result = await executePipeline(
			createDaggerBackend({ sourceDirectory: ".", image }),
			pipeline,
		);
		expect(result.status).toBe("succeeded");
		expect(result.steps[0]).toMatchObject({
			id: "write",
			exitCode: 0,
			stdout: "written\n",
			stderr: "",
		});
		expect(failures).toEqual([]);
		expect(seen.size).toBe(pact.interactions.length);
	} finally {
		if (oldPort === undefined) delete process.env.DAGGER_SESSION_PORT;
		else process.env.DAGGER_SESSION_PORT = oldPort;
		if (oldToken === undefined) delete process.env.DAGGER_SESSION_TOKEN;
		else process.env.DAGGER_SESSION_TOKEN = oldToken;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
