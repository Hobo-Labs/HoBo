/**
 * The runner-host realizer: HoBo CD moving one self-hosted runner host (the
 * box worker, a mesh node or a local runner) to a runner controller image
 * digest (plan 0024, decision R2; `deploy/runner-fleet/README.md`).
 *
 * It is a typed `ResourceResolver` from `@hobo/core`, run by `hobo deploy
 * agent run` on the host itself. The resource is the runner controller at an
 * image digest plus its declared, non-secret config. There is no shell script
 * and no new exec: every host effect goes through two typed ports the package
 * already has the shape of.
 *
 * - **Containers** are the isolated worker's `DockerDriver` methods
 *   (`listWorkerContainers`, `inspectImage`, `create`, `start`, `stop`,
 *   `remove`, `isRunning`) plus the deps-image `pull`. The controller
 *   container is named `hoboci-runner-controller-<sha256 hex>`, so the digest
 *   a host runs is read back from the host, never remembered.
 * - **Jobs** are what the host already knows about its work: its leases
 *   (`ACTIVE_STATES` and `runnerCustody`), its registered runners'
 *   presence, its own signed mesh advertisement, and the admission gate the
 *   worker's drain mode closes.
 *
 * `reconcile` (converge): pull the target by digest, close admission, wait for
 * in-flight jobs to finish up to a deadline, swap the controller, reopen
 * admission and verify by observation (controller running, runner presence,
 * a fresh healthy mesh advert from after the swap). It never picks up, stops
 * or cancels a running job: a drain that runs out of time reopens admission
 * and refuses without touching the controller, and a rollback that would
 * stop a controller holding a job leaves it serving and refuses instead. On a
 * failed verification it restores the previous digest; the rollback itself is
 * a Delta CD records, this only leaves the host serving. Admission is closed
 * only inside `withAdmissionClosed`, which reopens it on every exit, so no
 * port error or failed swap leaves the host refusing work.
 *
 * A rollback relaunches the previous digest with the spec this agent last
 * launched it with. When this agent never launched it (a restarted agent, a
 * hand-started controller) the container driver cannot read a spec back, so
 * the rollback uses this release's repository and config and says so.
 *
 * `read` (observe): the controller digest, in-flight jobs and runner
 * presence (retained fields: they change with load, never drift), and the
 * advert's platform and capacity (claims: observed facts that only narrow).
 *
 * Idempotent by digest: a host already serving the target, observed, is a
 * `noop`. Nothing is reported converged that was not observed (I5). The
 * request's `credentialRef` names the registry read credential the host's
 * container engine already holds; this module never resolves or sees it (I9).
 */
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
	type RunnerHostKind,
	servedLabelClaims,
} from "./runner-fleet-delivery.js";

// public-contract: the resolver identity the runner fleet's Camps resolve to.
export const RUNNER_HOST_PROVIDER_ID = "hobo-ci";
// public-contract: the runner controller product, keyed by the resolver registry.
export const RUNNER_HOST_PRODUCT_ID = "hobo-ci.runner-host/v1";
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

/** The box worker's drain (`deploy/restart-worker.sh`): two hours. */
const DEFAULT_DRAIN_DEADLINE_MS = 2 * 60 * 60_000;
const DEFAULT_VERIFY_DEADLINE_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_DRAIN_DEADLINE_MS = 24 * 60 * 60_000;
/** The controller is long-lived; the driver labels every container with a timeout. */
const CONTROLLER_TIMEOUT_MS = 365 * 24 * 60 * 60_000;
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const IMAGE_BY_DIGEST =
	/^(?<repository>[a-z0-9][a-z0-9._/:-]{0,254})@sha256:(?<hex>[0-9a-f]{64})$/u;

/**
 * Traffic routing on a runner host: none. Which host takes a job is decided
 * by the route job and the relay (`ci/RUNNER-QUEUE.md`), not by CD, so every
 * offering is declared absent rather than preview. `provider` is `other`: the
 * core union has no member for a self-hosted runner host.
 */
export const RUNNER_HOST_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze([]),
	});

const JOB_ROUTING =
	"Jobs reach a runner host through GitHub's queue, the route job and the relay; the host serves no request traffic CD could shift";

