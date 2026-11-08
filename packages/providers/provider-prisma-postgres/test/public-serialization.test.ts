import { parseSecretRef } from "@hobo/bindings";
import { createClaimableOperationKeyDeriver } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createPrismaClient,
} from "../src/client.js";
import { createPrismaClaimableDatabaseDriver } from "../src/driver.js";
import {
	scanForCredentialMaterial,
	toProviderFacts,
	toProvisionReceipt,
} from "../src/receipt.js";
import {
	createStubCustody,
	createStubRunner,
	FIXTURE_NOW_MS,
	fixture,
	stdout,
} from "./harness.js";

async function provision() {
	const custody = createStubCustody();
	const clock = () => FIXTURE_NOW_MS;
	const driver = createPrismaClaimableDatabaseDriver({
		client: createPrismaClient({
			runner: createStubRunner([stdout(fixture("create.success.json"))]),
			store: createInMemoryIdempotencyStore(),
			clock,
		}),
		custody,
		clock,
	});
	const record = await driver.provision({
		idempotencyKey: "public-serializer-fixture",
		resourceRef: "hobo://yard/demo/database",
	});
	const options = {
		custody,
		deriveOperationKey: createClaimableOperationKeyDeriver(
			Uint8Array.from({ length: 32 }, (_, i) => i + 1),
		),
		scope: {
			tenantId: "tenant",
			providerAccountId: "anonymous",
			scopeId: "deployment",
		},
	};
	return { record, custody, options };
}

describe("Prisma custody-required public serialization", () => {
	it("seals project identity, claim URL, endpoints and associated-resource metadata", async () => {
		const { record, custody, options } = await provision();
		const receipt = await toProvisionReceipt(record, options);
		const facts = await toProviderFacts(record, options);
		const publicBytes = JSON.stringify({ receipt, facts });
		expect(publicBytes).not.toContain(record.projectId);
		expect(publicBytes).not.toContain(record.claim.claimUrl);
		expect(receipt.schemaVersion).toBe(
			"hobo.provider-prisma-postgres.receipt/v2",
		);
		expect(receipt.expirySource).toBe("cli-local-clock");
		expect(receipt.documentedTtlHours).toBe(24);
		expect(
			(
				await custody.resolve(parseSecretRef(receipt.nativeIdentityRef).ref)
			).expose(),
		).toBe(record.projectId);
		expect(
			(
				await custody.resolve(parseSecretRef(receipt.claim.claimRef).ref)
			).expose(),
		).toBe(record.claim.claimUrl);
		expect(
			JSON.stringify(custody.deposits.map((item) => item.scope)),
		).not.toContain(record.projectId);
	});
	it("does not publish project identity through the source resource ref", async () => {
		const { record, options } = await provision();
		const copied = {
			...record,
			resourceRef: `hobo://resource/${record.projectId}`,
		};
		expect(
			JSON.stringify(await toProviderFacts(copied, options)),
		).not.toContain(record.projectId);
	});
	it("requires custody at a JavaScript call boundary", async () => {
		const { record } = await provision();
		// @ts-expect-error JavaScript callers can omit mandatory custody options.
		await expect(toProvisionReceipt(record)).rejects.toThrow("private custody");
		// @ts-expect-error JavaScript callers can omit mandatory custody options.
		await expect(toProviderFacts(record)).rejects.toThrow("private custody");
	});
	it("refuses case and URI-encoded native capability variants", async () => {
		const { record, options } = await provision();
		for (const databaseName of [
			record.projectId.toUpperCase(),
			record.projectId.replaceAll("_", "%5F"),
			record.projectId.replaceAll("_", "%255F"),
		])
			await expect(
				toProvisionReceipt({ ...record, databaseName }, options),
			).rejects.toThrow("capability material");
	});
	it("refuses capability-bearing custody locators and keeps native errors private", async () => {
		const { record, options } = await provision();
		await expect(
			toProvisionReceipt(record, {
				...options,
				custody: {
					async deposit() {
						return `vault://public/${record.projectId}`;
					},
				},
			}),
		).rejects.toThrow("capability material");
		let error: Error | undefined;
		try {
			await toProviderFacts(record, {
				...options,
				custody: {
					async deposit() {
						throw new Error(record.projectId);
					},
				},
			});
		} catch (cause) {
			if (cause instanceof Error) error = cause;
			else throw cause;
		}
		expect(String(error)).not.toContain(record.projectId);
		expect(error?.cause).toBeUndefined();
	});
	it("classifies raw native project ids and claims as capability material with redacted diagnostics", () => {
		const hits = scanForCredentialMaterial({
			projectId: "proj_private",
			claimUrl: "https://create-db.prisma.io/claim?projectID=proj_private",
		});
		expect(hits.map((hit) => hit.rule)).toEqual([
			"native-capability-id",
			"claim-capability-url",
		]);
		expect(JSON.stringify(hits)).not.toContain("proj_private");
	});
	it("preserves adopted, expiry and rotation semantics without publishing raw identity", async () => {
		const { record, options } = await provision();
		for (const state of [
			"claimed-pending-rotation",
			"complete",
			"expired",
		] as const) {
			const facts = await toProviderFacts(
				{ ...record, adopted: true, claim: { ...record.claim, state } },
				options,
			);
			expect(facts[0]?.kind).toBe("provider.prisma.database.adopted");
			expect(facts).toHaveLength(2);
			expect(JSON.stringify(facts)).not.toContain(record.projectId);
		}
	});
});
