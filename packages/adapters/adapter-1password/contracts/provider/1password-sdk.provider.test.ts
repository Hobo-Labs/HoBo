import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";
import { loadPactDirectory, verifyPact } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { createFake1Password } from "../../test/support/fake-1password.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * The stand-in every unit test runs against must answer the pact's recorded
 * calls with the recorded results, so the unit tests exercise the boundary
 * the consumer contract pins. The real SDK and service are not contacted.
 */
describe("the 1Password SDK stand-in (provider verification)", () => {
	it("honours every interaction in the pact", async () => {
		const [pact] = (
			await loadPactDirectory(path.join(contractsDir, "pacts"))
		).filter((candidate) => candidate.provider.name === "OnePasswordSdk");
		if (!pact) throw new Error("the 1Password pact is missing");
		const fake = createFake1Password("abcdefghijklmnopqrstuvwxyz");
		const report = await verifyPact(pact, {
			name: "OnePasswordSdk",
			async handle(request) {
				if (fake.items.size === 0)
					fake.seed({
						id: "itemaaaaaaaaaaaaaaaaaaaaa1",
						title: "HOBO_CI_VALKEY_URL",
						category: "Password",
						vaultId: "abcdefghijklmnopqrstuvwxyz",
						fields: [
							{
								id: "password",
								title: "password",
								fieldType: "Concealed",
								value: "fixture-value-1",
							},
						],
						version: 1,
					});
				// The create interaction expects the next item id.
				if (request.path === "/sdk/items.create")
					for (const [id, item] of fake.items)
						if (item.title === "NEW_SECRET") fake.items.delete(id);
				const body: JsonValue | undefined =
					request.body === undefined
						? undefined
						: JSON.parse(JSON.stringify(request.body));
				const answer = await fake.handle({ ...request, body });
				return {
					status: answer.status,
					headers: {},
					body: JSON.parse(JSON.stringify(answer.body ?? null)),
				};
			},
		});
		expect(report.failures).toEqual([]);
		expect(report.ok).toBe(true);
	});
});