/** Every traffic-routing offering, declared absent with the reason. */
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

/** Typed `RESOLVER_PRODUCT_UNSUPPORTED` for a product this realizer does not own. */
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

// ── Host ports ─────────────────────────────────────────────────────────────

/** The container interface: the isolated worker's Docker driver plus the deps-image pull. */
export type RunnerControllerContainers = Pick<
	DockerDriver,
	"create" | "start" | "stop" | "remove" | "isRunning"
> &
	Required<Pick<DockerDriver, "inspectImage" | "listWorkerContainers">> &
	Pick<DepsImageDockerPort, "pull">;

/** The host's mesh advertisement; `controllerDigest` when the advert carries one. */
export type RunnerHostAdvert = MeshNode &
	Readonly<{ controllerDigest?: string | undefined }>;

/** One runner this host registered with GitHub, and its presence. */
export type RunnerHostRegistration = Readonly<{
	name: string;
	presence: GithubRunnerPresence;
}>;

/** What the host knows about its own work. */
export interface RunnerHostJobs {
	/** The host's leases (the worker's lease store). */
	leases(): Promise<readonly Lease[]>;
	/** Runners the host registered, with GitHub presence. */
	runners(): Promise<readonly RunnerHostRegistration[]>;
	/** The host's own advertisement as the mesh reads it. */
	meshAdvert(): Promise<RunnerHostAdvert | undefined>;
	/** Stop admitting new jobs (the worker's drain mode). Running jobs are untouched. */
	pauseAdmission(): Promise<void>;
	/** Admit jobs again. */
	resumeAdmission(): Promise<void>;
}

/** The ports as a host wires them; a missing method is a typed refusal, not a crash. */
export type RunnerHostPorts = Readonly<{
	containers?: Partial<RunnerControllerContainers> | undefined;
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
const JOB_METHODS = [
	"leases",
	"meshAdvert",
	"pauseAdmission",
	"resumeAdmission",
	"runners",
] as const;

/** The port methods a host has not wired (`containers.pull`, `jobs.leases`, ...). */
export function runnerHostInterfaceGaps(
	host: RunnerHostPorts,
): readonly string[] {
	const containers: Partial<RunnerControllerContainers> = host.containers ?? {};
	const jobs: Partial<RunnerHostJobs> = host.jobs ?? {};
	return Object.freeze([
		...CONTAINER_METHODS.filter(
			(name) => !(containers[name] instanceof Function),
		).map((name) => `containers.${name}`),
		...JOB_METHODS.filter((name) => !(jobs[name] instanceof Function)).map(
			(name) => `jobs.${name}`,
		),
	]);
}

type WiredHost = Readonly<{
	containers: RunnerControllerContainers;
	jobs: RunnerHostJobs;
}>;

function wired(host: RunnerHostPorts): WiredHost {
	const gaps = runnerHostInterfaceGaps(host);
	if (gaps.length > 0)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			`runner-host-interface-missing: this host has no ${gaps.join(", ")}; the runner-host realizer acts only through the worker's container driver and job ports, so wire them (packages/ci-gh-actions/README.md, Runner-host realizer) or run this host's upgrades by hand`,
			RUNNER_HOST_PRODUCT_ID,
		);
	// SAFETY: runnerHostInterfaceGaps checked every method of both ports above.
	return host as WiredHost;
}

// ── Options and desired state ───────────────────────────────────────────────

export type RunnerHostRealizerOptions = Readonly<{
	/** The host this agent runs on: its mesh node id, the Camp's last segment. */
	hostId: string;
	/** A local runner keeps a registered runner; JIT hosts register per job. */
	hostKind: RunnerHostKind;
	host: RunnerHostPorts;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollIntervalMs?: number;
	/** Default drain deadline; `desired.drainDeadlineMs` overrides it per pass. */
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

/** One controller mount, as the container driver takes it. */
type ControllerVolume = { source: string; target: string; readonly?: boolean };

/** A mount without an absent `readonly` key (JSON has no undefined). */
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

/** What a controller was launched with: the image reference and its config. */
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

// ── Observation ────────────────────────────────────────────────────────────

type Controller = Readonly<{ container: DockerContainer; digest: string }>;

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
		? { container, digest: `sha256:${hex}` }
		: undefined;
}

