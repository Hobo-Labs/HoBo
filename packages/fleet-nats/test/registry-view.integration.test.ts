/**
 * O5 (registry part): a device's registry view over the real bus verifies
 * every record against its pinned trust; a view refuses a record with a lower
 * `record_sequence` than it has seen, even when whoever controls the bus
 * writes it back, and a restarted view refuses a record past its `not_after`.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type MemberId,
	MemberState,
	Role,
	type SignedEnvelope,
	SignedEnvelopeSchema,
} from "@hobo/fleet";
import { credsAuthenticator } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { open } from "../src/bus/connection.js";
import { BUCKETS, keys } from "../src/bus/names.js";
import { natsWire } from "../src/bus/nats-wire.js";
import { type Integration, startIntegration } from "./support/integration.js";
import {
	requireBinary,
	SKIP_INTEGRATION,
	startNats,
	type TestNats,
} from "./support/nats-server.js";

const MINUTE = 60_000;

/** The envelope stored for `memberId` right now, read with the authority's credentials. */
async function stored(
	fleet: Integration,
	memberId: MemberId,
): Promise<SignedEnvelope> {
	const connection = await open({
		servers: [fleet.nats.url],
		authenticator: credsAuthenticator(
			new TextEncoder().encode(
				fleet.nats.provisioned.staticCredentials.authority,
			),
		),
		name: "registry-snapshot",
		persistent: false,
	});
	try {
		const wire = natsWire(connection, {
			consumerName: () => "registry-snapshot",
		});
		const bytes = await wire.kvGet(BUCKETS.registry, keys.member(memberId));
		if (bytes === undefined) throw new Error("no record");
		return fromBinary(SignedEnvelopeSchema, bytes);
	} finally {
		await connection.close();
	}
}

describe.skipIf(SKIP_INTEGRATION)(
	"O5: the registry view on nats-server",
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

		it("refuses a rolled-back record, and a restarted view refuses an expired one", async () => {
			const fleet = ready();
			const target = await fleet.device([Role.EXECUTOR]);
			const reader = await fleet.device([Role.OBSERVER]);
			const first = await fleet.connect(reader);
			expect(
				(await first.registry.member(target.memberId))?.recordSequence,
			).toBe(1);

			const stale = await stored(fleet, target.memberId);
			await fleet.tenant.update(target.memberId, (record) => {
				record.displayName = "renamed";
			});
			expect(
				(await first.registry.member(target.memberId))?.recordSequence,
			).toBe(2);
			// Written back as anyone able to write the bucket could.
			await fleet.authority.publisher.putMember(stale, target.memberId);
			expect(await first.registry.member(target.memberId)).toBeUndefined();

			await fleet.tenant.update(target.memberId, (record) => {
				record.notAfter = new Date(Date.now() - MINUTE).toISOString();
				record.state = MemberState.ACTIVE;
			});
			await first.close();
			const restarted = await fleet.connect(reader);
			expect(await restarted.registry.member(target.memberId)).toBeUndefined();
		}, 60_000);
	},
);
