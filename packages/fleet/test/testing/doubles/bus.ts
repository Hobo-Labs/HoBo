/**
 * Authority buses broken in exactly one way each, keyed by the bus assertion
 * that must catch the break. Each wraps the in-memory bus.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type FleetRecord,
	FleetRecordSchema,
	type MemberRecord,
	MemberRecordSchema,
	type SignedEnvelope,
} from "../../../src/_generated/fleet_pb.js";
import type { FleetId, MemberId } from "../../../src/ids.js";
import type {
	AuthorityBus,
	KeyedEnvelope,
	RegistryView,
	Subscription,
} from "../../../src/ports.js";
import type { BusMake } from "../../../src/testing/conformance/bus.js";
import { createMemoryBus } from "../../../src/testing/plumbing/index.js";

type Patch = (base: AuthorityBus) => Partial<AuthorityBus>;

const broken =
	(patch: Patch): BusMake =>
	async () => {
		const base = createMemoryBus(Date.now);
		return { ...base, ...patch(base) };
	};

const all = (subscriptions: readonly Subscription[]): Subscription => ({
	async stop() {
		await Promise.all(subscriptions.map((entry) => entry.stop()));
	},
});

type Checks = Readonly<{ expiry: boolean; sequence: boolean }>;

/**
 * A registry over the raw envelopes the publisher was given, checking only
 * what `checks` says; everything not overridden comes from the base view.
 */
function rawRegistry(
	base: AuthorityBus,
	member: Checks,
	fleet: Checks,
): Partial<AuthorityBus> {
	const members = new Map<string, SignedEnvelope>();
	const fleets = new Map<string, SignedEnvelope>();
	const highest = new Map<string, number>();
	const serve = <T>(
		key: string,
		record: T | undefined,
		checks: Checks,
		notAfter: (value: T) => string,
		sequence: (value: T) => number,
	): T | undefined => {
		if (record === undefined) return undefined;
		if (checks.expiry && Date.now() > Date.parse(notAfter(record)))
			return undefined;
		if (checks.sequence && sequence(record) < (highest.get(key) ?? 0))
			return undefined;
		highest.set(key, Math.max(highest.get(key) ?? 0, sequence(record)));
		return record;
	};
	const registry: RegistryView = {
		...base.registry,
		async member(id) {
			const envelope = members.get(id);
			const record: MemberRecord | undefined =
				envelope === undefined
					? undefined
					: fromBinary(MemberRecordSchema, envelope.payload);
			return serve(
				`member.${id}`,
				record,
				member,
				(value) => value.notAfter,
				(value) => value.recordSequence,
			);
		},
		async fleet(id) {
			const envelope = fleets.get(id);
			const record: FleetRecord | undefined =
				envelope === undefined
					? undefined
					: fromBinary(FleetRecordSchema, envelope.payload);
			return serve(
				`fleet.${id}`,
				record,
				fleet,
				(value) => value.notAfter,
				(value) => value.revision,
			);
		},
	};
	return {
		registry,
		publisher: {
			...base.publisher,
			async putMember(record, id) {
				members.set(id, record);
				await base.publisher.putMember(record, id);
			},
			async putFleet(record, id) {
				fleets.set(id, record);
				await base.publisher.putFleet(record, id);
			},
		},
	};
}

const CHECKED: Checks = { expiry: true, sequence: true };

