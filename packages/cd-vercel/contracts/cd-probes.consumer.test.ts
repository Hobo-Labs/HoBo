import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { z } from "zod";

import { CdStoreBindingError, createCdHttpEntry } from "../src/index.js";

const Pact = z.object({
	consumer: z.object({ name: z.string() }),
	provider: z.object({ name: z.string() }),
	interactions: z.array(
		z.object({
			description: z.string(),
			providerState: z.literal(
				"CD cannot compose: no store binding is committed",
			),
			request: z.object({
				method: z.literal("GET"),
				path: z.enum(["/healthz", "/readyz"]),
			}),
			response: z.object({ status: z.number(), body: z.json() }),
		}),
	),
});
const pact = Pact.parse(
	JSON.parse(
		readFileSync(new URL("./cd-probes.pact.json", import.meta.url), "utf8"),
	),
);

it("answers each recorded probe as recorded", async () => {
	expect(pact.interactions).toHaveLength(2);
	const entry = createCdHttpEntry(
		async () => {
			throw new CdStoreBindingError("cd-store-binding-missing", "none");
		},
		{ commit: "0123456789abcdef0123456789abcdef01234567" },
	);
	const server = createServer((req, res) => void entry(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = z.object({ port: z.number() }).parse(server.address());
		for (const { request, response } of pact.interactions) {
			const res = await fetch(`http://127.0.0.1:${port}${request.path}`, {
				method: request.method,
			});
			expect(res.status).toBe(response.status);
			expect(await res.json()).toEqual(response.body);
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
