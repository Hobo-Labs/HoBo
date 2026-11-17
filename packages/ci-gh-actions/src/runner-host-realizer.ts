import { ACTIVE_STATES, type Lease } from "@hobo/ci";
import type { MeshNode } from "@hobo/ci/mesh";
import {
	createResolverRegistry,
	type HttpTransport,
	parseResolveOutcome,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	type TrafficRoutingProviderProfile,
} from "@hobo/core";
import { z } from "zod";
import type { DepsImageDockerPort } from "./isolated-worker/deps-image.js";
import type {
	DockerContainer,
	DockerDriver,
	IsolatedContainerSpec,
} from "./isolated-worker/docker-driver.js";
import type { GithubRunnerPresence } from "./jit-runner-presence.js";
import { runnerCustody } from "./job-runner-custody.js";
import {
	RUNNER_FLEET_BINDLE,
	RUNNER_FLEET_CAMP_SET,
	RUNNER_FLEET_YARD,
	RUNNER_HOST_PRODUCT_ID,
	type RunnerHostKind,
	servedLabelClaims,
} from "./runner-fleet-delivery.js";

export { RUNNER_HOST_PRODUCT_ID };
// public-contract: the resolver identity the runner fleet's Camps resolve to.
export const RUNNER_HOST_PROVIDER_ID = "hobo-ci";
// public-contract: the controller container name prefix; the suffix is the image digest hex.
export const RUNNER_CONTROLLER_CONTAINER_PREFIX = "hoboci-runner-controller-";
// public-contract: realization parameters that say how to act, not what the controller is.
export const RUNNER_HOST_DIRECTIVES = Object.freeze(["drainDeadlineMs"]);
// public-contract: outputs that change with load on the host; never drift.
export const RUNNER_HOST_RETAINED_FIELDS = Object.freeze([
	"busyRunners",
	"freeSlots",
	"inFlightJobs",
	"onlineRunners",
]);

const DEFAULT_DRAIN_DEADLINE_MS = 2 * 60 * 60_000;
const DEFAULT_VERIFY_DEADLINE_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_DRAIN_DEADLINE_MS = 24 * 60 * 60_000;
const CONTROLLER_TIMEOUT_MS = 365 * 24 * 60 * 60_000;
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const IMAGE_BY_DIGEST =
	/^(?<repository>[a-z0-9][a-z0-9._/:-]{0,254})@sha256:(?<hex>[0-9a-f]{64})$/u;

export const RUNNER_HOST_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze([]),
	});

const JOB_ROUTING =
	"Jobs reach a runner host through GitHub's queue, the route job and the relay; the host serves no request traffic CD could shift";

export const RUNNER_HOST_TRAFFIC_ROUTING_ABSENT: readonly Readonly<{
	offeringId: string;
	reason: string;
}>[] = Object.freeze(
	[
		"dns.failover",
		"dns.weighted",
		"driver.route-bind",
		"edge.canary",
		"edge.header",
		"edge.path",
		"inprocess.weighted",
		"lb.health",
		"lb.lifecycle",
		"lb.locality",
		"lb.weighted",
		"mesh.optional",
		"observe.health",
		"observe.location",
		"overlay.funnel",
		"overlay.funnel.multi",
		"resiliency.edge",
	].map((offeringId) => Object.freeze({ offeringId, reason: JOB_ROUTING })),
);

export function runnerHostProductRefusal(
	productId: string,
): ResolverError | undefined {
	if (productId === RUNNER_HOST_PRODUCT_ID) return undefined;
	return new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		`runner-host-product-unsupported: the runner-host realizer realizes only ${RUNNER_HOST_PRODUCT_ID}, not ${JSON.stringify(productId)}`,
		productId,
	);
}

export type RunnerControllerContainers = Pick<
	DockerDriver,
	"create" | "start" | "stop" | "remove" | "isRunning"
> &
	Required<Pick<DockerDriver, "inspectImage" | "listWorkerContainers">> &
	Pick<DepsImageDockerPort, "pull">;

export type RunnerHostAdvert = MeshNode &
	Readonly<{ controllerDigest?: string | undefined }>;

export type RunnerHostRegistration = Readonly<{
	name: string;
	presence: GithubRunnerPresence;
}>;

export interface RunnerHostJobs {
	leases(): Promise<readonly Lease[]>;
	runners(): Promise<readonly RunnerHostRegistration[]>;
	meshAdvert(): Promise<RunnerHostAdvert | undefined>;
	pauseAdmission(): Promise<void>;
	resumeAdmission(): Promise<void>;
}

export type RunnerControllerProcessState =
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "exited"
	| "failed";

export type RunnerControllerProcessStatus = Readonly<{
	digest?: string | undefined;
	state: RunnerControllerProcessState;
	generation: number;
	pid?: number | undefined;
	startedAtMs?: number | undefined;
	reason?: string | undefined;
}>;

export interface RunnerControllerProcess {
	stage(image: string): Promise<void>;
	status(): Promise<RunnerControllerProcessStatus | undefined>;
	run(digest: string | undefined): Promise<number>;
}

export type RunnerHostPorts = Readonly<{
	containers?: Partial<RunnerControllerContainers> | undefined;
	process?: Partial<RunnerControllerProcess> | undefined;
	jobs?: Partial<RunnerHostJobs> | undefined;
}>;

