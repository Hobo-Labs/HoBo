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
	type FleetCapacity,
	type FleetLog,
	type FleetRecord,
	type FleetTransport,
	type FleetView,
	Health,
	type KeyStore,
	type MemberId,
	type Outcome,
	parseFleetId,
	parseMemberId,
	Role,
	type SandboxDriver,
	type WorkRunner,
	type WorkSource,
} from "@hobo/fleet";
import { createFleetAgent } from "@hobo/fleet/agent";
import { z } from "zod";
import type { GithubTransport } from "./github.js";
import { hostDockerAllowed } from "./isolated-worker/container-flags.js";
import type { HostHealthState } from "./isolated-worker/host-health.js";

/** public-contract: the work kind of L16 (`createGithubActionsWorkSource`). */
export const GITHUB_ACTIONS_JOB = "github-actions-job";

export const BOX_ROLES: readonly Role[] = [Role.DISPATCHER, Role.EXECUTOR];

export type WorkerAdmissionSample = Readonly<{
	usedSlots: number;
	hostHealth: HostHealthState;
	draining: boolean;
	memoryAdmits: boolean;
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
	host?: CapacitySource,
): CapacitySource {
	return {
		read: async () => {
			const [sample, signals] = await Promise.all([
				admission.read(),
				host
					?.read()
					.then((reading) => reading.hostSignals)
					.catch(() => undefined),
			]);
			const reading = capacityFromAdmission(admission, sample);
			return signals === undefined
				? reading
				: { ...reading, hostSignals: signals };
		},
	};
}

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

const jitConfig = z.object({ encoded_jit_config: z.string().min(1) });

export function createJitRegistrationMinter(
	options: Readonly<{
		github: GithubTransport;
		connections: () => Promise<
			readonly Readonly<{
				installationId: number;
				repository: string;
				runnerGroupId: number;
			}>[]
		>;
	}>,
) {
	const refused = (message: string): Outcome<Uint8Array> => ({
		ok: false,
		error: { code: "unavailable", message },
	});
	return async (
		input: Readonly<{
			repository: string;
			labels: readonly string[];
			runnerName: string;
		}>,
	): Promise<Outcome<Uint8Array>> => {
		const connection = (await options.connections()).find(
			(entry) =>
				entry.repository.toLowerCase() === input.repository.toLowerCase(),
		);
		if (connection === undefined)
			return {
				ok: false,
				error: {
					code: "invalid-request",
					message: "the worker is not connected to that repository",
				},
			};
		const response = await options.github.request(
			connection.installationId,
			`/repos/${connection.repository}/actions/runners/generate-jitconfig`,
			"POST",
			JSON.stringify({
				name: input.runnerName,
				runner_group_id: connection.runnerGroupId,
				labels: [...input.labels],
				work_folder: "_hobo_work",
			}),
		);
		if (response.status !== 201)
			return refused(`runner registration answered ${response.status}`);
		const parsed = jitConfig.safeParse(await response.json().catch(() => ({})));
		if (!parsed.success) return refused("runner registration was malformed");
		return {
			ok: true,
			value: new TextEncoder().encode(parsed.data.encoded_jit_config),
		};
	};
}

export type BoxMemberOptions = Readonly<{
	keys: KeyStore;
	authorityUrl: string;
	tenant: TenantId;
	fleet: string;
	connector: FleetBusConnector;
	admission: WorkerAdmission;
	host?: CapacitySource;
	work: Readonly<{ source: WorkSource; runner: WorkRunner }>;
	sandboxes: readonly SandboxDriver[];
	egress: EgressProxyFactory;
	transports?: readonly FleetTransport[];
	agentVersion: string;
	now: Clock;
	log: FleetLog;
	fetch: typeof fetch;
}>;

export function composeFleetDaemon(options: BoxMemberOptions) {
	const fleetId = parseFleetId(options.fleet);
	const agent = createFleetAgent({
		keys: options.keys,
		authorityUrl: options.authorityUrl,
		tenant: options.tenant,
		connector: options.connector,
		capacity: admissionCapacitySource(options.admission, options.host),
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
		hostDocker: (): boolean => allowed,
		fleetAllow: (): readonly string[] => fleet?.policy?.egressAllow ?? [],
		async fleetCapacity(): Promise<FleetCapacity | undefined> {
			return (await this.fleetView())?.capacity;
		},
		async fleetView(): Promise<FleetView | undefined> {
			const registry = agent.bus()?.registry;
			if (registry === undefined) return undefined;
			return registry.view(fleetId);
		},
		memberId(): MemberId | undefined {
			const id = agent.status().member?.memberId;
			return id === undefined || id === "" ? undefined : parseMemberId(id);
		},
	};
}