/** Jobs this host is carrying: active leases it has not handed to another runner. */
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

async function snapshot(host: WiredHost): Promise<HostSnapshot> {
	const [containers, leases, runners, advert] = await Promise.all([
		host.containers.listWorkerContainers(),
		host.jobs.leases(),
		host.jobs.runners(),
		host.jobs.meshAdvert(),
	]);
	const controllers = containers.flatMap((container) => {
		const controller = controllerOf(container);
		return controller ? [controller] : [];
	});
	return {
		controllers,
		running: controllers.filter(
			(controller) => controller.container.state === "running",
		),
		inFlightJobs: inFlightJobCount(leases, runners),
		busyRunners: runners.filter((runner) => runner.presence.busy).length,
		onlineRunners: runners.filter(
			(runner) => runner.presence.status === "online",
		).length,
		advert,
	};
}

/** Why the host is not yet observed serving `digest`; empty when it is. */
function servingGaps(
	snap: HostSnapshot,
	input: Readonly<{
		hostId: string;
		hostKind: RunnerHostKind;
		digest: string;
		nowMs: number;
		/** Set after a swap: the advert must come from the new controller. */
		startedAtMs?: number;
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
		if (
			input.startedAtMs !== undefined &&
			advert.controllerDigest === undefined &&
			(advert.sinceMs === undefined || advert.sinceMs < input.startedAtMs)
		)
			gaps.push("the mesh advert predates the new controller");
	}
	return gaps;
}

