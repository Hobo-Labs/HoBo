/**
 * Local mode (L33): a process that owns its whole fleet holds the registry
 * in-process, with no authority and no bus (§6.2 "Local mode", D6). Re-exported
 * by `@hobo/fleet/membership`.
 *
 * `createLocalFleet` runs the same enrollment state machine (L02) and fleet
 * commands (L32, `mode: "local"`, so `ONE_ACTIVE` is accepted, D39) on
 * `createMemoryEventStore`: it defines the configured fleet as its owner, then
 * declares each configured member under the owner's `AUTO_OWNER` approval, so
 * every member is ACTIVE at once. The registry is rebuilt from configuration
 * at every cold start; member ids are `sponsoredMemberId` of the tenant, kind,
 * fleet and name, so a second start yields the same ids. Nothing is signed:
 * the record signer writes an empty signature with no key, the trust record
 * holds no keys, and the registry keeps records without their signing-time
 * fields. For a one-active fleet the registry lists the configured members as
 * candidates; which of them decide is the assignment log's business (§6.10
 * item 1).
 */
import { create } from "@bufbuild/protobuf";
import { createMeteringBus } from "@hobo/core";
import {
	ApprovalMode,
	DeclareRequestSchema,
	type FleetPolicy,
	FleetPolicySchema,
	type FleetRecord,
	FleetRecordSchema,
	KeyAlgorithm,
	type MemberRecord,
} from "../_generated/fleet_pb.js";
import { createFleetCommands } from "../fleets/index.js";
import { parseKeyId } from "../ids.js";
import { createEnrollmentAuthority } from "../membership/index.js";
import type {
	AuthorityDeps,
	FleetFailure,
	LocalFleetInit,
	Outcome,
	RegistryView,
	Signer,
	VerifiedToken,
} from "../ports.js";
import { createMemoryEventStore } from "../testing/plumbing/memory-event-store.js";
import { createLocalBus } from "./bus.js";
import {
	localParts,
	ownerOnlyPolicy,
	principalKey,
	refusingDeps,
} from "./parts.js";
import { createLocalRegistry } from "./registry.js";

/** No key and no signature: local mode would only be signing to itself (§3.3 rule 6). */
const UNSIGNED: Signer = {
	keyId: parseKeyId("authority#0"),
	algorithm: KeyAlgorithm.UNSPECIFIED,
	sign: async () => new Uint8Array(),
};

export async function createLocalFleet(init: LocalFleetInit): Promise<
	Readonly<{
		registry: RegistryView;
		fleet: FleetRecord;
		members: readonly MemberRecord[];
	}>
> {
	const policy = localPolicy(init);
	const names = new Set<string>();
	for (const member of init.members) {
		if (names.has(member.name))
			fail({
				code: "invalid-request",
				message: `${member.name} is configured twice`,
				detail: { rule: "duplicate-name" },
			});
		names.add(member.name);
	}

	const registry = createLocalRegistry(init.tenant);
	const store = createMemoryEventStore();
	const deps: AuthorityDeps = {
		...refusingDeps(),
		tenant: init.tenant,
		store,
		bus: createLocalBus(registry),
		policy: ownerOnlyPolicy(init.owner),
		recordSigner: UNSIGNED,
		metering: createMeteringBus(),
		incarnation: 0,
		now: init.now,
		log: init.log,
	};
	const authority = createEnrollmentAuthority(
		deps,
		localParts(createFleetCommands({ ...deps, mode: "local" })),
	);
	const owner: VerifiedToken = {
		kind: "person",
		principal: init.owner,
		tenant: init.tenant,
		tags: [],
		jkt: "",
		expiresAtMs: Number.MAX_SAFE_INTEGER,
	};

	unwrap(
		await authority.defineFleet(
			create(FleetRecordSchema, {
				fleetId: init.fleetId,
				tenant: init.tenant,
				coordination: init.coordination,
				policy,
			}),
			owner,
		),
	);
	for (const member of init.members)
		unwrap(
			await authority.declare(
				create(DeclareRequestSchema, {
					tenant: init.tenant,
					fleet: init.fleetId,
					kind: member.kind,
					name: member.name,
					displayName: member.displayName,
					credentialRef: member.credentialRef,
					endpointDigest: member.endpointDigest,
				}),
				owner,
			),
		);

	const fleet = await registry.view.fleet(init.fleetId);
	if (fleet === undefined)
		fail({
			code: "unavailable",
			message: `${init.fleetId} was defined but is not in the local registry`,
		});
	const declared = await registry.view.membersOf(init.fleetId);
	const members = init.members.map((member) => {
		const record = declared.find((candidate) =>
			candidate.memberships.some(
				(membership) =>
					membership.fleet === init.fleetId && membership.name === member.name,
			),
		);
		return (
			record ??
			fail({
				code: "unavailable",
				message: `${member.name} was declared but is not in the local registry`,
			})
		);
	});
	return { registry: registry.view, fleet, members };
}

/**
 * The configured policy with an unset approval mode read as `AUTO_OWNER`. A
 * mode that needs another principal (`SINGLE`, `DUAL`) cannot be met by one
 * process and is refused (`fleet-policy`, rule `local-approval`).
 */
function localPolicy(init: LocalFleetInit): FleetPolicy {
	if (init.policy.approval === ApprovalMode.UNSPECIFIED)
		return create(FleetPolicySchema, {
			...init.policy,
			approval: ApprovalMode.AUTO_OWNER,
		});
	if (init.policy.approval !== ApprovalMode.AUTO_OWNER)
		fail({
			code: "fleet-policy",
			message: `local mode declares members under the owner's AUTO_OWNER approval; ${principalKey(init.owner)} cannot meet ${ApprovalMode[init.policy.approval]}`,
			detail: { rule: "local-approval" },
		});
	return init.policy;
}

function unwrap<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) fail(outcome.error);
	return outcome.value;
}

function fail(error: FleetFailure): never {
	const rule = error.detail?.rule;
	throw new Error(
		`createLocalFleet refused: ${error.code}${rule === undefined ? "" : ` (${rule})`}: ${error.message}`,
	);
}
