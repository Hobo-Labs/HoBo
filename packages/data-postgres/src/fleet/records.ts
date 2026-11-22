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
	Refusal,
	type RegistryView,
	SandboxTier,
	type UsageMeasurement,
} from "@hobo/fleet";
import { PostgresDataError } from "../errors.js";

const MAX_FAILING_FOR_MS = 4_294_967_295;

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

export function memberNameIn(
	record: MemberRecord,
	fleet: FleetId,
): string | undefined {
	return record.memberships.find((membership) => membership.fleet === fleet)
		?.name;
}

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
		refusal: Refusal.UNSPECIFIED,
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
