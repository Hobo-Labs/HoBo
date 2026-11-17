import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, it } from "vitest";
import { z } from "zod";

import { CdStoreBindingError, createCdHttpEntry } from "../src/index.js";

// `hobo cd up` verifies a delivered CD by its probes, as `hobo ci up` does the
// relay. The two run in different places, so the probes' answers are a
// contract: the provider side here is the function's own entry
// (`createCdHttpEntry`) in the recorded state.

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
		// SAFETY: a server listening on a TCP port reports an AddressInfo.
		const { port } = server.address() as AddressInfo;
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
