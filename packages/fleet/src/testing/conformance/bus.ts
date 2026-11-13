/**
 * `runBusConformance` (design §7.3, O3–O5): what every `AuthorityBus` must do.
 *
 * - The registry serves what the publisher put, and refuses a record past its
 *   `not_after` and one whose `record_sequence` (member) or `revision` (fleet)
 *   is lower than the highest it has returned for that key (§7.4).
 * - The claim ledger lets the first writer win until a dispatcher removes it.
 * - Streams keep order and sequence numbers, filter by fleet, addressee or
 *   kind, and honour `BusStart`; a stopped subscription receives nothing.
 * - Observations keep the latest per observer and member; the replay store
 *   answers `firstUse` once; `close` reports the bus closed.
 *
 * Registry records are signed by an Ed25519 authority key the suite makes for
 * each bus, and a trust record naming it (co-signed by a suite witness key) is
 * published with `publisher.putTrust` before any record. An adapter whose view
 * verifies against a pinned trust record pins the one `putTrust` published.
 * Every id is random, so the suite runs against a server shared between runs.
 */
import { randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	CoordinationMode,
	FleetRecordSchema,
	KeyAlgorithm,
	KeyPurpose,
	MemberKind,
	MemberRecordSchema,
	MemberState,
	Role,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "../../_generated/fleet_pb.js";
import {
	CLAIM_CONTEXT,
	CONTROL_CONTEXT,
	FLEET_RECORD_CONTEXT,
	MEMBER_RECORD_CONTEXT,
	OBSERVATION_CONTEXT,
	OFFER_CONTEXT,
	ORDER_CONTEXT,
	RECEIPT_CONTEXT,
	TRUST_RECORD_CONTEXT,
} from "../../contexts.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseWorkDigest,
} from "../../ids.js";
import type { AuthorityBus, BusStart, Subscription } from "../../ports.js";
import {
	type ConformanceAssertion,
	ensure,
	eventually,
	pause,
} from "./assertion.js";
import {
	createSuiteKey,
	randomMemberId,
	type SuiteKey,
	signEnvelope,
} from "./crypto.js";

export type BusMake = () => Promise<AuthorityBus>;

const MINUTE = 60_000;
const WAIT_MS = 5_000;
/** How long a negative check waits for a message that must not come. */
const QUIET_MS = 100;
const TENANT = "conformance";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const randomFleet = (): FleetId =>
	parseFleetId(`cf-${randomBytes(8).toString("hex")}`);
const iso = (ms: number) => new Date(ms).toISOString();
const textOf = (envelope: SignedEnvelope) => decoder.decode(envelope.payload);

/** An opaque envelope whose payload is `marker`: streams carry envelopes without reading them. */
const marked = (context: string, marker: string): SignedEnvelope =>
	create(SignedEnvelopeSchema, {
		context,
		keyId: "authority#1",
		algorithm: KeyAlgorithm.EDDSA,
		payload: encoder.encode(marker),
		signature: randomBytes(64),
	});

type Authority = Readonly<{ bus: AuthorityBus; key: SuiteKey }>;

/** Makes a bus and publishes a trust record naming a fresh suite authority key. */
async function withAuthority(make: BusMake): Promise<Authority> {
	const bus = await make();
	const key = createSuiteKey("authority#1");
	const witness = createSuiteKey("witness#1");
	const payload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant: TENANT,
			sequence: 1,
			authorityKeys: [
				{
					purpose: KeyPurpose.AUTHORITY,
					keyId: "authority#1",
					algorithm: KeyAlgorithm.EDDSA,
					value: key.publicJwk,
				},
			],
			witnessKeys: [
				{
					purpose: KeyPurpose.WITNESS,
					keyId: "witness#1",
					algorithm: KeyAlgorithm.EDDSA,
					value: witness.publicJwk,
				},
			],
			authorityIncarnation: 1,
			issuer: "https://conformance.invalid",
			jwksUri: "https://conformance.invalid/.well-known/jwks.json",
			issuedAt: iso(Date.now()),
		}),
	);
	await bus.publisher.putTrust(
		create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(key.signer, TRUST_RECORD_CONTEXT, payload),
			witness: await signEnvelope(
				witness.signer,
				TRUST_RECORD_CONTEXT,
				payload,
			),
		}),
	);
	return { bus, key };
}