const CONTAINER_METHODS = [
	"create",
	"inspectImage",
	"isRunning",
	"listWorkerContainers",
	"pull",
	"remove",
	"start",
	"stop",
] as const;
const PROCESS_METHODS = ["run", "stage", "status"] as const;
const JOB_METHODS = [
	"leases",
	"meshAdvert",
	"pauseAdmission",
	"resumeAdmission",
	"runners",
] as const;

export function runnerHostInterfaceGaps(
	host: RunnerHostPorts,
): readonly string[] {
	const jobs: Partial<RunnerHostJobs> = host.jobs ?? {};
	const process = host.process;
	const containers: Partial<RunnerControllerContainers> = host.containers ?? {};
	const controller =
		process === undefined
			? CONTAINER_METHODS.filter(
					(name) => !(containers[name] instanceof Function),
				).map((name) => `containers.${name}`)
			: PROCESS_METHODS.filter(
					(name) => !(process[name] instanceof Function),
				).map((name) => `process.${name}`);
	return Object.freeze([
		...controller,
		...JOB_METHODS.filter((name) => !(jobs[name] instanceof Function)).map(
			(name) => `jobs.${name}`,
		),
	]);
}

type ControllerPort =
	| Readonly<{ mode: "container"; containers: RunnerControllerContainers }>
	| Readonly<{ mode: "process"; process: RunnerControllerProcess }>;

type WiredHost = Readonly<{
	controller: ControllerPort;
	jobs: RunnerHostJobs;
}>;

function wired(host: RunnerHostPorts): WiredHost {
	const gaps = runnerHostInterfaceGaps(host);
	if (gaps.length > 0)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`runner-host-interface-missing: this host has no ${gaps.join(", ")}; the runner-host realizer acts only through the worker's controller port (container driver or supervised process) and job ports, so wire them (packages/ci-gh-actions/README.md, Runner-host realizer) or run this host's upgrades by hand`,
			RUNNER_HOST_PRODUCT_ID,
		);
	const jobs = host.jobs as RunnerHostJobs;
	if (host.process !== undefined)
		return {
			controller: {
				mode: "process",
				process: host.process as RunnerControllerProcess,
			},
			jobs,
		};
	return {
		controller: {
			mode: "container",
			containers: host.containers as RunnerControllerContainers,
		},
		jobs,
	};
}

export type RunnerHostRealizerOptions = Readonly<{
	hostId: string;
	hostKind: RunnerHostKind;
	host: RunnerHostPorts;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollIntervalMs?: number;
	drainDeadlineMs?: number;
	verifyDeadlineMs?: number;
}>;

const Volume = z
	.object({
		source: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$|^\/[^:,]+$/u, "volume source"),
		target: z.string().regex(/^\/[^:,]+$/u, "volume target"),
		readonly: z.boolean().optional(),
	})
	.strict();

const ControllerConfig = z
	.object({
		command: z.array(z.string().min(1).max(4096)).max(64),
		env: z.record(
			z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u, "env name"),
			z.string().max(4096),
		),
		volumes: z.array(Volume).max(16),
		memoryMb: z.number().int().min(512).optional(),
		runAsUser: z
			.string()
			.regex(/^[0-9]{1,10}(?::[0-9]{1,10})?$|^[a-z_][a-z0-9_-]{0,31}$/u)
			.optional(),
	})
	.strict();

const Desired = z
	.object({
		hostId: z.string().regex(HOST_ID, "host id"),
		image: z
			.string()
			.regex(IMAGE_BY_DIGEST, "an image reference pinned by @sha256 digest"),
		drainDeadlineMs: z
			.number()
			.int()
			.min(0)
			.max(MAX_DRAIN_DEADLINE_MS)
			.optional(),
		config: ControllerConfig.default({ command: [], env: {}, volumes: [] }),
	})
	.strict();

type ControllerVolume = { source: string; target: string; readonly?: boolean };

function volumeOf(volume: z.infer<typeof Volume>): ControllerVolume {
	const mount: ControllerVolume = {
		source: volume.source,
		target: volume.target,
	};
	if (volume.readonly !== undefined) mount.readonly = volume.readonly;
	return mount;
}

type DesiredController = z.infer<typeof Desired> &
	Readonly<{ repository: string; digest: string }>;

type LaunchedSpec = Readonly<{
	image: string;
	config: DesiredController["config"];
}>;

function rejected(message: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		message,
		RUNNER_HOST_PRODUCT_ID,
	);
}

function parseRequest(raw: ResolveRequest, hostId: string): DesiredController {
	const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
	const refusal = runnerHostProductRefusal(request.ref.productId);
	if (refusal) throw refusal;
	if (request.ref.slot !== "service")
		rejected(
			`runner-host-slot-unsupported: the runner controller is a service, not ${JSON.stringify(request.ref.slot)}`,
		);
	const parsed = Desired.safeParse(request.desired);
	if (!parsed.success)
		rejected(
			`runner-host-desired-invalid: ${parsed.error.issues
				.map(
					(issue) => `${issue.path.join(".") || "desired"}: ${issue.message}`,
				)
				.join("; ")}`,
		);
	if (parsed.data.hostId !== hostId)
		rejected(
			`runner-host-scope-mismatch: this agent realizes host ${JSON.stringify(hostId)}, not ${JSON.stringify(parsed.data.hostId)}`,
		);
	const match = IMAGE_BY_DIGEST.exec(parsed.data.image);
	const repository = match?.groups?.repository ?? "";
	const hex = match?.groups?.hex ?? "";
	return { ...parsed.data, repository, digest: `sha256:${hex}` };
}

