/**
 * The witness over the real bus (§6.14, §6.7): on `nats-server`, the authority
 * appends a checkpoint with its audit chain, the witness (`createWitness` on
 * its own connection, opened with the static `witness` user's credentials)
 * reads the entries itself and co-signs on `fleet.audit.witness`, and the
 * authority's `onWitnessed` hands back the witnessed checkpoint. The same for
 * a proposed trust record and `onTrustWitnessed`. The witness user may
 * publish nothing but its one subject, and no other user may publish there.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AUDIT_CHECKPOINT_CONTEXT,
	type AuthorityBus,
	type SignedEnvelope,
	TRUST_RECORD_CONTEXT,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
} from "@hobo/fleet";
import { createAuditChain, createWitness } from "@hobo/fleet/audit";
import { signEnvelope, verifyWitnessed } from "@hobo/fleet/keys";
import { createMemoryEventStore } from "@hobo/fleet/testing";
import { credsAuthenticator } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { open } from "../src/bus/connection.js";
import { connectAuthorityBus } from "../src/bus/index.js";
import { AUDIT_SUBJECTS } from "../src/bus/names.js";
import { INCARNATION } from "./support/fixture.js";
import {
	type Integration,
	refused,
	startIntegration,
} from "./support/integration.js";
import {
	requireBinary,
	SKIP_INTEGRATION,
	startNats,
	type TestNats,
} from "./support/nats-server.js";

const encoder = new TextEncoder();
const actor = { kind: "service" as const, id: "fleet-witness-test" };

function pinnedOf(it: Integration): TrustRecord {
	const payload = it.tenant.trust.authority?.payload;
	if (payload === undefined) throw new Error("no trust record");
	return fromBinary(TrustRecordSchema, payload);
}

/** What `hobo-fleet-witness` does with a co-signature: append it to its own audit log. */
function publishOn(bus: AuthorityBus) {
	return (cosignature: SignedEnvelope, of: "checkpoint" | "trust") =>
		of === "checkpoint"
			? bus.audit.appendCheckpoint(cosignature)
			: bus.audit.proposeTrust(cosignature);
}

describe.skipIf(SKIP_INTEGRATION)("the witness on nats-server", () => {
	let nats: TestNats | undefined;
	let it_: Integration | undefined;
	let witnessBus: AuthorityBus | undefined;
	beforeAll(async () => {
		nats = await startNats();
		it_ = await startIntegration(nats);
		const integration = it_;
		witnessBus = await connectAuthorityBus({
			servers: [nats.url],
			credentials: nats.provisioned.staticCredentials.witness,
			trust: () => pinnedOf(integration),
			log: () => undefined,
		});
	}, 60_000);
	afterAll(async () => {
		await witnessBus?.close();
		await it_?.close();
		await nats?.stop();
	});

	it("has nats-server", () => {
		requireBinary();
	});

	it("co-signs the authority's checkpoint and a proposed trust record, and the authority sees both witnessed", async () => {
		if (it_ === undefined || witnessBus === undefined || nats === undefined)
			throw new Error("nats-server did not start");
		const integration = it_;
		const { authority, tenant } = integration;
		const pinned = pinnedOf(integration);
		let clock = Date.now();
		const store = createMemoryEventStore();
		const chain = createAuditChain({
			store,
			log: authority.audit,
			signer: tenant.authority,
			incarnation: INCARNATION,
			now: () => clock,
		});
		const witnessed: WitnessedEnvelope[] = [];
		const trusts: WitnessedEnvelope[] = [];
		const subscriptions = [
			authority.audit.onWitnessed(async (checkpoint) => {
				witnessed.push(checkpoint);
			}),
			authority.audit.onTrustWitnessed(async (trust) => {
				trusts.push(trust);
			}),
		];
		const refusals: string[] = [];
		const witness = createWitness({
			log: witnessBus.audit,
			registryChanges: () => ({ async stop() {} }),
			trust: () => pinned,
			signer: tenant.witness,
			publish: publishOn(witnessBus),
			now: Date.now,
			log2: (event, fields) =>
				refusals.push(`${event} ${String(fields.reason)}`),
		});
		witness.start();
		try {
			// The authority journals two events, then a checkpoint a minute later.
			await store.append(
				"fleet-work-a",
				[{ type: "fleet.WorkOffered" }, { type: "fleet.WorkClaimed" }],
				{ expectedSeq: 0, actor, tenant: nats.tenant },
			);
			await chain.tick();
			clock += 60_000;
			await chain.tick();
			await chain.tick();
			await expect
				.poll(() => witnessed.length, { timeout: 15_000, interval: 50 })
				.toBe(1);
			const [checkpoint] = witnessed;
			expect(
				checkpoint !== undefined &&
					verifyWitnessed(checkpoint, AUDIT_CHECKPOINT_CONTEXT, pinned),
			).toBe(true);
			expect(checkpoint?.witness?.keyId).toBe(tenant.witness.keyId);

			// A trust rotation: journaled as fleet.TrustRotated, then proposed.
			const next = toBinary(
				TrustRecordSchema,
				create(TrustRecordSchema, { ...pinned, sequence: pinned.sequence + 1 }),
			);
			await store.append(
				"fleet-trust",
				[
					{
						type: "fleet.TrustRotated",
						data: {
							record: Buffer.from(next).toString("base64"),
							sequence: pinned.sequence + 1,
							authorityIncarnation: INCARNATION,
							reason: "rotate:witness:publish",
						},
					},
				],
				{ expectedSeq: 0, actor, tenant: nats.tenant },
			);
			await chain.tick();
			await authority.audit.proposeTrust(
				await signEnvelope(tenant.authority, TRUST_RECORD_CONTEXT, next),
			);
			await expect
				.poll(() => trusts.length, { timeout: 15_000, interval: 50 })
				.toBe(1);
			expect(
				Buffer.from(trusts[0]?.witness?.payload ?? new Uint8Array()),
			).toEqual(Buffer.from(next));
			expect(refusals).toEqual([]);
		} finally {
			await witness.stop();
			for (const subscription of subscriptions) await subscription.stop();
		}
	}, 60_000);

	it("lets only the witness user publish on fleet.audit.witness, and the witness nothing else", async () => {
		if (nats === undefined) throw new Error("nats-server did not start");
		const connect = (credentials: string) =>
			open({
				servers: [nats?.url ?? ""],
				authenticator: credsAuthenticator(encoder.encode(credentials)),
				name: "probe",
				persistent: false,
			});
		const witness = await connect(nats.provisioned.staticCredentials.witness);
		const authority = await connect(
			nats.provisioned.staticCredentials.authority,
		);
		try {
			expect(await refused(authority, AUDIT_SUBJECTS.witness)).toBe(true);
			expect(await refused(witness, AUDIT_SUBJECTS.witness)).toBe(false);
			for (const subject of [
				AUDIT_SUBJECTS.entry,
				AUDIT_SUBJECTS.checkpoint,
				AUDIT_SUBJECTS.trust,
				"$KV.fleet-registry.trust",
			])
				expect(await refused(witness, subject)).toBe(true);
		} finally {
			await witness.close();
			await authority.close();
		}
	}, 30_000);
});
