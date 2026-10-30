import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createPrismaClient,
} from "../src/client.js";
import { createPrismaClaimableDatabaseDriver } from "../src/driver.js";
import {
	createStubCustody,
	createStubRunner,
	FIXTURE_NOW_MS,
	fixture,
	stdout,
} from "./harness.js";

describe("Prisma requested region binding", () => {
	it("preserves an unexpected allocation privately and refuses both fresh and adopted foreign regions", async () => {
		const runner = createStubRunner([stdout(fixture("create.success.json"))]);
		const store = createInMemoryIdempotencyStore();
		const custody = createStubCustody();
		const clock = () => FIXTURE_NOW_MS;
		const driver = createPrismaClaimableDatabaseDriver({
			client: createPrismaClient({ runner, store, clock }),
			custody,
			clock,
		});
		const input = {
			resourceRef: "hobo://test/region-bound-database",
			idempotencyKey: "private-region-bound-key",
			region: "eu-west-3" as const,
		};
		await expect(driver.provision(input)).rejects.toMatchObject({
			code: "PROVISIONING_CONFLICT",
			message:
				"the provider returned a different region than requested; allocation remains in private custody",
		});
		expect(custody.deposits).toHaveLength(1);
		expect(await store.get(input.idempotencyKey)).toMatchObject({
			state: "created",
			snapshot: { region: "us-east-1" },
		});
		await expect(driver.provision(input)).rejects.toMatchObject({
			code: "PROVISIONING_CONFLICT",
			message:
				"the private resource snapshot reports a different region than requested",
		});
		expect(runner.runs).toHaveLength(1);
	});
});