type Controller = Readonly<{
	name: string;
	id: string;
	digest: string;
	running: boolean;
}>;

type HostSnapshot = Readonly<{
	controllers: readonly Controller[];
	running: readonly Controller[];
	inFlightJobs: number;
	busyRunners: number;
	onlineRunners: number;
	advert: RunnerHostAdvert | undefined;
}>;

export const controllerContainerName = (digest: string): string =>
	`${RUNNER_CONTROLLER_CONTAINER_PREFIX}${digest.replace(/^sha256:/u, "")}`;

function controllerOf(container: DockerContainer): Controller | undefined {
	const name = container.name.replace(/^\//u, "");
	if (!name.startsWith(RUNNER_CONTROLLER_CONTAINER_PREFIX)) return undefined;
	const hex = name.slice(RUNNER_CONTROLLER_CONTAINER_PREFIX.length);
	return DIGEST_HEX.test(hex)
		? {
				name: container.name,
				id: container.containerId,
				digest: `sha256:${hex}`,
				running: container.state === "running",
			}
		: undefined;
}

const PROCESS_PRESENT = new Set<RunnerControllerProcessState>([
	"starting",
	"running",
	"stopping",
	"exited",
	"failed",
]);

function processControllerOf(
	status: RunnerControllerProcessStatus | undefined,
	requested: number,
): Controller | undefined {
	if (!status?.digest || !PROCESS_PRESENT.has(status.state)) return undefined;
	const hex = status.digest.replace(/^sha256:/u, "");
	if (!DIGEST_HEX.test(hex)) return undefined;
	return {
		name: controllerContainerName(status.digest),
		id: status.pid === undefined ? "pid:unknown" : `pid:${status.pid}`,
		digest: `sha256:${hex}`,
		running: status.state === "running" && status.generation >= requested,
	};
}

export function inFlightJobCount(
	leases: readonly Lease[],
	runners: readonly RunnerHostRegistration[],
): number {
	const leased = leases.filter(
		(lease) =>
			ACTIVE_STATES.has(lease.state) &&
			runnerCustody(lease.runnerName) !== "foreign",
	).length;
	const busy = runners.filter((runner) => runner.presence.busy).length;
	return Math.max(leased, busy);
}

async function listControllers(
	port: ControllerPort,
	requested: number,
): Promise<readonly Controller[]> {
	if (port.mode === "process") {
		const controller = processControllerOf(
			await port.process.status(),
			requested,
		);
		return controller ? [controller] : [];
	}
	return (await port.containers.listWorkerContainers()).flatMap((container) => {
		const controller = controllerOf(container);
		return controller ? [controller] : [];
	});
}

async function snapshot(host: WiredHost, requested = 0): Promise<HostSnapshot> {
	const [controllers, leases, runners, advert] = await Promise.all([
		listControllers(host.controller, requested),
		host.jobs.leases(),
		host.jobs.runners(),
		host.jobs.meshAdvert(),
	]);
	return {
		controllers,
		running: controllers.filter((controller) => controller.running),
		inFlightJobs: inFlightJobCount(leases, runners),
		busyRunners: runners.filter((runner) => runner.presence.busy).length,
		onlineRunners: runners.filter(
			(runner) => runner.presence.status === "online",
		).length,
		advert,
	};
}

function servingGaps(
	snap: HostSnapshot,
	input: Readonly<{
		hostId: string;
		hostKind: RunnerHostKind;
		digest: string;
		nowMs: number;
		startedAtMs?: number;
		advertDigestRequired?: boolean;
	}>,
): readonly string[] {
	const gaps: string[] = [];
	const atTarget = snap.running.filter(
		(controller) => controller.digest === input.digest,
	);
	if (atTarget.length === 0)
		gaps.push(`no controller running at ${input.digest}`);
	if (snap.running.length > atTarget.length)
		gaps.push(
			`another controller is running (${snap.running
				.filter((controller) => controller.digest !== input.digest)
				.map((controller) => controller.digest)
				.join(", ")})`,
		);
	if (input.hostKind === "local-runner" && snap.onlineRunners === 0)
		gaps.push("no registered runner is online");
	const advert = snap.advert;
	if (!advert) gaps.push("no mesh advert");
	else {
		if (advert.id !== input.hostId)
			gaps.push(`the mesh advert names ${advert.id}`);
		if (advert.validUntilMs <= input.nowMs)
			gaps.push("the mesh advert expired");
		if (!advert.healthy) gaps.push("the mesh advert is not healthy");
		if (
			advert.controllerDigest !== undefined &&
			advert.controllerDigest !== input.digest
		)
			gaps.push(`the mesh advert is at ${advert.controllerDigest}`);
		if (input.advertDigestRequired && advert.controllerDigest === undefined)
			gaps.push("the mesh advert names no controller digest");
		if (
			input.startedAtMs !== undefined &&
			advert.controllerDigest === undefined &&
			(advert.sinceMs === undefined || advert.sinceMs < input.startedAtMs)
		)
			gaps.push("the mesh advert predates the new controller");
	}
	return gaps;
}

type RunnerHostAdvertOutputs = {
	healthy: boolean;
	validUntilMs: number;
	sinceMs?: number;
	controllerDigest?: string;
	labels: string[];
};
type RunnerHostClaims = { platform?: string; capacity?: string };
type RunnerHostOutputs = {
	hostId: string;
	controllerDigest: string;
	containerName: string;
	containerId: string;
	image: string;
	inFlightJobs: number;
	busyRunners: number;
	onlineRunners: number;
	serving: boolean;
	claims: RunnerHostClaims;
	retained: string[];
	freeSlots?: number;
	meshAdvert?: RunnerHostAdvertOutputs;
};

function outcome(
	action: ResolveOutcome["action"],
	hostId: string,
	desired: Pick<DesiredController, "repository">,
	controller: Controller,
	snap: HostSnapshot,
	serving: boolean,
	diagnostics: readonly string[],
): ResolveOutcome {
	const advert = snap.advert;
	const claims: RunnerHostClaims = {};
	const outputs: RunnerHostOutputs = {
		hostId,
		controllerDigest: controller.digest,
		containerName: controller.name,
		containerId: controller.id,
		image: `${desired.repository}@${controller.digest}`,
		inFlightJobs: snap.inFlightJobs,
		busyRunners: snap.busyRunners,
		onlineRunners: snap.onlineRunners,
		serving,
		claims,
		retained: [...RUNNER_HOST_RETAINED_FIELDS],
	};
	if (advert) {
		if (advert.platform)
			claims.platform = `${advert.platform.os}/${advert.platform.arch}`;
		const totalSlots = advert.totalSlots ?? advert.freeSlots;
		claims.capacity = String(Math.max(0, Math.floor(totalSlots)));
		outputs.freeSlots = Math.max(0, Math.floor(advert.freeSlots));
		const meshAdvert: RunnerHostAdvertOutputs = {
			healthy: advert.healthy,
			validUntilMs: advert.validUntilMs,
			labels: [...advert.labels],
		};
		if (advert.sinceMs !== undefined) meshAdvert.sinceMs = advert.sinceMs;
		if (advert.controllerDigest !== undefined)
			meshAdvert.controllerDigest = advert.controllerDigest;
		outputs.meshAdvert = meshAdvert;
	}
	return parseResolveOutcome({
		contract: RESOLVER_CONTRACT,
		action,
		physicalId: `${RUNNER_FLEET_YARD}/${hostId}/controller`,
		outputs,
		diagnostics: [...diagnostics],
	});
}

function processConfigRefusal(desired: DesiredController): void {
	const { config } = desired;
	const set = [
		...(config.command.length > 0 ? ["command"] : []),
		...(Object.keys(config.env).length > 0 ? ["env"] : []),
		...(config.volumes.length > 0 ? ["volumes"] : []),
		...(config.memoryMb === undefined ? [] : ["memoryMb"]),
		...(config.runAsUser === undefined ? [] : ["runAsUser"]),
	];
	if (set.length > 0)
		rejected(
			`runner-host-config-unsupported: this host's controller is a supervised process, which takes no container ${set.join(", ")}; drop them from the request or run the controller as a container`,
		);
}

export function createRunnerHostResolver(
	options: RunnerHostRealizerOptions,
): ResourceResolver {
	if (!HOST_ID.test(options.hostId))
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`runner-host-id-invalid: ${JSON.stringify(options.hostId)} is not a runner host id (lowercase mesh node id)`,
			RUNNER_HOST_PRODUCT_ID,
		);
	const hostId = options.hostId;
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const verifyMs = options.verifyDeadlineMs ?? DEFAULT_VERIFY_DEADLINE_MS;
	let requested = 0;
	const observe = (host: WiredHost) => snapshot(host, requested);

	async function until<T>(
		deadlineMs: number,
		probe: () => Promise<T | undefined>,
	): Promise<T | undefined> {
		const end = now() + deadlineMs;
		for (;;) {
			const answer = await probe();
			if (answer !== undefined) return answer;
			if (now() >= end) return undefined;
			await sleep(pollMs);
		}
	}

	async function withAdmissionClosed<T>(
		host: WiredHost,
		work: () => Promise<T>,
	): Promise<T> {
		await host.jobs.pauseAdmission();
		let result: T;
		try {
			result = await work();
		} catch (error) {
			await host.jobs.resumeAdmission().catch(() => undefined);
			throw error;
		}
		await host.jobs.resumeAdmission();
		return result;
	}

	async function waitForDrain(
		host: WiredHost,
		deadlineMs: number,
	): Promise<void> {
		const drained = await until(deadlineMs, async () => {
			const snap = await observe(host);
			return snap.inFlightJobs === 0 ? snap : undefined;
		});
		if (drained) return;
		const left = (await observe(host)).inFlightJobs;
		rejected(
			`runner-host-drain-deadline: ${left} job(s) still in flight after ${deadlineMs} ms; admission is reopened and the controller is unchanged (no job is cancelled); a later pass retries`,
		);
	}

	const launched = new Map<string, LaunchedSpec>();

	async function retire(host: WiredHost, controller: Controller) {
		const port = host.controller;
		if (port.mode === "process") {
			const generation = await port.process.run(undefined);
			requested = Math.max(requested, generation);
			const stopped = await until(verifyMs, async () => {
				const status = await port.process.status();
				return status !== undefined &&
					status.generation >= generation &&
					processControllerOf(status, generation) === undefined
					? status
					: undefined;
			});
			if (!stopped) {
				let restore = `asked the supervisor to run ${controller.digest} again`;
				if (controller.running)
					try {
						requested = Math.max(
							requested,
							await port.process.run(controller.digest),
						);
					} catch (error) {
						restore = `could not ask the supervisor to run ${controller.digest} again (${error instanceof Error ? error.message : "unknown"})`;
					}
				else restore = "it was not running, so nothing is restarted";
				rejected(
					`runner-host-retire-unobserved: the supervisor did not report controller ${controller.name} stopped within ${verifyMs} ms; ${restore}`,
				);
			}
		} else {
			if (controller.running)
				await port.containers.stop(controller.name, controller.id);
			try {
				await port.containers.remove(controller.name, controller.id);
			} catch {}
		}
		const still = (await observe(host)).controllers.some(
			(other) => other.id === controller.id,
		);
		if (still)
			rejected(
				`runner-host-retire-unobserved: controller ${controller.name} is still present after stop and remove`,
			);
	}

	async function prepare(host: WiredHost, image: string): Promise<void> {
		const port = host.controller;
		if (port.mode === "process") await port.process.stage(image);
		else {
			await port.containers.pull(image);
			await port.containers.inspectImage(image);
		}
	}

	async function launch(
		host: WiredHost,
		image: string,
		digest: string,
		config: DesiredController["config"],
	): Promise<number> {
		const port = host.controller;
		if (port.mode === "process") {
			await port.process.stage(image);
			const startedAtMs = now();
			requested = Math.max(requested, await port.process.run(digest));
			launched.set(digest, { image, config });
			return startedAtMs;
		}
		const spec: IsolatedContainerSpec = {
			name: controllerContainerName(digest),
			image,
			timeoutMs: CONTROLLER_TIMEOUT_MS,
			env: { ...config.env },
			command: [...config.command],
			...(config.runAsUser === undefined
				? undefined
				: { runAsUser: config.runAsUser }),
			...(config.memoryMb === undefined
				? undefined
				: { memoryMb: config.memoryMb }),
			volumes: config.volumes.map(volumeOf),
		};
		const startedAtMs = now();
		const handle = await port.containers.create(spec);
		await port.containers.start(handle.name, handle.containerId);
		launched.set(digest, { image, config });
		return startedAtMs;
	}

	async function alive(host: WiredHost, controller: Controller) {
		const port = host.controller;
		if (port.mode === "container")
			return port.containers.isRunning(controller.name, controller.id);
		const status = await port.process.status();
		return (
			processControllerOf(status, requested)?.running === true &&
			status?.digest === controller.digest
		);
	}

	async function verify(
		host: WiredHost,
		digest: string,
		startedAtMs: number | undefined,
	): Promise<Readonly<{ snap?: HostSnapshot; gaps: readonly string[] }>> {
		let gaps: readonly string[] = [];
		const snap = await until(verifyMs, async () => {
			const observed = await observe(host);
			gaps = servingGaps(observed, {
				hostId,
				hostKind: options.hostKind,
				digest,
				nowMs: now(),
				advertDigestRequired: host.controller.mode === "process",
				...(startedAtMs === undefined ? undefined : { startedAtMs }),
			});
			const live = observed.running.find(
				(controller) => controller.digest === digest,
			);
			if (gaps.length === 0 && live && !(await alive(host, live)))
				gaps = ["the controller is not running"];
			return gaps.length === 0 ? observed : undefined;
		});
		return snap ? { snap, gaps: [] } : { gaps };
	}

	async function restorePrevious(
		host: WiredHost,
		desired: DesiredController,
		previous: Controller | undefined,
		why: string,
	): Promise<Readonly<{ startedAtMs: number; source: string }>> {
		const snap = await observe(host);
		if (snap.inFlightJobs > 0)
			rejected(
				`runner-host-verify-failed: ${why}; the new controller already holds ${snap.inFlightJobs} job(s), so it is left serving rather than stopped; a later pass re-verifies`,
			);
		for (const controller of snap.controllers)
			if (controller.digest === desired.digest) await retire(host, controller);
		if (
			previous &&
			snap.running.some((controller) => controller.digest === previous.digest)
		)
			rejected(
				`runner-host-swap-failed: ${why}; the previous controller ${previous.digest} never stopped and is still serving`,
			);
		if (!previous)
			rejected(
				`runner-host-verify-failed: ${why}; there was no previous controller to restore, so the host has none`,
			);
		const known = launched.get(previous.digest);
		const spec: LaunchedSpec = known ?? {
			image: `${desired.repository}@${previous.digest}`,
			config: desired.config,
		};
		const source = known
			? "the spec this agent last launched it with"
			: "this release's repository and config (this agent never launched it, so its own spec is unknown)";
		try {
			const startedAtMs = await launch(
				host,
				spec.image,
				previous.digest,
				spec.config,
			);
			return { startedAtMs, source };
		} catch (error) {
			return rejected(
				`runner-host-rollback-failed: ${why}; relaunching the previous controller ${previous.digest} with ${source} failed (${error instanceof Error ? error.message : "unknown"}), so the host has no controller; admission is reopened; restore it by hand or run a later pass`,
			);
		}
	}

	async function rollback(
		host: WiredHost,
		desired: DesiredController,
		previous: Controller | undefined,
		why: string,
		held?: Readonly<{ startedAtMs: number; source: string }>,
	): Promise<never> {
		const { startedAtMs, source } =
			held ??
			(await withAdmissionClosed(host, () =>
				restorePrevious(host, desired, previous, why),
			));
		const digest = previous?.digest ?? desired.digest;
		const restored = await verify(host, digest, startedAtMs);
		return rejected(
			restored.snap
				? `runner-host-verify-failed: ${why}; restored and observed the previous controller ${digest} (relaunched with ${source})`
				: `runner-host-rollback-unobserved: ${why}; restored the previous controller ${digest} with ${source} but it is not yet observed serving (${restored.gaps.join("; ")})`,
		);
	}

	const resolver: ResourceResolver = {
		providerId: RUNNER_HOST_PROVIDER_ID,
		productId: RUNNER_HOST_PRODUCT_ID,
		directives: RUNNER_HOST_DIRECTIVES,

		async reconcile(raw: ResolveRequest, _transport: HttpTransport) {
			const desired = parseRequest(raw, hostId);
			const host = wired(options.host);
			if (host.controller.mode === "process") processConfigRefusal(desired);
			const before = await observe(host);
			if (before.running.length > 1)
				rejected(
					`runner-host-ambiguous: ${before.running.length} controllers are running (${before.running.map((controller) => controller.digest).join(", ")}); stop all but one by hand, a realizer never guesses which one holds jobs`,
				);
			const previous = before.running[0];

			if (previous?.digest === desired.digest) {
				const observed = await verify(host, desired.digest, undefined);
				if (!observed.snap)
					rejected(
						`runner-host-target-unobserved: the controller runs ${desired.digest} but is not observed serving (${observed.gaps.join("; ")})`,
					);
				return outcome("noop", hostId, desired, previous, observed.snap, true, [
					`controller already at ${desired.digest}; observed serving`,
				]);
			}

			try {
				await prepare(host, desired.image);
			} catch (error) {
				rejected(
					host.controller.mode === "process"
						? `runner-host-stage-failed: the release ${desired.image} could not be fetched or did not verify against its digest (${error instanceof Error ? error.message : "unknown"}); the host keeps ${previous?.digest ?? "no controller"}`
						: `runner-host-pull-failed: ${desired.image} could not be pulled or inspected (${error instanceof Error ? error.message : "unknown"}); the host keeps ${previous?.digest ?? "no controller"}`,
				);
			}

			const drainMs =
				desired.drainDeadlineMs ??
				options.drainDeadlineMs ??
				DEFAULT_DRAIN_DEADLINE_MS;
			const swap = await withAdmissionClosed(host, async () => {
				await waitForDrain(host, drainMs);
				try {
					for (const controller of (await observe(host)).controllers)
						await retire(host, controller);
					const startedAtMs = await launch(
						host,
						desired.image,
						desired.digest,
						desired.config,
					);
					return { swapped: true, startedAtMs } as const;
				} catch (error) {
					const why = `the swap to ${desired.digest} failed (${error instanceof Error ? error.message : "unknown"})`;
					const restored = await restorePrevious(host, desired, previous, why);
					return { swapped: false, why, restored } as const;
				}
			});
			if (!swap.swapped)
				return rollback(host, desired, previous, swap.why, swap.restored);
			const { startedAtMs } = swap;
			const observed = await verify(host, desired.digest, startedAtMs);
			if (!observed.snap)
				return rollback(
					host,
					desired,
					previous,
					`${desired.digest} was not observed serving (${observed.gaps.join("; ")})`,
				);
			const live = observed.snap.running.find(
				(controller) => controller.digest === desired.digest,
			);
			if (!live) return rejected("runner-host-target-unobserved");
			return outcome(
				previous ? "update" : "create",
				hostId,
				desired,
				live,
				observed.snap,
				true,
				[
					previous
						? `controller ${previous.digest} -> ${desired.digest}; drained, swapped, observed serving`
						: `controller ${desired.digest} started; observed serving`,
				],
			);
		},

		async read(raw: ResolveRequest, _transport: HttpTransport) {
			const desired = parseRequest(raw, hostId);
			const host = wired(options.host);
			const snap = await observe(host);
			const live = snap.running[0];
			if (!live) return undefined;
			const gaps = servingGaps(snap, {
				hostId,
				hostKind: options.hostKind,
				digest: live.digest,
				nowMs: now(),
				advertDigestRequired: host.controller.mode === "process",
			});
			return outcome("noop", hostId, desired, live, snap, gaps.length === 0, [
				...(snap.running.length > 1
					? [`${snap.running.length} controllers are running`]
					: []),
				...(gaps.length === 0
					? [`controller ${live.digest} observed serving`]
					: [`controller ${live.digest} not serving: ${gaps.join("; ")}`]),
			]);
		},

		async delete(raw: ResolveRequest, _transport: HttpTransport) {
			const desired = parseRequest(raw, hostId);
			const host = wired(options.host);
			await withAdmissionClosed(host, async () => {
				await waitForDrain(
					host,
					desired.drainDeadlineMs ??
						options.drainDeadlineMs ??
						DEFAULT_DRAIN_DEADLINE_MS,
				);
				for (const controller of (await observe(host)).controllers)
					await retire(host, controller);
			});
		},
	};
	return Object.freeze(resolver);
}

