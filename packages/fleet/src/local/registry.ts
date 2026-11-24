import { create, fromBinary } from "@bufbuild/protobuf";
import type { TenantId } from "@hobo/core";
import {
	type FleetRecord,
	FleetRecordSchema,
	type MemberRecord,
	MemberRecordSchema,
	type TrustRecord,
	TrustRecordSchema,
} from "../_generated/fleet_pb.js";
import type { FleetId, MemberId } from "../ids.js";
import type { RegistryPublisher, RegistryView } from "../ports.js";

export type LocalRegistry = Readonly<{
	view: RegistryView;
	publisher: RegistryPublisher;
}>;

export function createLocalRegistry(tenant: TenantId): LocalRegistry {
	const members = new Map<string, MemberRecord>();
	const fleets = new Map<string, FleetRecord>();
	const trust = create(TrustRecordSchema, { tenant });

	const view: RegistryView = {
		async member(id: MemberId) {
			return members.get(id);
		},
		async fleet(id: FleetId) {
			return fleets.get(id);
		},
		async membersOf(id: FleetId) {
			return [...members.values()].filter((record) =>
				record.memberships.some((membership) => membership.fleet === id),
			);
		},
		async fleets() {
			return [...fleets.values()];
		},
		async members() {
			return [...members.values()];
		},
		async view() {
			return undefined;
		},
		trust(): TrustRecord {
			return trust;
		},
		trustEnvelope() {
			return undefined;
		},
		async caughtUp() {},
	};

	const publisher: RegistryPublisher = {
		async putMember(record) {
			const decoded = fromBinary(MemberRecordSchema, record.payload);
			const next = create(MemberRecordSchema, {
				...decoded,
				issuedAt: "",
				notAfter: "",
				authorityIncarnation: 0,
			});
			const held = members.get(next.memberId);
			if (held === undefined || held.recordSequence <= next.recordSequence)
				members.set(next.memberId, next);
		},
		async putFleet(record) {
			const decoded = fromBinary(FleetRecordSchema, record.payload);
			const next = create(FleetRecordSchema, {
				...decoded,
				issuedAt: "",
				notAfter: "",
			});
			const held = fleets.get(next.fleetId);
			if (held === undefined || held.revision <= next.revision)
				fleets.set(next.fleetId, next);
		},
		async putView() {},
		async putTrust() {},
	};

	return { view, publisher };
}
