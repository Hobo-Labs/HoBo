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
