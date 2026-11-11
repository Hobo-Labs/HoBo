import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";
import { loadPactDirectory, verifyPact } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { createFakeInfisical } from "../../test/support/fake-infisical.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const relay = {
	projectId: "proj-1",
	environment: "prod",
	secretPath: "/hobo-ci-relay",
};

/**
 * The fake every unit test runs against must answer the pact's recorded
 * requests with the recorded responses, so the unit tests exercise the same
 * boundary the consumer contract pins. Provider states are set up here; the
 * real Infisical is not contacted.
 */
describe("the local Infisical stand-in (provider verification)", () => {
	it("honours every interaction in the pact", async () => {
		const [pact] = (
			await loadPactDirectory(path.join(contractsDir, "pacts"))
		).filter((candidate) => candidate.provider.name === "InfisicalApi");
		if (!pact) throw new Error("the Infisical pact is missing");
		const fake = createFakeInfisical();
		fake.identities.push(
			{
				kind: "oidc",
				identityId: "relay-identity",
				jwt: "fixture-header.fixture-payload.fixture-signature",
				access: "write",
			},
			{
				kind: "universal-auth",
				clientId: "owner-client",
				clientSecret: "fixture-client-secret",
				access: "write",
			},
		);
		fake.nextTokens.push("fixture-access-token", "fixture-owner-token");
		fake.seed(relay, "HOBO_CI_PUBLIC_URL", "https://ci.example.com");
		fake.fail(
			(request) =>
				request.method === "PATCH" &&
				request.path === "/api/v4/secrets/READ_ONLY_DENIED",
			{
				status: 403,
				headers: { "content-type": "application/json" },
				body: { statusCode: 403, error: "PermissionDenied" },
			},
			Number.POSITIVE_INFINITY,
		);
		fake.fail(
			(request) => request.path.includes("secretPath=%2Frate-limited"),
			{
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "1" },
				body: { statusCode: 429 },
			},
			Number.POSITIVE_INFINITY,
		);
		fake.fail(
			(request) => request.path.includes("secretPath=%2Funavailable"),
			{
				status: 503,
				headers: { "content-type": "application/json" },
				body: { statusCode: 503 },
			},
			Number.POSITIVE_INFINITY,
		);
		// The list interactions run before HOBO_CI_GITHUB_APP_ID is written, so
		// it is seeded at version 1 after the reads, by the first PATCH's state.
		let seeded = false;
		const report = await verifyPact(pact, {
			name: "InfisicalApi",
			handle(request) {
				if (
					!seeded &&
					request.method === "PATCH" &&
					request.path.endsWith("/HOBO_CI_GITHUB_APP_ID")
				) {
					fake.seed(relay, "HOBO_CI_GITHUB_APP_ID", "100000");
					seeded = true;
				}
				// The pact holds JSON; a round trip types it as such.
				const body: JsonValue | undefined =
					request.body === undefined
						? undefined
						: JSON.parse(JSON.stringify(request.body));
				return fake.handle({ ...request, body });
			},
		});
		expect(report.failures).toEqual([]);
		expect(report.ok).toBe(true);
	});
});
