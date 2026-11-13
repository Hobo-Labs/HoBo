/**
 * O5, revocation meets its service level, in the form that holds without
 * assumptions A3 and A4 (neither verified in this lane; see the README):
 * live readers see a revoked device within 5 s; the revoked device's next
 * connection is refused; and once the executor scoped signing key is removed
 * from the tenant account and the account pushed (§6.16), no new executor
 * connection is authorised. No bound is asserted for a live connection.
 */
import { MemberState, Role } from "@hobo/fleet";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintAccount, tenantKeys } from "../src/bus/nats-jwt.js";
import { pushAccount } from "../src/bus/resolver.js";
import { type Integration, startIntegration } from "./support/integration.js";
import {
	requireBinary,
	SKIP_INTEGRATION,
	startNats,
	type TestNats,
} from "./support/nats-server.js";

const READER_BOUND_MS = 5_000;

async function within(
	ms: number,
	ready: () => Promise<boolean>,
): Promise<number> {
	const started = Date.now();
	for (;;) {
		if (await ready()) return Date.now() - started;
		if (Date.now() - started > ms) throw new Error(`not within ${ms} ms`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe.skipIf(SKIP_INTEGRATION)(
	"O5: revocation meets its service level",
	() => {
		let nats: TestNats | undefined;
		let integration: Integration | undefined;
		beforeAll(async () => {
			requireBinary();
			nats = await startNats();
			integration = await startIntegration(nats);
		}, 60_000);
		afterAll(async () => {
			await integration?.close();
			await nats?.stop();
		});
		const ready = (): Integration => {
			if (integration === undefined)
				throw new Error("nats-server did not start");
			return integration;
		};

		it("shows a revoked device to live readers within 5 s and refuses its next connection", async () => {
			const fleet = ready();
			const reader = await fleet.connect(await fleet.device([Role.DISPATCHER]));
			const target = await fleet.device([Role.EXECUTOR]);
			await fleet.connect(target);
			expect((await reader.registry.member(target.memberId))?.state).toBe(
				MemberState.ACTIVE,
			);
			await fleet.tenant.update(target.memberId, (record) => {
				record.state = MemberState.REVOKED;
			});
			const took = await within(READER_BOUND_MS, async () => {
				const record = await reader.registry.member(target.memberId);
				return record?.state === MemberState.REVOKED;
			});
			expect(took).toBeLessThanOrEqual(READER_BOUND_MS);
			await expect(fleet.connect(target)).rejects.toThrow();
			expect(fleet.refusals).toContain("not-active");
		}, 60_000);

		it("authorises no new executor connection once the executor scoped key is removed", async () => {
			const fleet = ready();
			const server = fleet.nats;
			const executor = await fleet.device([Role.EXECUTOR]);
			const observer = await fleet.device([Role.OBSERVER]);
			await fleet.connect(executor);
			const keys = tenantKeys(server.operatorSigningSeed, server.tenant);
			await pushAccount(
				[server.url],
				server.operatorSigningSeed,
				await mintAccount(keys, server.tenant, server.operatorSigningSeed, [
					"observer",
					"dispatcher",
				]),
			);
			await expect(fleet.connect(executor)).rejects.toThrow();
			const bus = await fleet.connect(observer);
			expect(bus.status()).toBe("connected");
			await pushAccount(
				[server.url],
				server.operatorSigningSeed,
				await mintAccount(keys, server.tenant, server.operatorSigningSeed),
			);
		}, 60_000);
	},
);
