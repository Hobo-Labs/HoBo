/**
 * The box worker as a HoBo Fleet member (design §8.1, L34; O42). The worker
 * daemon composes `createFleetAgent` (`@hobo/fleet/agent`) with:
 *
 * - roles `DISPATCHER` and `EXECUTOR`, asked for at enrollment as a
 *   `DEDICATED` device (`boxEnrollment`);
 * - the worker's memory, storage and host-health admission as its
 *   `CapacitySource` (`capacityFromAdmission`);
 * - the `github-actions-job` work kind (L16's source and runner);
 * - the sandbox drivers and egress proxy factory of `@hobo/fleet-agent`
 *   (`sandboxDrivers`, `createEgressProxyFactory`), which the caller resolves;
 * - the fleet's `allow_host_docker`, read from the registry, for the host
 *   Docker socket of the worker's own containers (`hostDocker`).
 *
 * It replaces the relay mesh (`mesh-*.ts`) and the published fleet variables.
 */
import { create } from "@bufbuild/protobuf";
import type { TenantId } from "@hobo/core";
import {
	CapacitySchema,
	type CapacitySource,
	type Clock,
	DeviceClass,
	type EgressProxyFactory,
	type EnrollmentRequest,
	EnrollmentRequestSchema,
	type FleetBusConnector,
	type FleetLog,
	type FleetRecord,
	type FleetTransport,
	Health,
	type KeyStore,
	parseFleetId,
	Role,
	type SandboxDriver,
	type WorkRunner,
	type WorkSource,
} from "@hobo/fleet";
import { createFleetAgent } from "@hobo/fleet/agent";
import { hostDockerAllowed } from "./isolated-worker/container-flags.js";
import type { HostHealthState } from "./isolated-worker/host-health.js";

/** public-contract: the work kind of L16 (`createGithubActionsWorkSource`). */
export const GITHUB_ACTIONS_JOB = "github-actions-job";

/** The roles a box worker holds in its fleet. */
export const BOX_ROLES: readonly Role[] = [Role.DISPATCHER, Role.EXECUTOR];

/** What the worker's admission says right now. An unknown measure is undefined, never zero. */
export type WorkerAdmissionSample = Readonly<{
	/** Launch slots the worker's own leases hold. */
	usedSlots: number;
	hostHealth: HostHealthState;
	draining: boolean;
	/** Memory admission (with host pressure) admits one more job of the standard class. */
	memoryAdmits: boolean;
	/** Storage admission admits one more job. */
	storageAdmits: boolean;
	freeMemoryMb: number | undefined;
	freeDiskMb: number | undefined;
}>;

export type WorkerAdmission = Readonly<{
	slots: number;
	labels: readonly string[];
	read(): Promise<WorkerAdmissionSample>;
}>;

const whole = (value: number | undefined) =>
	value === undefined ? undefined : Math.max(0, Math.floor(value));

/** The worker's admission as the agent's capacity: no free slot unless every admission admits. */
export function capacityFromAdmission(
	worker: Readonly<{ slots: number; labels: readonly string[] }>,
	sample: WorkerAdmissionSample,
) {
	const health = sample.draining
		? Health.DRAINING
		: sample.hostHealth === "ok"
			? Health.REACHABLE
			: Health.PRESSURED;
	const admits =
		!sample.draining &&
		sample.hostHealth !== "critical" &&
		sample.memoryAdmits &&
		sample.storageAdmits;
	const freeSlots = admits ? Math.max(0, worker.slots - sample.usedSlots) : 0;
	const capacity = create(CapacitySchema, {
		freeSlots,
		totalSlots: worker.slots,
	});
	const memory = whole(sample.freeMemoryMb);
	const disk = whole(sample.freeDiskMb);
	if (memory !== undefined) capacity.freeMemoryMb = memory;
	if (disk !== undefined) capacity.freeDiskMb = disk;
	return { capacity, health, labels: [...worker.labels] };
}

export function admissionCapacitySource(
	admission: WorkerAdmission,
): CapacitySource {
	return {
		read: async () => capacityFromAdmission(admission, await admission.read()),
	};
}

/** A box's enrollment: a `DEDICATED` device asking for `DISPATCHER` and `EXECUTOR` with its bootstrap token. */
export function boxEnrollment(
	input: Readonly<{
		tenant: TenantId;
		fleet: string;
		name: string;
		bootstrapToken: string;
		region: string;
		platform: Readonly<{ os: string; arch: string }>;
	}>,
): Omit<EnrollmentRequest, "identityJwk" | "keyBundle"> {
	return create(EnrollmentRequestSchema, {
		tenant: input.tenant,
		fleet: input.fleet,
		name: input.name,
		displayName: input.name,
		platform: { ...input.platform },
		region: input.region,
		deviceClass: DeviceClass.DEDICATED,
		requestedRoles: [...BOX_ROLES],
		proof: { case: "bootstrapToken", value: input.bootstrapToken },
	});
}

export type FleetDaemonOptions = Readonly<{
	keys: KeyStore;
	authorityUrl: string;
	tenant: TenantId;
	/** The fleet whose `allow_host_docker` and egress allowlist the worker follows. */
	fleet: string;
	connector: FleetBusConnector;
	admission: WorkerAdmission;
	/** L16's `createGithubActionsWorkSource` and `createGithubActionsWorkRunner`. */
	work: Readonly<{ source: WorkSource; runner: WorkRunner }>;
	/** `sandboxDrivers` of `@hobo/fleet-agent`, resolved by the caller. */
	sandboxes: readonly SandboxDriver[];
	/** `createEgressProxyFactory` of `@hobo/fleet-agent`, given `fleetAllow`. */
	egress: EgressProxyFactory;
	transports?: readonly FleetTransport[];
	agentVersion: string;
	now: Clock;
	log: FleetLog;
	fetch: typeof fetch;
}>;

export function composeFleetDaemon(options: FleetDaemonOptions) {
	const fleetId = parseFleetId(options.fleet);
	const agent = createFleetAgent({
		keys: options.keys,
		authorityUrl: options.authorityUrl,
		tenant: options.tenant,
		connector: options.connector,
		capacity: admissionCapacitySource(options.admission),
		runners: [options.work.runner],
		sources: [options.work.source],
		sandboxes: options.sandboxes,
		egress: options.egress,
		transports: options.transports ?? [],
		agentVersion: options.agentVersion,
		now: options.now,
		log: options.log,
		fetch: options.fetch,
	});
	let fleet: FleetRecord | undefined;
	let allowed = false;
	return {
		agent,
		/** Reads the fleet record and this member from the registry; call it on the agent's beat. */
		async refreshFleet(): Promise<void> {
			const registry = agent.bus()?.registry;
			if (registry === undefined) return;
			const member = agent.status().member;
			fleet = await registry.fleet(fleetId);
			allowed = hostDockerAllowed(
				fleet,
				member?.deviceClass ?? DeviceClass.UNSPECIFIED,
			);
		},
		/** Whether the worker's containers may mount the host Docker socket now. */
		hostDocker: (): boolean => allowed,
		/** The fleet's egress allowlist, for `createEgressProxyFactory`'s `fleetAllow`. */
		fleetAllow: (): readonly string[] => fleet?.policy?.egressAllow ?? [],
	};
}
