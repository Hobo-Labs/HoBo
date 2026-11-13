/**
 * The `@hobo/fleet` records a Postgres fleet hands its one-active loop.
 *
 * A Postgres fleet runs in local mode (design §6.10): the process that writes
 * the backends' stores runs the loop, and its registry is its configuration.
 * The registry here lists every configured backend as an `ACTIVE` `BACKEND`
 * member of one `ONE_ACTIVE` fleet, under its configured name; which of them
 * decide an epoch is the assignment log's business, never this registry's.
 *
 * Records are written as plain protobuf-es values (with their `$typeName`):
 * nothing here is signed or sent, so no envelope or encoder is involved.
 */
import {
	ApprovalMode,
	AttestationTier,
	CoordinationMode,
	DeviceClass,
	type FleetId,
	type FleetPolicy,
	type FleetRecord,
	Health,
	MemberKind,
	type MemberName,
	type MemberRecord,
	MemberState,
	type Observation,
	type RegistryView,
	SandboxTier,
	type UsageMeasurement,
} from "@hobo/fleet";
import { PostgresDataError } from "../errors.js";

/** The largest `failing_for_ms` an observation carries (uint32). */
const MAX_FAILING_FOR_MS = 4_294_967_295;

/** A Postgres fleet's health thresholds, from the reconcile's routing policy. */
export type PostgresFleetThresholds = Readonly<{
	failoverAfterMs: number;
	recoveryPointMs: number;
	membershipEpochs: boolean;
}>;

function fleetPolicy(thresholds: PostgresFleetThresholds): FleetPolicy {
	return {
		$typeName: "hobo.fleet.v1.FleetPolicy",
		approval: ApprovalMode.AUTO_OWNER,
		allowedKinds: [MemberKind.BACKEND],
		allowedRoles: [],
		allowedClasses: [],
		minAttestationTier: AttestationTier.UNSPECIFIED,
		orgMinSandbox: SandboxTier.UNSPECIFIED,
		workKinds: [],
		repositories: [],
		oidcTrust: [],
		deviceCaRootsPem: [],
		egressAllow: [],
		memberQuotaPerPrincipal: 0,
		minAgentVersion: "",
		allowHostDocker: false,
		sessionPurposes: [],
		labels: [],
		keyBundleHours: 0,
		failoverAfterMs: Math.min(MAX_FAILING_FOR_MS, thresholds.failoverAfterMs),
		recoveryPointMs: Math.min(MAX_FAILING_FOR_MS, thresholds.recoveryPointMs),
		membershipEpochs: thresholds.membershipEpochs,
	};
}

function memberRecord(
	tenant: string,
	fleet: FleetId,
	name: MemberName,
): MemberRecord {
	return {
		$typeName: "hobo.fleet.v1.MemberRecord",
		memberId: "",
		tenant,
		kind: MemberKind.BACKEND,
		displayName: name,
		state: MemberState.ACTIVE,
		memberships: [
			{
				$typeName: "hobo.fleet.v1.Membership",
				fleet,
				name,
				roles: [],
				joinedAt: "",
			},
		],
		deviceClass: DeviceClass.UNSPECIFIED,
		attestationTier: AttestationTier.UNSPECIFIED,
		attestationDigest: "",
		identityJwk: "",
		identityThumbprint: "",
		retiredThumbprints: [],
		region: "",
		agentVersion: "",
		owner: "",
		ownerAliases: [],
		sponsor: "",
		credentialRef: "",
		endpointDigest: "",
		invitedBy: "",
		keyApprovedBy: "",
		acceptedBy: "",
		enrolledAt: "",
		stateChangedAt: "",
		stateReason: "",
		recordSequence: 0,
		authorityIncarnation: 0,
		issuedAt: "",
		notAfter: "",
	};
}

/** The member's name in `fleet`, or undefined for a record of another fleet. */
export function memberNameIn(
	record: MemberRecord,
	fleet: FleetId,
): string | undefined {
	return record.memberships.find((membership) => membership.fleet === fleet)
		?.name;
}

/**
 * The fleet record and the configuration-built registry of a Postgres fleet:
 * one `ACTIVE` `BACKEND` member per configured name, in configured order.
 */
export function postgresFleetRegistry(
	fleet: FleetId,
	names: readonly MemberName[],
	thresholds: PostgresFleetThresholds,
) {
	const tenant = "local";
	const record: FleetRecord = {
		$typeName: "hobo.fleet.v1.FleetRecord",
		fleetId: fleet,
		tenant,
		owner: "",
		coordination: CoordinationMode.ONE_ACTIVE,
		policy: fleetPolicy(thresholds),
		revision: 1,
		updatedAt: "",
		updatedBy: "",
		issuedAt: "",
		notAfter: "",
	};
	const members = names.map((name) => memberRecord(tenant, fleet, name));
	const registry: RegistryView = {
		member: async (id) => members.find((member) => member.memberId === id),
		fleet: async (id) => (id === fleet ? record : undefined),
		membersOf: async (id) => (id === fleet ? members : []),
		fleets: async () => [record],
		members: async () => members,
		view: async () => undefined,
		trust: () => {
			throw new PostgresDataError(
				"FLEET_CONFIGURATION_INVALID",
				"a Postgres fleet runs in local mode and holds no trust record",
			);
		},
		trustEnvelope: () => undefined,
		caughtUp: async () => undefined,
	};
	return { fleet: record, registry };
}

/** What one tick saw of one backend, as the fleet's `Observation`. */
export function postgresObservation(
	input: Readonly<{
		health: Health;
		failingForMs: number;
		probeLatencyMs: number | undefined;
		ready: boolean;
		lagMs: number | undefined;
		usage: readonly Readonly<{ unit: string; used: number }>[];
	}>,
): Observation {
	return {
		$typeName: "hobo.fleet.v1.Observation",
		memberId: "",
		observerId: "",
		fleets: [],
		health: input.health,
		failingForMs: Math.min(MAX_FAILING_FOR_MS, Math.max(0, input.failingForMs)),
		probeLatencyMs: input.probeLatencyMs,
		ready: input.ready,
		lagMs:
			input.lagMs === undefined
				? undefined
				: Math.min(MAX_FAILING_FOR_MS, input.lagMs),
		usage: input.usage.map(
			(entry): UsageMeasurement => ({
				$typeName: "hobo.fleet.v1.UsageMeasurement",
				unit: entry.unit,
				used: entry.used,
			}),
		),
		labels: [],
		sandboxTiers: [],
		agentVersion: "",
		transports: [],
		region: "",
		bundleSequence: 0,
		since: "",
		issuedAt: "",
		validUntil: "",
	};
}

/** An observation of a backend nothing is known about. */
export function unknownObservation(): Observation {
	return postgresObservation({
		health: Health.UNKNOWN,
		failingForMs: 0,
		probeLatencyMs: undefined,
		ready: false,
		lagMs: undefined,
		usage: [],
	});
}
