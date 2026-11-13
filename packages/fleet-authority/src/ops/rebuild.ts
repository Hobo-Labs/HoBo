// After a restore, the registry bucket is rebuilt from the journal before
// any authority starts (design §6.16 "rebuilds the buckets"): each member or
// fleet stream's last journalled `record` (the shape L02 appends, D57) is
// signed again under the new incarnation and published. The authority's own
// projection takes over once it runs. Private to L27.
import { create, fromJson, toBinary } from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import {
	FLEET_RECORD_CONTEXT,
	type FleetEventStore,
	FleetRecordSchema,
	MEMBER_RECORD_CONTEXT,
	MemberRecordSchema,
	parseFleetId,
	parseMemberId,
	type RegistryPublisher,
	type Signer,
} from "@hobo/fleet";
import { signEnvelope } from "@hobo/fleet/keys";
import { isJsonObject } from "./json.js";

/** A registry record is valid for at most 30 minutes after it is signed (§6.14). */
export const RECORD_LIFETIME_MS = 30 * 60 * 1_000;
const MEMBER_PREFIX = "fleet-member-";
const FLEET_PREFIX = "fleet-fleet-";

export type RebuildDeps = Readonly<{
	store: FleetEventStore;
	publisher: RegistryPublisher;
	signer: Signer;
	incarnation: number;
	now: () => number;
}>;

/** Each stream's last journalled record, by stream id. */
async function lastRecords(
	store: FleetEventStore,
): Promise<ReadonlyMap<string, JsonValue>> {
	const last = new Map<string, JsonValue>();
	for await (const { event } of store.readAll()) {
		if (
			!event.streamId.startsWith(MEMBER_PREFIX) &&
			!event.streamId.startsWith(FLEET_PREFIX)
		)
			continue;
		const data: JsonValue | undefined = isJsonObject(event.data)
			? event.data
			: undefined;
		const record = isJsonObject(data) ? data.record : undefined;
		if (record !== undefined && isJsonObject(record))
			last.set(event.streamId, record);
	}
	return last;
}

/** Signs and publishes every member and fleet record; the count of each. */
export async function rebuildRegistry(
	deps: RebuildDeps,
): Promise<Readonly<{ members: number; fleets: number }>> {
	const issuedMs = deps.now();
	const issuedAt = new Date(issuedMs).toISOString();
	const notAfter = new Date(issuedMs + RECORD_LIFETIME_MS).toISOString();
	let members = 0;
	let fleets = 0;
	for (const [streamId, json] of await lastRecords(deps.store)) {
		if (streamId.startsWith(MEMBER_PREFIX)) {
			const record = create(MemberRecordSchema, {
				...fromJson(MemberRecordSchema, json, { ignoreUnknownFields: true }),
				authorityIncarnation: deps.incarnation,
				issuedAt,
				notAfter,
			});
			await deps.publisher.putMember(
				await signEnvelope(
					deps.signer,
					MEMBER_RECORD_CONTEXT,
					toBinary(MemberRecordSchema, record),
				),
				parseMemberId(record.memberId),
			);
			members += 1;
		} else {
			const record = create(FleetRecordSchema, {
				...fromJson(FleetRecordSchema, json, { ignoreUnknownFields: true }),
				issuedAt,
				notAfter,
			});
			await deps.publisher.putFleet(
				await signEnvelope(
					deps.signer,
					FLEET_RECORD_CONTEXT,
					toBinary(FleetRecordSchema, record),
				),
				parseFleetId(record.fleetId),
			);
			fleets += 1;
		}
	}
	return { members, fleets };
}
