import { create } from "@bufbuild/protobuf";
import {
	type Discovery,
	DiscoverySchema,
	type EnrollmentResponse,
	EnrollmentResponseSchema,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	type OverlayJoin,
} from "../_generated/fleet_pb.js";
import { parseMemberId } from "../ids.js";
import type { AuthorityDeps } from "../ports.js";
import type { Ctx } from "./context.js";

const OVERLAY_TTL_MS = 10 * 60 * 1_000;

/** domain-view: the fields of a MemberRecord one transition sets; the rest carry over. */
export type RecordChange = Partial<
	Omit<MemberRecord, "$typeName" | "$unknown">
>;

export function nextRecord(
	record: MemberRecord,
	change: RecordChange,
	nowIso: string,
): MemberRecord {
	const stateChanges =
		change.state !== undefined && change.state !== record.state;
	return create(MemberRecordSchema, {
		...record,
		...change,
		stateChangedAt: stateChanges ? nowIso : record.stateChangedAt,
		stateReason: change.stateReason ?? (stateChanges ? "" : record.stateReason),
		recordSequence: record.recordSequence + 1,
	});
}

export function discoveryOf(deps: AuthorityDeps): Discovery {
	return create(DiscoverySchema, {
		tenant: deps.tenant,
		issuer: deps.discovery.issuer,
		natsUrls: [...deps.discovery.natsUrls],
		natsSentinelCredentials: deps.discovery.natsSentinelCredentials,
		relayUrls: [...deps.discovery.relayUrls],
		trust: deps.bus.registry.trustEnvelope(),
		minAgentVersion: deps.discovery.minAgentVersion,
	});
}

export async function enrollmentResponse(
	ctx: Ctx,
	record: MemberRecord,
): Promise<EnrollmentResponse> {
	const joins: OverlayJoin[] = [];
	if (
		record.kind === MemberKind.DEVICE &&
		record.state === MemberState.ACTIVE
	) {
		const memberId = parseMemberId(record.memberId);
		const tags = record.memberships.map(
			(membership) => `fleet-${membership.fleet}`,
		);
		const minted = await Promise.all(
			ctx.deps.overlayMinters.map(async (minter) => {
				try {
					return await minter.mint({
						tenant: ctx.deps.tenant,
						memberId,
						tags,
						ttlMs: OVERLAY_TTL_MS,
					});
				} catch {
					return undefined;
				}
			}),
		);
		for (const result of minted) if (result?.ok) joins.push(result.value);
	}
	return create(EnrollmentResponseSchema, {
		memberRecord: await ctx.signRecord(record),
		overlayJoins: joins,
		discovery: discoveryOf(ctx.deps),
	});
}