/** The advert as a resolver outcome reports it. */
type RunnerHostAdvertOutputs = {
	healthy: boolean;
	validUntilMs: number;
	sinceMs?: number;
	controllerDigest?: string;
	/** The runner labels the advert says this host serves. */
	labels: string[];
};
/** Observed facts that only narrow placement. */
type RunnerHostClaims = { platform?: string; capacity?: string };
/** A runner-host resolver outcome's `outputs`. */
type RunnerHostOutputs = {
	hostId: string;
	controllerDigest: string;
	containerName: string;
	containerId: string;
	image: string;
	inFlightJobs: number;
	busyRunners: number;
	onlineRunners: number;
	/** Observed serving at `controllerDigest` (no serving gaps). */
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
		containerName: controller.container.name,
		containerId: controller.container.containerId,
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

// ── The resolver ───────────────────────────────────────────────────────────

/**
 * The runner-host realizer for one host. The composition registers it for the
 * runner fleet's Camps (`RUNNER_HOST_REALIZER_BINDING`); the host ports are
 * checked on every call, so a host without them refuses with a typed
 * `RESOLVER_PRODUCT_UNSUPPORTED` naming what is missing.
 */
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

	/** Poll until `probe` answers or the deadline passes. */
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

	/** Run `work` with admission closed; admission reopens on every exit. */
	async function withAdmissionClosed<T>(
		host: WiredHost,
		work: () => Promise<T>,
	): Promise<T> {
		await host.jobs.pauseAdmission();
		let result: T;
		try {
			result = await work();
		} catch (error) {
			// The work's error is the one to report; a failed reopen must not hide it.
			await host.jobs.resumeAdmission().catch(() => undefined);
			throw error;
		}
		await host.jobs.resumeAdmission();
		return result;
	}

	/** With admission closed: wait for in-flight jobs; refuse at the deadline. */
	async function waitForDrain(
		host: WiredHost,
		deadlineMs: number,
	): Promise<void> {
		const drained = await until(deadlineMs, async () => {
			const snap = await snapshot(host);
			return snap.inFlightJobs === 0 ? snap : undefined;
		});
		if (drained) return;
		const left = (await snapshot(host)).inFlightJobs;
		rejected(
			`runner-host-drain-deadline: ${left} job(s) still in flight after ${deadlineMs} ms; admission is reopened and the controller is unchanged (no job is cancelled); a later pass retries`,
		);
	}

	/** Specs this agent launched, by digest, so a rollback restores what ran. */
	const launched = new Map<string, LaunchedSpec>();

	/** Stop and remove a controller; observe that it is gone. */
	async function retire(host: WiredHost, controller: Controller) {
		const { name, containerId } = controller.container;
		if (controller.container.state === "running")
			await host.containers.stop(name, containerId);
		try {
			await host.containers.remove(name, containerId);
		} catch {
			// The driver creates with --rm, so a stopped controller may already
			// be gone; the listing below decides.
		}
		const still = (await snapshot(host)).controllers.some(
			(other) => other.container.containerId === containerId,
		);
		if (still)
			rejected(
				`runner-host-retire-unobserved: controller ${name} is still present after stop and remove`,
			);
	}

	async function launch(
		host: WiredHost,
		image: string,
		digest: string,
		config: DesiredController["config"],
	): Promise<number> {
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
		const handle = await host.containers.create(spec);
		await host.containers.start(handle.name, handle.containerId);
		launched.set(digest, { image, config });
		return startedAtMs;
	}

	async function verify(
		host: WiredHost,
		digest: string,
		startedAtMs: number | undefined,
	): Promise<Readonly<{ snap?: HostSnapshot; gaps: readonly string[] }>> {
		let gaps: readonly string[] = [];
		const snap = await until(verifyMs, async () => {
			const observed = await snapshot(host);
			gaps = servingGaps(observed, {
				hostId,
				hostKind: options.hostKind,
				digest,
				nowMs: now(),
				...(startedAtMs === undefined ? undefined : { startedAtMs }),
			});
			const live = observed.running.find(
				(controller) => controller.digest === digest,
			);
			if (
				gaps.length === 0 &&
				live &&
				!(await host.containers.isRunning(
					live.container.name,
					live.container.containerId,
				))
			)
				gaps = ["the controller container is not running"];
			return gaps.length === 0 ? observed : undefined;
		});
		return snap ? { snap, gaps: [] } : { gaps };
	}

	/**
	 * With admission closed: retire the failed controller and relaunch the
	 * previous digest. Returns when it was started; refuses when it must not
	 * or could not be.
	 */
	async function restorePrevious(
		host: WiredHost,
		desired: DesiredController,
		previous: Controller | undefined,
		why: string,
	): Promise<Readonly<{ startedAtMs: number; source: string }>> {
		const snap = await snapshot(host);
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

	/**
	 * Undo a failed swap without cancelling anything; always throws. `held`
	 * is a restore already done while the caller had admission closed;
	 * otherwise it is done here under a closed admission. Verification runs
	 * with admission open: a controller that admits nothing never advertises
	 * healthy.
	 */
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
			const before = await snapshot(host);
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
				await host.containers.pull(desired.image);
				await host.containers.inspectImage(desired.image);
			} catch (error) {
				rejected(
					`runner-host-pull-failed: ${desired.image} could not be pulled or inspected (${error instanceof Error ? error.message : "unknown"}); the host keeps ${previous?.digest ?? "no controller"}`,
				);
			}

			const drainMs =
				desired.drainDeadlineMs ??
				options.drainDeadlineMs ??
				DEFAULT_DRAIN_DEADLINE_MS;
			// Drain, swap and (on a failed swap) restore all run with admission
			// closed; it reopens on every exit, refusals and port errors included.
			const swap = await withAdmissionClosed(host, async () => {
				await waitForDrain(host, drainMs);
				try {
					// Stopped controllers left behind by an earlier pass go too.
					for (const controller of (await snapshot(host)).controllers)
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
			const snap = await snapshot(host);
			const live = snap.running[0];
			if (!live) return undefined;
			const gaps = servingGaps(snap, {
				hostId,
				hostKind: options.hostKind,
				digest: live.digest,
				nowMs: now(),
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
				for (const controller of (await snapshot(host)).controllers)
					await retire(host, controller);
			});
		},
	};
	return Object.freeze(resolver);
}

/** The registry the hobo composition registers on a runner host's agent. */
export function runnerHostResolverRegistry(options: RunnerHostRealizerOptions) {
	return createResolverRegistry([createRunnerHostResolver(options)]);
}

// ── Camp binding ───────────────────────────────────────────────────────────

/**
 * Which Camps resolve to this realizer: every Camp of the runner fleet Yard,
 * `hobo-ci-runners/<host id>`, in the `hobo-ci-runner-fleet` Camp set.
 */
export const RUNNER_HOST_REALIZER_BINDING = Object.freeze({
	providerId: RUNNER_HOST_PROVIDER_ID,
	productId: RUNNER_HOST_PRODUCT_ID,
	bindle: RUNNER_FLEET_BINDLE,
	campSet: RUNNER_FLEET_CAMP_SET,
	yard: RUNNER_FLEET_YARD,
	slot: "service",
	logicalId: "runner-controller",
} as const);

/** The host id a runner fleet Camp names, or undefined for any other Camp. */
export function runnerHostIdForCamp(campId: string): string | undefined {
	const prefix = `${RUNNER_FLEET_YARD}/`;
	if (!campId.startsWith(prefix)) return undefined;
	const hostId = campId.slice(prefix.length);
	return HOST_ID.test(hostId) ? hostId : undefined;
}

/**
 * The resolve request for one runner fleet Camp and one image digest, as the
 * composition builds it from a resolved Set. Refuses a Camp outside the fleet.
 */
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
	/** `fresh`, `expired` or `missing`: the host's own mesh advertisement. */
	advert: "hobo.ci/mesh-advert",
	/** ISO time the advertised mesh lease is valid until (absent when missing). */
	validUntil: "hobo.ci/mesh-advert-valid-until",
	/** `true` only when the controller is observed serving and the advert is fresh and healthy. */
	ready: "hobo.ci/runner-host-ready",
} as const);