export function runnerHostResolverRegistry(options: RunnerHostRealizerOptions) {
	return createResolverRegistry([createRunnerHostResolver(options)]);
}

export const RUNNER_HOST_REALIZER_BINDING = Object.freeze({
	providerId: RUNNER_HOST_PROVIDER_ID,
	productId: RUNNER_HOST_PRODUCT_ID,
	bindle: RUNNER_FLEET_BINDLE,
	campSet: RUNNER_FLEET_CAMP_SET,
	yard: RUNNER_FLEET_YARD,
	slot: "service",
	logicalId: "runner-controller",
} as const);

export function runnerHostIdForCamp(campId: string): string | undefined {
	const prefix = `${RUNNER_FLEET_YARD}/`;
	if (!campId.startsWith(prefix)) return undefined;
	const hostId = campId.slice(prefix.length);
	return HOST_ID.test(hostId) ? hostId : undefined;
}

export function runnerHostResolveRequest(
	input: Readonly<{
		campId: string;
		image: string;
		credentialRef: string;
		config?: z.input<typeof ControllerConfig>;
		drainDeadlineMs?: number;
	}>,
): ResolveRequest {
	const hostId = runnerHostIdForCamp(input.campId);
	if (hostId === undefined)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`runner-host-camp-unbound: Camp ${JSON.stringify(input.campId)} is not in the ${RUNNER_FLEET_YARD} Yard`,
			RUNNER_HOST_PRODUCT_ID,
		);
	return parseResolveRequest({
		ref: {
			slot: RUNNER_HOST_REALIZER_BINDING.slot,
			productId: RUNNER_HOST_PRODUCT_ID,
			logicalId: RUNNER_HOST_REALIZER_BINDING.logicalId,
		},
		desired: {
			hostId,
			image: input.image,
			...(input.drainDeadlineMs === undefined
				? undefined
				: { drainDeadlineMs: input.drainDeadlineMs }),
			...(input.config === undefined
				? undefined
				: {
						config: {
							command: [...(input.config.command ?? [])],
							env: { ...input.config.env },
							volumes: (input.config.volumes ?? []).map(volumeOf),
							...(input.config.memoryMb === undefined
								? undefined
								: { memoryMb: input.config.memoryMb }),
							...(input.config.runAsUser === undefined
								? undefined
								: { runAsUser: input.config.runAsUser }),
						},
					}),
		},
		credentialRef: input.credentialRef,
	});
}

