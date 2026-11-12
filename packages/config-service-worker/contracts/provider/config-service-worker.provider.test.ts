/**
 * Provider side: the real handler and `ConfigStore` class, on the Durable
 * Object stand-in, with tokens signed by local issuers in place of the
 * pact's placeholders.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	loadPactDirectory,
	type PactRequest,
	type PactResponse,
	verifyPact,
} from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { harness, ORIGIN } from "../../test/support/harness.js";
import {
	deployClaims,
	RELAY_CLAIMS,
	sign,
} from "../../test/support/issuers.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

async function provider() {
	const h = await harness();
	const tokens = new Map([
		["{vercel-relay}", sign(h.issuers.vercel, RELAY_CLAIMS)],
		["{github-deploy}", sign(h.issuers.github, deployClaims(h.storeId))],
		["{bootstrap}", h.credential],
	]);
	const substitute = (value: string) =>
		value.replace(
			/\{[a-z-]+\}/u,
			(placeholder) => tokens.get(placeholder) ?? placeholder,
		);
	return {
		name: "HoboConfigServiceWorker",
		async handle(request: PactRequest): Promise<PactResponse> {
			const headers = Object.fromEntries(
				Object.entries(request.headers ?? {}).map(([name, value]) => [
					name,
					substitute(value),
				]),
			);
			const response = await h.fetch(`${ORIGIN}${request.path}`, {
				method: request.method,
				headers,
				...(request.body !== undefined
					? { body: JSON.stringify(request.body) }
					: undefined),
			});
			return {
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
				body: await response.json(),
			};
		},
	};
}

describe("the config-service Worker (provider verification)", () => {
	it("honours every interaction, in order", async () => {
		const [pact] = (
			await loadPactDirectory(path.join(contractsDir, "pacts"))
		).filter(
			(candidate) => candidate.provider.name === "HoboConfigServiceWorker",
		);
		if (!pact) throw new Error("the config-service Worker pact is missing");
		const report = await verifyPact(pact, await provider());
		expect(report.failures).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it("lists the pact in the inventory", async () => {
		expect(await checkPactInventory(contractsDir)).toEqual({
			ok: true,
			problems: [],
		});
	});
});
