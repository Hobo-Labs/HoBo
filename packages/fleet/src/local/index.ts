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
