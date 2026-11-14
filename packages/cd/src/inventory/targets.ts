// TARGET declaration (L19). Every Camp of a Yard with a fleet is backed by a
// fleet member. A Camp a reconciler agent serves is backed by that agent's
// DEVICE; every other (agentless) Camp is a TARGET the Station declares as
// sponsor through `members:declare`, authenticated by its workload identity
// (an `oidc_trust` rule with `sponsor`). The member is named
// `campMemberName(campId)` in the fleet the Yard maps to, so the Camp mapper
// finds it again.
import { create } from "@bufbuild/protobuf";
import type { TenantId } from "@hobo/core";
import {
	DeclareRequestSchema,
	type FleetClient,
	type MemberId,
	MemberKind,
	parseFleetId,
	parseMemberName,
} from "@hobo/fleet";
import { sponsoredMemberId } from "@hobo/fleet/keys";
import type { CampId, CampMembers, Outcome, TopologyReader } from "../ports.js";
import { campMemberName } from "./inventory.js";
import { reason, refuse } from "./support.js";

export type CampTargetInput = Readonly<{
	tenant: TenantId;
	fleet: string;
	campId: CampId;
	displayName: string;
	/** A reference to the credential the Station uses for the target (never the secret). */
	credentialRef: string;
	/** A digest of the target's endpoint, when it has one. */
	endpointDigest: string;
}>;

/** Declare one Camp as a TARGET member; answers its sponsored member id. */
export async function declareCampTarget(
	client: Pick<FleetClient, "declare">,
	input: CampTargetInput,
): Promise<Outcome<MemberId>> {
	const name = campMemberName(input.campId);
	const fleet = parseFleetId(input.fleet);
	const declared = await client.declare(
		create(DeclareRequestSchema, {
			tenant: input.tenant,
			fleet,
			kind: MemberKind.TARGET,
			name,
			displayName: input.displayName,
			credentialRef: input.credentialRef,
			endpointDigest: input.endpointDigest,
		}),
	);
	if (!declared.ok)
		return refuse(
			reason(
				"camp-target-declare-refused",
				`${declared.error.code}: ${declared.error.message}`,
				"Give the Station's workload identity an oidc_trust rule with `sponsor` for this fleet, then declare again.",
				input.campId,
			),
		);
	return {
		ok: true,
		value: sponsoredMemberId(
			input.tenant,
			MemberKind.TARGET,
			fleet,
			parseMemberName(name),
		),
	};
}

export interface CampTargetDeclarer {
	/** Declare every agentless Camp of a mapped Yard that no member backs yet. */
	declare(): Promise<readonly Outcome<MemberId>[]>;
}

export function createCampTargetDeclarer(
	d: Readonly<{
		tenant: TenantId;
		client: Pick<FleetClient, "declare">;
		topology: TopologyReader;
		members: CampMembers;
	}>,
): CampTargetDeclarer {
	return {
		async declare() {
			const out: Outcome<MemberId>[] = [];
			const camps = [...(await d.topology.camps())].sort((a, b) =>
				a.campId.localeCompare(b.campId),
			);
			for (const topology of camps) {
				const fleet = d.members.fleetOf(topology.yardId);
				if (fleet === undefined) continue;
				const name = campMemberName(topology.campId);
				const backed = (
					await d.members.registry.membersOf(parseFleetId(fleet))
				).some((member) =>
					member.memberships.some(
						(membership) =>
							membership.fleet === fleet && membership.name === name,
					),
				);
				if (backed) continue;
				out.push(
					await declareCampTarget(d.client, {
						tenant: d.tenant,
						fleet,
						campId: topology.campId,
						displayName: topology.campId,
						credentialRef: "",
						endpointDigest: "",
					}),
				);
			}
			return out;
		},
	};
}