type AdvertState = "fresh" | "expired" | "missing";

type ClaimJson = Readonly<{ name: string; value: string }>;

type ParsedAdvert = Readonly<{
	healthy: boolean;
	validUntilMs: number;
	labels: readonly string[];
}>;

/** The advert part of an outcome's outputs, parsed; undefined when absent or malformed. */
function advertOutputs(value: unknown): ParsedAdvert | undefined {
	if (value === null || Array.isArray(value) || !(value instanceof Object))
		return undefined;
	const healthy: unknown = Reflect.get(value, "healthy");
	const validUntilMs: unknown = Reflect.get(value, "validUntilMs");
	const labels: unknown = Reflect.get(value, "labels");
	if (healthy !== true && healthy !== false) return undefined;
	if (!Number.isFinite(validUntilMs)) return undefined;
	return {
		healthy,
		validUntilMs: Number(validUntilMs),
		labels: Array.isArray(labels)
			? labels.flatMap((label: unknown) =>
					typeof label === "string" ? [label] : [],
				)
			: [],
	};
}

/**
 * Health evidence as claims: what the host's own advert says (fresh, expired
 * or missing, and until when), whether the host is ready (serving and a fresh
 * healthy advert), and while the advert is fresh the runner labels it serves.
 * Plain claims, so they ride the reconcile observation to the Station, which
 * turns them into inventory conditions (`runnerHostHealthConditions`).
 */
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

/**
 * What a resolver outcome says in a CD reconcile observation: one resource
 * (the controller, its digest, retained job counts), the observed claims
 * (platform, capacity) and the host's health claims
 * (`RUNNER_HOST_HEALTH_CLAIMS` and served labels). Plain protobuf JSON, so the
 * composition that owns `@hobo/cd` builds the record; this package does not
 * depend on it.
 */
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
	// Typed, never parsed from diagnostic text: absent or not `true` is unhealthy.
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

/** The report for a host with no controller at all: nothing serving, advert missing. */
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
	/** The advert as the Station reads it at its own clock. */
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

/**
 * The Station's reading of a runner host's health claims, as the same
 * REACHABLE / LEASED / READY table `runnerFleetCampObservations` applies to
 * the mesh board (deploy/runner-fleet/README.md): fresh and healthy is all
 * TRUE; fresh but draining or pressured is READY false; an advert whose lease
 * has lapsed at `nowMs` (the Station's clock, not the agent's) is all FALSE;
 * no evidence is all UNKNOWN, never assumed healthy.
 */
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