// domain-view: the reconcile observation parts (protobuf JSON of cd.proto ResourceObservation and CampClaimRecord).
export type RunnerHostCampReport = Readonly<{
	resource: Readonly<{
		resource: string;
		physicalId: string;
		healthy: boolean;
		kind: string;
		attributes: Readonly<Record<string, string>>;
		retained: readonly string[];
	}>;
	claims: readonly Readonly<{
		name: string;
		value: string;
		reportedBy: string;
		observedAt: string;
	}>[];
}>;

// public-contract: the claims a runner host's CD agent reports about its own health.
export const RUNNER_HOST_HEALTH_CLAIMS = Object.freeze({
	advert: "hobo.ci/mesh-advert",
	validUntil: "hobo.ci/mesh-advert-valid-until",
	ready: "hobo.ci/runner-host-ready",
} as const);

type AdvertState = "fresh" | "expired" | "missing";

type ClaimJson = Readonly<{ name: string; value: string }>;

type ParsedAdvert = Readonly<{
	healthy: boolean;
	validUntilMs: number;
	labels: readonly string[];
}>;

const AdvertOutputs = z.object({
	healthy: z.boolean(),
	validUntilMs: z.number().finite(),
	labels: z.array(z.string()).default([]),
});

function advertOutputs(
	value: ResolveOutcome["outputs"][string] | undefined,
): ParsedAdvert | undefined {
	const parsed = AdvertOutputs.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function healthClaims(
	advert: ParsedAdvert | undefined,
	serving: boolean,
	nowMs: number,
): readonly ClaimJson[] {
	const state: AdvertState =
		advert === undefined
			? "missing"
			: advert.validUntilMs <= nowMs
				? "expired"
				: "fresh";
	const ready = serving && state === "fresh" && advert?.healthy === true;
	return [
		...(state === "fresh" && advert ? servedLabelClaims(advert.labels) : []),
		{ name: RUNNER_HOST_HEALTH_CLAIMS.advert, value: state },
		...(advert
			? [
					{
						name: RUNNER_HOST_HEALTH_CLAIMS.validUntil,
						value: new Date(advert.validUntilMs).toISOString(),
					},
				]
			: []),
		{ name: RUNNER_HOST_HEALTH_CLAIMS.ready, value: String(ready) },
	];
}

export function runnerHostCampReport(
	outcome: ResolveOutcome,
	nowMs: number,
): RunnerHostCampReport {
	const outputs = outcome.outputs;
	const attribute = (key: string) => {
		const value = outputs[key];
		return value === undefined || value === null ? "" : String(value);
	};
	const claimBag = outputs.claims;
	const claims =
		claimBag !== null &&
		claimBag !== undefined &&
		!Array.isArray(claimBag) &&
		claimBag instanceof Object
			? Object.entries(claimBag).map(([name, value]) => ({
					name,
					value: String(value),
				}))
			: [];
	const observedAt = new Date(nowMs).toISOString();
	const serving = outputs.serving === true;
	const reportedBy = `runner-host:${attribute("hostId")}`;
	return Object.freeze({
		resource: Object.freeze({
			resource: RUNNER_HOST_REALIZER_BINDING.logicalId,
			physicalId: outcome.physicalId,
			healthy: serving,
			kind: RUNNER_HOST_PRODUCT_ID,
			attributes: Object.freeze({
				controllerDigest: attribute("controllerDigest"),
				image: attribute("image"),
				busyRunners: attribute("busyRunners"),
				inFlightJobs: attribute("inFlightJobs"),
				onlineRunners: attribute("onlineRunners"),
				freeSlots: attribute("freeSlots"),
			}),
			retained: RUNNER_HOST_RETAINED_FIELDS,
		}),
		claims: Object.freeze(
			[
				...claims,
				...healthClaims(advertOutputs(outputs.meshAdvert), serving, nowMs),
			].map((claim) => Object.freeze({ ...claim, reportedBy, observedAt })),
		),
	});
}

export function runnerHostAbsentReport(
	hostId: string,
	nowMs: number,
): RunnerHostCampReport {
	const observedAt = new Date(nowMs).toISOString();
	return Object.freeze({
		resource: Object.freeze({
			resource: RUNNER_HOST_REALIZER_BINDING.logicalId,
			physicalId: `${RUNNER_FLEET_YARD}/${hostId}/controller`,
			healthy: false,
			kind: RUNNER_HOST_PRODUCT_ID,
			attributes: Object.freeze({}),
			retained: RUNNER_HOST_RETAINED_FIELDS,
		}),
		claims: Object.freeze(
			healthClaims(undefined, false, nowMs).map((claim) =>
				Object.freeze({
					...claim,
					reportedBy: `runner-host:${hostId}`,
					observedAt,
				}),
			),
		),
	});
}

type HealthConditionType =
	| "CAMP_CONDITION_TYPE_REACHABLE"
	| "CAMP_CONDITION_TYPE_LEASED"
	| "CAMP_CONDITION_TYPE_READY";
type HealthConditionStatus =
	| "CONDITION_STATUS_TRUE"
	| "CONDITION_STATUS_FALSE"
	| "CONDITION_STATUS_UNKNOWN";

// domain-view: CampInventory.observe conditions from the health source (protobuf JSON of cd.proto CampConditionRecord).
export type RunnerHostHealth = Readonly<{
	advert: AdvertState;
	conditions: readonly Readonly<{
		type: HealthConditionType;
		status: HealthConditionStatus;
		source: "SIGNAL_SOURCE_HEALTH_SOURCE";
		reason: string;
	}>[];
}>;

function healthCondition(
	type: HealthConditionType,
	status: HealthConditionStatus,
	reason: string,
) {
	return Object.freeze({
		type,
		status,
		source: "SIGNAL_SOURCE_HEALTH_SOURCE" as const,
		reason,
	});
}

export function runnerHostHealthConditions(
	claims: readonly ClaimJson[],
	nowMs: number,
): RunnerHostHealth {
	const value = (name: string) =>
		claims.find((claim) => claim.name === name)?.value;
	const until = Date.parse(value(RUNNER_HOST_HEALTH_CLAIMS.validUntil) ?? "");
	const reported = value(RUNNER_HOST_HEALTH_CLAIMS.advert);
	const advert: AdvertState =
		reported !== "fresh" && reported !== "expired"
			? "missing"
			: reported === "expired" || !Number.isFinite(until) || until <= nowMs
				? "expired"
				: "fresh";
	if (advert === "missing")
		return Object.freeze({
			advert,
			conditions: Object.freeze([
				healthCondition(
					"CAMP_CONDITION_TYPE_REACHABLE",
					"CONDITION_STATUS_UNKNOWN",
					"mesh-advert-missing",
				),
				healthCondition(
					"CAMP_CONDITION_TYPE_LEASED",
					"CONDITION_STATUS_UNKNOWN",
					"mesh-advert-missing",
				),
				healthCondition(
					"CAMP_CONDITION_TYPE_READY",
					"CONDITION_STATUS_UNKNOWN",
					"mesh-advert-missing",
				),
			]),
		});
	if (advert === "expired")
		return Object.freeze({
			advert,
			conditions: Object.freeze([
				healthCondition(
					"CAMP_CONDITION_TYPE_REACHABLE",
					"CONDITION_STATUS_FALSE",
					"mesh-advert-expired",
				),
				healthCondition(
					"CAMP_CONDITION_TYPE_LEASED",
					"CONDITION_STATUS_FALSE",
					"mesh-lease-expired",
				),
				healthCondition(
					"CAMP_CONDITION_TYPE_READY",
					"CONDITION_STATUS_FALSE",
					"mesh-advert-expired",
				),
			]),
		});
	return Object.freeze({
		advert,
		conditions: Object.freeze([
			healthCondition(
				"CAMP_CONDITION_TYPE_REACHABLE",
				"CONDITION_STATUS_TRUE",
				"mesh-advert-fresh",
			),
			healthCondition(
				"CAMP_CONDITION_TYPE_LEASED",
				"CONDITION_STATUS_TRUE",
				`mesh-lease-valid-until:${new Date(until).toISOString()}`,
			),
			value(RUNNER_HOST_HEALTH_CLAIMS.ready) === "true"
				? healthCondition(
						"CAMP_CONDITION_TYPE_READY",
						"CONDITION_STATUS_TRUE",
						"runner-host-healthy",
					)
				: healthCondition(
						"CAMP_CONDITION_TYPE_READY",
						"CONDITION_STATUS_FALSE",
						"runner-host-draining-or-pressured",
					),
		]),
	});
}
