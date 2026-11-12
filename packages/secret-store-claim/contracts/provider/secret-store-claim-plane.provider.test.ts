import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ClaimBundle, createOneTimeActionStore } from "@hobo/claims";
import {
	checkPactInventory,
	loadPactDirectory,
	type PactResponse,
	verifyPact,
} from "@hobo/contract-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimScopeFor,
	provisionSelfHostedInfisical,
	relayStoreLayout,
	verifySelfHostedInfisicalClaim,
} from "../../src/index.js";
import {
	type StubInfisical,
	startStubInfisical,
} from "../../test/support/stub-infisical.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const PASSWORD = "stub-generated-password-0123456789abcdef";
const NOW = new Date("2026-11-12T10:00:00.000Z");

let stub: StubInfisical;
beforeAll(async () => {
	stub = await startStubInfisical();
});
afterAll(async () => {
	await stub.close();
});

/**
 * The real provisioning and finalize, behind the operation names the pact
 * records, against a local Infisical stand-in. Nothing reaches Infisical.
 */
function provider() {
	const store = createOneTimeActionStore({
		seal: (value) => Buffer.from(value).toString("base64"),
		open: (value) => Buffer.from(value, "base64").toString("utf8"),
	});
	const scope = claimScopeFor("ci-vercel", {});
	let bundle: ClaimBundle | undefined;
	return {
		name: "HoboSecretStoreClaim",
		async handle(request: { path: string }): Promise<PactResponse> {
			const item = () => bundle?.items[0];
			if (request.path === "/secret-store/provision") {
				const result = await provisionSelfHostedInfisical({
					siteUrl: stub.url,
					ownerEmail: "owner@hobo.invalid",
					organization: "hobo",
					layout: relayStoreLayout({
						vercelTeamSlug: "hobo-team",
						vercelTeamId: "team_fixture",
						vercelProjectId: "prj_fixture",
						repository: "Hobo-Labs/HoBo",
					}),
					deploymentRef: "ci-vercel",
					store,
					scope,
					now: NOW,
					generatePassword: () => PASSWORD,
					allowLoopback: true,
				});
				bundle = result.bundle;
				const text = JSON.stringify(result);
				return {
					status: 200,
					body: JSON.parse(
						JSON.stringify({
							...result,
							carriesBearerMaterial:
								text.includes(PASSWORD) || text.includes("stub-admin-token"),
						}),
					),
				};
			}
			const current = item();
			if (current === undefined) return { status: 409 };
			if (request.path === "/secret-store/open") {
				const redeem = () =>
					store.redeem({
						id: current.oneTimeActionRef ?? "",
						...scope,
						audience: current.providerId,
						now: NOW.getTime() + 1000,
					});
				await redeem();
				const second = await redeem().then(
					() => "redeemed",
					(error: { code?: string }) => error.code ?? "error",
				);
				return { status: 200, body: { opened: true, secondOpen: second } };
			}
			if (request.path === "/secret-store/finalize") {
				const result = await verifySelfHostedInfisicalClaim({
					item: current,
					store,
					scope,
					nowMs: NOW.getTime() + 60_000,
				});
				return {
					status: 200,
					body: {
						verified: result.verified,
						bootstrapIdentityRemaining: stub.identities.some(
							(identity) => identity.name === "Instance Admin Identity",
						),
					},
				};
			}
			return { status: 404 };
		},
	};
}

describe("secret-store provisioning ⇄ the HoBo claim plane (provider verification)", () => {
	it("honours every interaction, in order", async () => {
		const [pact] = (
			await loadPactDirectory(path.join(contractsDir, "pacts"))
		).filter((candidate) => candidate.provider.name === "HoboSecretStoreClaim");
		if (!pact) throw new Error("the claim-plane pact is missing");
		const report = await verifyPact(pact, provider());
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