async function putMember(
	authority: Authority,
	id: MemberId,
	recordSequence: number,
	notAfterMs: number,
	fleet: FleetId,
): Promise<void> {
	const now = Date.now();
	const record = create(MemberRecordSchema, {
		memberId: id,
		tenant: TENANT,
		kind: MemberKind.DEVICE,
		displayName: `conformance ${recordSequence}`,
		state: MemberState.ACTIVE,
		memberships: [
			{
				fleet,
				name: `m-${id.slice(-8)}`,
				roles: [Role.EXECUTOR],
				joinedAt: iso(now),
			},
		],
		recordSequence,
		authorityIncarnation: 1,
		issuedAt: iso(Math.min(now, notAfterMs - MINUTE)),
		notAfter: iso(notAfterMs),
	});
	await authority.bus.publisher.putMember(
		await signEnvelope(
			authority.key.signer,
			MEMBER_RECORD_CONTEXT,
			toBinary(MemberRecordSchema, record),
		),
		id,
	);
}

async function putFleet(
	authority: Authority,
	id: FleetId,
	revision: number,
	notAfterMs: number,
): Promise<void> {
	const now = Date.now();
	const record = create(FleetRecordSchema, {
		fleetId: id,
		tenant: TENANT,
		owner: "user:conformance",
		coordination: CoordinationMode.MANY_ACTIVE,
		revision,
		updatedAt: iso(now),
		updatedBy: "user:conformance",
		issuedAt: iso(Math.min(now, notAfterMs - MINUTE)),
		notAfter: iso(notAfterMs),
	});
	await authority.bus.publisher.putFleet(
		await signEnvelope(
			authority.key.signer,
			FLEET_RECORD_CONTEXT,
			toBinary(FleetRecordSchema, record),
		),
		id,
	);
}

type Received = { markers: string[]; sequences: number[] };
/** What one offer subscription has delivered so far, and how to stop it. */
type Collected = Readonly<{ received: Received; subscription: Subscription }>;

/** Subscribes the offer feed and collects what arrives. */
function collectOffers(
	bus: AuthorityBus,
	fleets: readonly FleetId[],
	from: BusStart,
): Collected {
	const received: Received = { markers: [], sequences: [] };
	const subscription = bus.offers.subscribe(
		fleets,
		from,
		async (offer, sequence) => {
			received.markers.push(textOf(offer));
			received.sequences.push(sequence);
		},
	);
	return { received, subscription };
}

async function within<T>(
	bus: AuthorityBus,
	run: (bus: AuthorityBus) => Promise<T>,
): Promise<T> {
	try {
		return await run(bus);
	} finally {
		if (bus.status() !== "closed") await bus.close();
	}
}