export const BROKEN_BUSES: ReadonlyMap<string, BusMake> = new Map([
	[
		"the registry serves a published member record",
		broken((base) => ({
			registry: {
				...base.registry,
				async member(id) {
					const record = await base.registry.member(id);
					// Off by one: a record at sequence 1 is never served.
					return record !== undefined && record.recordSequence > 1
						? record
						: undefined;
				},
			},
		})),
	],
	[
		"the registry refuses a member record past its not_after",
		broken((base) =>
			rawRegistry(base, { expiry: false, sequence: true }, CHECKED),
		),
	],
	[
		"the registry refuses a member record with a lower record_sequence than it has returned",
		broken((base) =>
			rawRegistry(base, { expiry: true, sequence: false }, CHECKED),
		),
	],
	[
		"the registry serves a published fleet record and its members",
		broken((base) => ({
			registry: {
				...base.registry,
				membersOf: () => base.registry.members(),
			},
		})),
	],
	[
		"the registry refuses a fleet record past its not_after",
		broken((base) =>
			rawRegistry(base, CHECKED, { expiry: false, sequence: true }),
		),
	],
	[
		"the registry refuses a fleet record with a lower revision than it has returned",
		broken((base) =>
			rawRegistry(base, CHECKED, { expiry: true, sequence: false }),
		),
	],
	[
		"the claim ledger lets the first writer win",
		broken((base) => ({
			claims: {
				...base.claims,
				async claim(claim, fleet, digest) {
					await base.claims.claim(claim, fleet, digest);
					return "claimed";
				},
			},
		})),
	],
	[
		"remove frees a claim for the next writer",
		broken((base) => ({
			claims: { ...base.claims, async remove() {} },
		})),
	],
	[
		"offers arrive in publish order with increasing sequences, only for subscribed fleets",
		broken((base) => {
			const published = new Set<FleetId>();
			return {
				offers: {
					async publish(offer, fleet) {
						published.add(fleet);
						await base.offers.publish(offer, fleet);
					},
					subscribe(fleets, from, handler) {
						return base.offers.subscribe(
							[...fleets, ...published],
							from,
							handler,
						);
					},
				},
			};
		}),
	],
	[
		"a subscription from { after } resumes after that sequence",
		broken((base) => ({
			offers: {
				...base.offers,
				subscribe(fleets, from, handler) {
					return base.offers.subscribe(
						fleets,
						from === "new" ? "new" : "start",
						handler,
					);
				},
			},
		})),
	],
	[
		'a subscription from "new" skips retained messages',
		broken((base) => ({
			offers: {
				...base.offers,
				subscribe(fleets, from, handler) {
					return base.offers.subscribe(
						fleets,
						from === "new" ? "start" : from,
						handler,
					);
				},
			},
		})),
	],
	[
		"orders reach only their addressee",
		broken((base) => {
			const addressees = new Set<MemberId>();
			return {
				orders: {
					...base.orders,
					async deliver(order, to) {
						addressees.add(to);
						await base.orders.deliver(order, to);
					},
					subscribe(self, from, handler) {
						return all(
							[...new Set([self, ...addressees])].map((member) =>
								base.orders.subscribe(member, from, handler),
							),
						);
					},
				},
			};
		}),
	],
	[
		"events are filtered by kind",
		broken((base) => {
			const kinds = new Set<string>();
			return {
				events: {
					async publish(event, from, kind) {
						kinds.add(kind);
						await base.events.publish(event, from, kind);
					},
					subscribe(wanted, from, handler) {
						return base.events.subscribe(
							[...new Set([...wanted, ...kinds])],
							from,
							handler,
						);
					},
				},
			};
		}),
	],
	[
		"control messages reach only their addressee",
		broken((base) => {
			const addressees = new Set<MemberId>();
			return {
				control: {
					async send(control, to) {
						addressees.add(to);
						await base.control.send(control, to);
					},
					subscribe(self, from, handler) {
						return all(
							[...new Set([self, ...addressees])].map((member) =>
								base.control.subscribe(member, from, handler),
							),
						);
					},
				},
			};
		}),
	],
	[
		"relay frames reach only their addressee, with their session id",
		broken((base) => {
			const listeners = new Set<MemberId>();
			return {
				relay: {
					async send(_to, sessionId, frame) {
						for (const member of listeners)
							await base.relay.send(member, sessionId, frame);
					},
					subscribe(self, handler) {
						listeners.add(self);
						return base.relay.subscribe(self, handler);
					},
				},
			};
		}),
	],
	[
		"observations keep the latest per observer and member",
		broken(() => {
			const kept: KeyedEnvelope[] = [];
			return {
				observations: {
					async publish(envelope, observerId, memberId) {
						kept.push({ observerId, memberId, envelope });
					},
					async read(limit) {
						return {
							observations: kept.slice(0, limit),
							capped: kept.length > limit,
						};
					},
				},
			};
		}),
	],
	[
		"the replay store answers firstUse once per id",
		broken(() => ({
			replay: {
				async firstUse() {
					return true;
				},
			},
		})),
	],
	[
		"a stopped subscription receives nothing more",
		broken((base) => ({
			offers: {
				...base.offers,
				subscribe(fleets, from, handler) {
					base.offers.subscribe(fleets, from, handler);
					return { async stop() {} };
				},
			},
		})),
	],
	[
		"close reports the bus closed",
		broken(() => ({
			status: () => "connected",
		})),
	],
]);
