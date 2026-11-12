import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";
import { loadPactDirectory, verifyPact } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { createFakeBitwarden } from "../../test/support/fake-bitwarden.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * The stand-in every unit test runs against must answer the pact's recorded
 * calls with the recorded results, so the unit tests exercise the boundary
 * the consumer contract pins. The real SDK and service are not contacted.
 */
describe("the Bitwarden SDK stand-in (provider verification)", () => {
	it("honours every interaction in the pact", async () => {
		const [pact] = (
			await loadPactDirectory(path.join(contractsDir, "pacts"))
		).filter(
			(candidate) => candidate.provider.name === "BitwardenSecretsManagerSdk",
		);
		if (!pact) throw new Error("the Bitwarden pact is missing");
		const fake = createFakeBitwarden();
		const report = await verifyPact(pact, {
			name: "BitwardenSecretsManagerSdk",
			async handle(request) {
				if (
					!fake.secrets.has("33333333-3333-4333-8333-333333333333") ||
					request.path === "/sdk/secrets.list"
				)
					fake.seed({
						id: "33333333-3333-4333-8333-333333333333",
						key: "HOBO_CI_VALKEY_URL",
						value: "fixture-value-1",
						note: "",
						organizationId: "11111111-1111-4111-8111-111111111111",
						projectId: "22222222-2222-4222-8222-222222222222",
						revisionDate: "2026-11-12T00:00:00.000Z",
					});
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