/** The bus assertions, in the order they are registered. */
export const BUS_ASSERTIONS: readonly ConformanceAssertion<BusMake>[] = [
	{
		name: "the registry serves a published member record",
		async check(make) {
			const authority = await withAuthority(make);
			await within(authority.bus, async (bus) => {
				const id = randomMemberId();
				await putMember(
					authority,
					id,
					1,
					Date.now() + 20 * MINUTE,
					randomFleet(),
				);
				await bus.registry.caughtUp();
				const record = await bus.registry.member(id);
				ensure(
					record !== undefined,
					"a published member record was not served",
				);
				ensure(
					record.memberId === id && record.recordSequence === 1,
					"the registry served another member record",
				);
			});
		},
	},
	{
		name: "the registry refuses a member record past its not_after",
		async check(make) {
			const authority = await withAuthority(make);
			await within(authority.bus, async (bus) => {
				const id = randomMemberId();
				await putMember(authority, id, 1, Date.now() - MINUTE, randomFleet());
				await bus.registry.caughtUp();
				ensure(
					(await bus.registry.member(id)) === undefined,
					"the registry served a member record past its not_after",
				);
			});
		},
	},
	{
		name: "the registry refuses a member record with a lower record_sequence than it has returned",
		async check(make) {
			const authority = await withAuthority(make);
			await within(authority.bus, async (bus) => {
				const id = randomMemberId();
				const fleet = randomFleet();
				const notAfter = Date.now() + 20 * MINUTE;
				await putMember(authority, id, 2, notAfter, fleet);
				await bus.registry.caughtUp();
				const first = await bus.registry.member(id);
				ensure(
					first?.recordSequence === 2,
					"the record at sequence 2 was not served",
				);
				await putMember(authority, id, 1, notAfter, fleet);
				await bus.registry.caughtUp();
				const second = await bus.registry.member(id);
				ensure(
					second === undefined || second.recordSequence >= 2,
					"the registry served a member record older than one it had returned",
				);
			});
		},
	},
	{
		name: "the registry serves a published fleet record and its members",
		async check(make) {
			const authority = await withAuthority(make);
			await within(authority.bus, async (bus) => {
				const fleet = randomFleet();
				const member = randomMemberId();
				const notAfter = Date.now() + 20 * MINUTE;
				await putFleet(authority, fleet, 1, notAfter);
				await putMember(authority, member, 1, notAfter, fleet);
				await putMember(
					authority,
					randomMemberId(),
					1,
					notAfter,
					randomFleet(),
				);
				await bus.registry.caughtUp();
				const record = await bus.registry.fleet(fleet);
				ensure(
					record?.fleetId === fleet && record.revision === 1,
					"a published fleet record was not served",
				);
				const members = await bus.registry.membersOf(fleet);
				ensure(
					members.map((entry) => entry.memberId).join(",") === member,
					"membersOf did not answer exactly the fleet's member",
				);
			});
		},
	},
	{
		name: "the registry refuses a fleet record past its not_after",
		async check(make) {
			const authority = await withAuthority(make);
			await within(authority.bus, async (bus) => {
				const fleet = randomFleet();
				await putFleet(authority, fleet, 1, Date.now() - MINUTE);
				await bus.registry.caughtUp();
				ensure(
					(await bus.registry.fleet(fleet)) === undefined,
					"the registry served a fleet record past its not_after",
				);
			});
		},
	},
	{
		name: "the registry refuses a fleet record with a lower revision than it has returned",
		async check(make) {
			const authority = await withAuthority(make);
			await within(authority.bus, async (bus) => {
				const fleet = randomFleet();
				const notAfter = Date.now() + 20 * MINUTE;
				await putFleet(authority, fleet, 3, notAfter);
				await bus.registry.caughtUp();
				ensure(
					(await bus.registry.fleet(fleet))?.revision === 3,
					"the fleet record at revision 3 was not served",
				);
				await putFleet(authority, fleet, 2, notAfter);
				await bus.registry.caughtUp();
				const second = await bus.registry.fleet(fleet);
				ensure(
					second === undefined || second.revision >= 3,
					"the registry served a fleet record older than one it had returned",
				);
			});
		},
	},
	{
		name: "the claim ledger lets the first writer win",
		async check(make) {
			await within(await make(), async (bus) => {
				const fleet = randomFleet();
				const digest = parseWorkDigest(randomBytes(16).toString("hex"));
				const first = await bus.claims.claim(
					marked(CLAIM_CONTEXT, "first"),
					fleet,
					digest,
				);
				const second = await bus.claims.claim(
					marked(CLAIM_CONTEXT, "second"),
					fleet,
					digest,
				);
				ensure(first === "claimed", `the first claim answered ${first}`);
				ensure(second === "held", `the second claim answered ${second}`);
				const holder = await bus.claims.holder(fleet, digest);
				ensure(
					holder !== undefined && textOf(holder) === "first",
					"the holder is not the first writer",
				);
				const other = await bus.claims.claim(
					marked(CLAIM_CONTEXT, "other"),
					fleet,
					parseWorkDigest(randomBytes(16).toString("hex")),
				);
				ensure(other === "claimed", "a claim on another digest was held");
			});
		},
	},
	{
		name: "remove frees a claim for the next writer",
		async check(make) {
			await within(await make(), async (bus) => {
				const fleet = randomFleet();
				const digest = parseWorkDigest(randomBytes(16).toString("hex"));
				await bus.claims.claim(marked(CLAIM_CONTEXT, "first"), fleet, digest);
				await bus.claims.remove(fleet, digest);
				ensure(
					(await bus.claims.holder(fleet, digest)) === undefined,
					"a removed claim still has a holder",
				);
				const next = await bus.claims.claim(
					marked(CLAIM_CONTEXT, "next"),
					fleet,
					digest,
				);
				ensure(next === "claimed", `a claim after remove answered ${next}`);
			});
		},
	},
	{
		name: "offers arrive in publish order with increasing sequences, only for subscribed fleets",
		async check(make) {
			await within(await make(), async (bus) => {
				const fleet = randomFleet();
				const other = randomFleet();
				await bus.offers.publish(marked(OFFER_CONTEXT, "o1"), fleet);
				await bus.offers.publish(marked(OFFER_CONTEXT, "x1"), other);
				await bus.offers.publish(marked(OFFER_CONTEXT, "o2"), fleet);
				await bus.offers.publish(marked(OFFER_CONTEXT, "o3"), fleet);
				const { received, subscription } = collectOffers(bus, [fleet], "start");
				try {
					await eventually(
						() => received.markers.length >= 3,
						WAIT_MS,
						`offers delivered ${received.markers.length} of 3`,
					);
					await pause(QUIET_MS);
				} finally {
					await subscription.stop();
				}
				ensure(
					received.markers.join(",") === "o1,o2,o3",
					`offers arrived as ${received.markers.join(",")}, want o1,o2,o3`,
				);
				ensure(
					received.sequences.every(
						(sequence, index) =>
							sequence > 0 &&
							(index === 0 || sequence > (received.sequences[index - 1] ?? 0)),
					),
					`offer sequences ${received.sequences.join(",")} do not increase`,
				);
			});
		},
	},
	{
		name: "a subscription from { after } resumes after that sequence",
		async check(make) {
			await within(await make(), async (bus) => {
				const fleet = randomFleet();
				for (const marker of ["o1", "o2", "o3"])
					await bus.offers.publish(marked(OFFER_CONTEXT, marker), fleet);
				const all = collectOffers(bus, [fleet], "start");
				await eventually(
					() => all.received.markers.length >= 3,
					WAIT_MS,
					"offers from start were not delivered",
				);
				await all.subscription.stop();
				const after = all.received.sequences[0] ?? 0;
				const rest = collectOffers(bus, [fleet], { after });
				try {
					await eventually(
						() => rest.received.markers.length >= 2,
						WAIT_MS,
						`a subscription after ${after} delivered ${rest.received.markers.length} of 2`,
					);
					await pause(QUIET_MS);
				} finally {
					await rest.subscription.stop();
				}
				ensure(
					rest.received.markers.join(",") === "o2,o3",
					`a subscription after the first offer delivered ${rest.received.markers.join(",")}`,
				);
			});
		},
	},
	{
		name: 'a subscription from "new" skips retained messages',
		async check(make) {
			await within(await make(), async (bus) => {
				const fleet = randomFleet();
				await bus.offers.publish(marked(OFFER_CONTEXT, "old"), fleet);
				const fresh = collectOffers(bus, [fleet], "new");
				try {
					await pause(QUIET_MS);
					await bus.offers.publish(marked(OFFER_CONTEXT, "new"), fleet);
					await eventually(
						() => fresh.received.markers.includes("new"),
						WAIT_MS,
						'a subscription from "new" missed a new offer',
					);
					await pause(QUIET_MS);
				} finally {
					await fresh.subscription.stop();
				}
				ensure(
					fresh.received.markers.join(",") === "new",
					`a subscription from "new" delivered ${fresh.received.markers.join(",")}`,
				);
			});
		},
	},
	{
		name: "orders reach only their addressee",
		async check(make) {
			await within(await make(), async (bus) => {
				const self = randomMemberId();
				await bus.orders.deliver(
					marked(ORDER_CONTEXT, "elsewhere"),
					randomMemberId(),
				);
				await bus.orders.deliver(marked(ORDER_CONTEXT, "mine"), self);
				const received: string[] = [];
				const subscription = bus.orders.subscribe(
					self,
					"start",
					async (order) => {
						received.push(textOf(order));
					},
				);
				try {
					await eventually(
						() => received.length >= 1,
						WAIT_MS,
						"an order did not reach its addressee",
					);
					await pause(QUIET_MS);
				} finally {
					await subscription.stop();
				}
				ensure(
					received.join(",") === "mine",
					`the addressee received ${received.join(",")}`,
				);
			});
		},
	},
	{
		name: "events are filtered by kind",
		async check(make) {
			await within(await make(), async (bus) => {
				const from = randomMemberId();
				await bus.events.publish(marked(RECEIPT_CONTEXT, "log"), from, "log");
				await bus.events.publish(
					marked(RECEIPT_CONTEXT, "receipt"),
					from,
					"receipt",
				);
				const received: string[] = [];
				const subscription = bus.events.subscribe(
					["receipt"],
					"start",
					async (event, member, kind) => {
						if (member === from) received.push(`${kind}:${textOf(event)}`);
					},
				);
				try {
					await eventually(
						() => received.length >= 1,
						WAIT_MS,
						"an event of the subscribed kind was not delivered",
					);
					await pause(QUIET_MS);
				} finally {
					await subscription.stop();
				}
				ensure(
					received.join(",") === "receipt:receipt",
					`a receipt subscription delivered ${received.join(",")}`,
				);
			});
		},
	},
	{
		name: "control messages reach only their addressee",
		async check(make) {
			await within(await make(), async (bus) => {
				const self = randomMemberId();
				await bus.control.send(
					marked(CONTROL_CONTEXT, "elsewhere"),
					randomMemberId(),
				);
				await bus.control.send(marked(CONTROL_CONTEXT, "mine"), self);
				const received: string[] = [];
				const subscription = bus.control.subscribe(
					self,
					"start",
					async (control) => {
						received.push(textOf(control));
					},
				);
				try {
					await eventually(
						() => received.length >= 1,
						WAIT_MS,
						"a control message did not reach its addressee",
					);
					await pause(QUIET_MS);
				} finally {
					await subscription.stop();
				}
				ensure(
					received.join(",") === "mine",
					`the addressee received ${received.join(",")}`,
				);
			});
		},
	},
	{
		name: "relay frames reach only their addressee, with their session id",
		async check(make) {
			await within(await make(), async (bus) => {
				const self = randomMemberId();
				const other = randomMemberId();
				const received: string[] = [];
				const subscription = bus.relay.subscribe(
					self,
					async (sessionId, frame) => {
						received.push(`${sessionId}:${decoder.decode(frame)}`);
					},
				);
				try {
					await pause(QUIET_MS);
					await bus.relay.send(other, "s-other", encoder.encode("elsewhere"));
					await bus.relay.send(self, "s-mine", encoder.encode("mine"));
					await eventually(
						() => received.length >= 1,
						WAIT_MS,
						"a relay frame did not reach its addressee",
					);
					await pause(QUIET_MS);
				} finally {
					await subscription.stop();
				}
				ensure(
					received.join(",") === "s-mine:mine",
					`the addressee received ${received.join(",")}`,
				);
			});
		},
	},
	{
		name: "observations keep the latest per observer and member",
		async check(make) {
			await within(await make(), async (bus) => {
				const observer = randomMemberId();
				const member = randomMemberId();
				const second = randomMemberId();
				await bus.observations.publish(
					marked(OBSERVATION_CONTEXT, "a1"),
					observer,
					member,
				);
				await bus.observations.publish(
					marked(OBSERVATION_CONTEXT, "a2"),
					observer,
					member,
				);
				await bus.observations.publish(
					marked(OBSERVATION_CONTEXT, "b1"),
					observer,
					second,
				);
				const { observations } = await bus.observations.read(100_000);
				const mine = observations
					.filter((entry) => entry.observerId === observer)
					.map(
						(entry) =>
							`${entry.memberId === member ? "a" : "b"}:${textOf(entry.envelope)}`,
					)
					.sort();
				ensure(
					mine.join(",") === "a:a2,b:b1",
					`observations read back as ${mine.join(",")}, want a:a2,b:b1`,
				);
			});
		},
	},
	{
		name: "the replay store answers firstUse once per id",
		async check(make) {
			await within(await make(), async (bus) => {
				const id = randomBytes(8).toString("hex");
				const until = Date.now() + MINUTE;
				const first = await bus.replay.firstUse("conformance", id, until);
				const again = await bus.replay.firstUse("conformance", id, until);
				const other = await bus.replay.firstUse(
					"conformance",
					`${id}-2`,
					until,
				);
				ensure(first, "the first use of an id was refused");
				ensure(!again, "a second use of an id was accepted");
				ensure(other, "the first use of another id was refused");
			});
		},
	},
	{
		name: "a stopped subscription receives nothing more",
		async check(make) {
			await within(await make(), async (bus) => {
				const fleet = randomFleet();
				await bus.offers.publish(marked(OFFER_CONTEXT, "before"), fleet);
				const stopped = collectOffers(bus, [fleet], "start");
				await eventually(
					() => stopped.received.markers.length >= 1,
					WAIT_MS,
					"an offer was not delivered",
				);
				await stopped.subscription.stop();
				await bus.offers.publish(marked(OFFER_CONTEXT, "after"), fleet);
				const witness = collectOffers(bus, [fleet], "start");
				try {
					await eventually(
						() => witness.received.markers.includes("after"),
						WAIT_MS,
						"the offer published after stop was not delivered anywhere",
					);
					await pause(QUIET_MS);
				} finally {
					await witness.subscription.stop();
				}
				ensure(
					stopped.received.markers.join(",") === "before",
					`a stopped subscription received ${stopped.received.markers.join(",")}`,
				);
			});
		},
	},
	{
		name: "close reports the bus closed",
		async check(make) {
			const bus = await make();
			ensure(bus.status() === "connected", `a new bus reports ${bus.status()}`);
			await bus.close();
			ensure(bus.status() === "closed", `a closed bus reports ${bus.status()}`);
		},
	},
];
