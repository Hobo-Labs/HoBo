/**
 * The runner-host realizer as `hobo deploy agent run` registers it on a
 * runner host (plan 0024, decision R2; packages/ci-gh-actions/deploy/
 * runner-fleet/README.md), and the Station's reading of what such an agent
 * reports.
 *
 * Agent side: `createRunnerHostRealizer` adapts the typed `ResourceResolver`
 * from `@hobo/ci-gh-actions/runner-host` to the `@hobo/cd` `Realizer` port.
 * The image a Set asks for is the runner-host row of its resolved plan
 * (`productId` `hobo-ci.runner-host/v1`, `realizationParameters.image`, pinned
 * by digest); converge drains, swaps the controller by digest and verifies by
 * observation, and a refusal (a drain deadline, a failed verify restored to
 * the previous digest, a missing host port) is a BLOCKED observation with the
 * realizer's own code. Every observation carries the host's health claims
 * (mesh advert, lease, readiness, served labels).
 *
 * Station side: `withRunnerHostHealthIngest` wraps the delivery feed so an
 * accepted observation from a runner-host agent also reaches
 * `CampInventory.observe` as health-source conditions (REACHABLE / LEASED /
 * READY) and claims, and a host that is not ready carries the NO_PLACE taint
 * `hobo.ci/runner-host-unready` until it is: placement skips it and a fan-out
 * defers it. Nothing here grants: claims only narrow.
 *
 * Credentials: the request names the registry read credential by locator
 * (`credentialRef`); the host's container engine holds it, and nothing here
 * resolves, logs or records it.
 */

import {
	create,
	fromJson,
	type JsonValue as ProtoJson,
} from "@bufbuild/protobuf";
import {
	type CampClaimRecord,
	CampClaimRecordSchema,
	CampConditionRecordSchema,
	type CampId,
	type CampInventory,
	type CdContext,
	type CdFactories,
	type FeedRequest,
	type Outcome,
	type RealizeInput,
	type Realizer,
	ReasonRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	ResourceObservationSchema,
	SignalSource,
	TaintEffect,
	TaintRecordSchema,
} from "@hobo/cd";
import {
	RUNNER_FLEET_YARD,
	RUNNER_HOST_PRODUCT_ID,
	type RunnerHostCampReport,
	type RunnerHostKind,
	type RunnerReleaseParameter,
	runnerHostAbsentReport,
	runnerHostCampReport,
	runnerHostHealthConditions,
	runnerHostIdForCamp,
	runnerHostResolveRequest,
} from "@hobo/ci-gh-actions/runner-host";
import {
	type HttpTransport,
	type ResolveOutcome,
	ResolverError,
	type ResourceResolver,
} from "@hobo/core";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

// public-contract: env var naming the runner-host agent config file on a runner host.
export const CD_RUNNER_HOST_ENV = "HOBO_CD_RUNNER_HOST";

// public-contract: the NO_PLACE taint the Station keeps on a runner host that is not ready.
export const RUNNER_HOST_UNREADY_TAINT = "hobo.ci/runner-host-unready";

const HOST_KINDS: readonly RunnerHostKind[] = [
	"box-worker",
	"mesh-node",
	"local-runner",
];
/** A credential locator (`env://NAME`, `op://…`), never a value. */
const CREDENTIAL_LOCATOR = /^[a-z][a-z0-9+.-]*:\/\/[^\s]{1,256}$/u;
const DOCKER_BINARY = /^(?:docker|podman|\/[^\s\0]{1,255})$/u;
const MAX_DRAIN_MS = 24 * 60 * 60_000;
const ABSOLUTE_PATH = /^\/[^\0]{1,4095}$/u;
/** An https base URL for controller releases; no userinfo, so no credential. */
const RELEASE_URL = /^https:\/\/[^\s@/]{1,253}(?:\/[^\s@]{0,2048})?$/u;

/** What a runner host's agent is told about itself (`HOBO_CD_RUNNER_HOST`). */
export type RunnerHostAgentConfig = Readonly<{
	/** The host's mesh node id; its Camp is `hobo-ci-runners/<hostId>`. */
	hostId: string;
	hostKind: RunnerHostKind;
	/** Locator of the registry read credential the host's engine holds. */
	credentialRef: string;
	/** The container engine CLI (default `docker`). */
	dockerBinary?: string;
	/**
	 * The box worker's journal (`HOBO_CI_WORKER_DB`); the job ports are read
	 * from its directory. Default: the worker's own default path. A local
	 * runner names its state directory instead (`worker.directory`), which
	 * has no journal: its database path is `worker.sqlite` there.
	 */
	workerDatabase?: string;
	drainDeadlineMs?: number;
	/**
	 * How the controller runs: a container (the default) or a process the
	 * worker daemon's supervisor runs, with releases fetched by digest from
	 * `releases` (an absolute directory or an `https://` base URL).
	 */
	controller?: RunnerHostControllerConfig;
}>;

export type RunnerHostControllerConfig =
	| Readonly<{ mode: "container" }>
	| Readonly<{ mode: "process"; releases: string }>;

function refusal(code: string, message: string, remediation: string) {
	return {
		ok: false as const,
		reasons: [create(ReasonRecordSchema, { code, message, remediation })],
	};
}

const CONFIG_REMEDIATION = `Write the runner host's agent config as JSON {"hostId":"<mesh node id>","hostKind":"box-worker|mesh-node|local-runner","credentialRef":"env://<NAME>","docker":{"binary":"docker"},"worker":{"database":"/var/lib/hobo-ci/worker.sqlite"} or {"directory":"<local runner state directory>"},"controller":{"mode":"container"} or {"mode":"process","releases":"<absolute directory or https:// base URL>"},"drainDeadlineMs":7200000} and name it with ${CD_RUNNER_HOST_ENV} (packages/ci-gh-actions/deploy/runner-fleet/README.md).`;

/** Parse the agent config once; every problem is listed, nothing partial is returned. */
export function parseRunnerHostAgentConfig(
	value: JsonValue,
): Outcome<RunnerHostAgentConfig> {
	if (!isJsonObject(value))
		return refusal(
			"runner-host-config-invalid",
			"the runner-host agent config must be a JSON object",
			CONFIG_REMEDIATION,
		);
	const problems: string[] = [];
	const hostId = value.hostId;
	const hostKind = value.hostKind;
	const credentialRef = value.credentialRef;
	const docker = value.docker;
	const drain = value.drainDeadlineMs;
	const worker = value.worker;
	const controllerValue = value.controller;
	const known = new Set([
		"hostId",
		"hostKind",
		"credentialRef",
		"docker",
		"worker",
		"drainDeadlineMs",
		"controller",
	]);
	for (const key of Object.keys(value))
		if (!known.has(key)) problems.push(`unknown field ${key}`);
	if (
		!isJsonString(hostId) ||
		runnerHostIdForCamp(`${RUNNER_FLEET_YARD}/${hostId}`) === undefined
	)
		problems.push("hostId must be the host's lowercase mesh node id");
	const kind = HOST_KINDS.find((k) => k === hostKind);
	if (kind === undefined)
		problems.push("hostKind must be box-worker, mesh-node or local-runner");
	if (!isJsonString(credentialRef) || !CREDENTIAL_LOCATOR.test(credentialRef))
		problems.push(
			"credentialRef must be a credential locator such as env://NAME, never a secret value",
		);
	let binary: string | undefined;
	if (docker !== undefined) {
		const candidate = isJsonObject(docker) ? docker.binary : undefined;
		if (
			!isJsonObject(docker) ||
			Object.keys(docker).some((key) => key !== "binary") ||
			(candidate !== undefined &&
				(!isJsonString(candidate) || !DOCKER_BINARY.test(candidate)))
		)
			problems.push(
				"docker must be {binary: docker|podman|<absolute path>} when given",
			);
		else if (isJsonString(candidate)) binary = candidate;
	}
	let workerDatabase: string | undefined;
	if (worker !== undefined) {
		const keys = isJsonObject(worker) ? Object.keys(worker) : [];
		const key = keys.length === 1 ? keys[0] : undefined;
		const candidate =
			isJsonObject(worker) && key !== undefined ? worker[key] : undefined;
		if (
			(key !== "database" && key !== "directory") ||
			!isJsonString(candidate) ||
			!ABSOLUTE_PATH.test(candidate)
		)
			problems.push(
				"worker must be {database: <absolute path of the worker's journal>} or {directory: <absolute path of a local runner's state directory>} when given",
			);
		else
			workerDatabase =
				key === "database"
					? candidate
					: `${candidate.replace(/\/+$/u, "")}/worker.sqlite`;
	}
	let controller: RunnerHostControllerConfig | undefined;
	if (controllerValue !== undefined) {
		const mode = isJsonObject(controllerValue)
			? controllerValue.mode
			: undefined;
		const releases = isJsonObject(controllerValue)
			? controllerValue.releases
			: undefined;
		if (
			isJsonObject(controllerValue) &&
			mode === "container" &&
			Object.keys(controllerValue).every((k) => k === "mode")
		)
			controller = { mode: "container" };
		else if (
			isJsonObject(controllerValue) &&
			mode === "process" &&
			Object.keys(controllerValue).every(
				(k) => k === "mode" || k === "releases",
			) &&
			isJsonString(releases) &&
			(ABSOLUTE_PATH.test(releases) || RELEASE_URL.test(releases))
		)
			controller = { mode: "process", releases };
		else
			problems.push(
				"controller must be {mode: container} or {mode: process, releases: <absolute directory or https:// base URL with no credentials>} when given",
			);
	}
	if (
		drain !== undefined &&
		(!isJsonNumber(drain) ||
			!Number.isInteger(drain) ||
			drain < 0 ||
			drain > MAX_DRAIN_MS)
	)
		problems.push("drainDeadlineMs must be whole milliseconds up to 24 hours");
	if (
		problems.length > 0 ||
		!isJsonString(hostId) ||
		kind === undefined ||
		!isJsonString(credentialRef)
	)
		return refusal(
			"runner-host-config-invalid",
			problems.join("; "),
			CONFIG_REMEDIATION,
		);
	return {
		ok: true,
		value: Object.freeze({
			hostId,
			hostKind: kind,
			credentialRef,
			...(binary ? { dockerBinary: binary } : undefined),
			...(workerDatabase ? { workerDatabase } : undefined),
			...(isJsonNumber(drain) ? { drainDeadlineMs: drain } : undefined),
			...(controller ? { controller } : undefined),
		}),
	};
}

// ── Agent side ─────────────────────────────────────────────────────────────

const IMAGE_BY_DIGEST = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/u;

/** Which realization parameter of the runner-host row a host runs. */
export type RunnerHostReference = "image" | RunnerReleaseParameter;

/**
 * The controller a resolved Set asks a runner host for: the plan row the Set
 * resolved to `hobo-ci.runner-host/v1`, its `reference` realization parameter
 * (`image` for a container, the host kind's release for a supervised
 * process: `runnerHostRealizationParameters`), pinned by digest. Undefined
 * when the Set has no such row or the row has no such parameter.
 */
export function runnerHostImageOf(
	resolved: RealizeInput["resolved"],
	reference: RunnerHostReference = "image",
): string | undefined {
	for (const resource of resolved.plan.resources) {
		if (resource.productId !== RUNNER_HOST_PRODUCT_ID) continue;
		const image = resource.realizationParameters?.[reference];
		if (isJsonString(image) && IMAGE_BY_DIGEST.test(image)) return image;
	}
	return undefined;
}

/** `runner-host-<what>` from a realizer refusal, else the generic code. */
function codeOf(message: string): string {
	return /^(runner-host-[a-z-]+)/u.exec(message)?.[1] ?? "realize-failed";
}

function claimsOf(report: RunnerHostCampReport): CampClaimRecord[] {
	return report.claims.map((claim) => create(CampClaimRecordSchema, claim));
}

function observation(
	input: RealizeInput,
	status: ReconcileStatus,
	report: RunnerHostCampReport,
	controllerDigest: string,
	nowMs: number,
	reasons: readonly Readonly<{
		code: string;
		message: string;
		remediation: string;
	}>[] = [],
): ReconcileObservationRecord {
	return create(ReconcileObservationRecordSchema, {
		campId: input.campId,
		setId: status === ReconcileStatus.CONVERGED ? input.desired.setId : "",
		reconcilerId: input.reconcilerId,
		fenceToken: input.fence.toString(10),
		status,
		observedAt: new Date(nowMs).toISOString(),
		// Attributes are only declared observe fields (the feed refuses the
		// rest), so the controller digest rides the physical id instead.
		resources: [
			create(ResourceObservationSchema, {
				resource: report.resource.resource,
				physicalId: controllerDigest
					? `${report.resource.physicalId}@${controllerDigest}`
					: report.resource.physicalId,
				healthy: report.resource.healthy,
				kind: report.resource.kind,
				retained: [...report.resource.retained],
			}),
		],
		claims: claimsOf(report),
		reasons: reasons.map((reason) =>
			create(ReasonRecordSchema, { ...reason, subject: input.campId }),
		),
	});
}

/** `sha256:<hex>` of a digest-pinned image reference. */
const targetDigest = (image: string): string =>
	image.slice(image.indexOf("@") + 1);

const digestOf = (outcome: ResolveOutcome | undefined): string => {
	const digest = outcome?.outputs.controllerDigest;
	return isJsonString(digest) ? digest : "";
};

export type RunnerHostRealizerInput = Readonly<{
	resolver: ResourceResolver;
	hostId: string;
	credentialRef: string;
	drainDeadlineMs?: number;
	/**
	 * The row parameter this host runs (default `image`): a process-mode host
	 * runs its kind's release, whose digest is its bytes' sha256, never the
	 * image's manifest digest.
	 */
	reference?: RunnerHostReference;
	now: () => number;
	/** The realizer makes no HTTP call; the transport refuses any. */
	transport?: HttpTransport;
}>;

const NO_HTTP: HttpTransport = async () => {
	throw new Error("the runner-host realizer makes no HTTP call");
};

/**
 * The `@hobo/cd` Realizer for one runner host. Converge is the resolver's
 * `reconcile` (drain, swap by digest, verify, roll back on a failed verify);
 * observe is its `read`. Only an observed, serving controller at the Set's
 * digest is CONVERGED (I5).
 */
export function createRunnerHostRealizer(
	input: RunnerHostRealizerInput,
): Realizer {
	const transport = input.transport ?? NO_HTTP;
	const reference = input.reference ?? "image";

	function request(realize: RealizeInput, image: string) {
		return runnerHostResolveRequest({
			campId: realize.campId,
			image,
			credentialRef: input.credentialRef,
			...(input.drainDeadlineMs === undefined
				? undefined
				: { drainDeadlineMs: input.drainDeadlineMs }),
		});
	}

	/** What the host looks like now, for a refusal's report. */
	async function current(
		realize: RealizeInput,
		image: string,
	): Promise<Readonly<{ report: RunnerHostCampReport; digest: string }>> {
		const nowMs = input.now();
		try {
			const read = await input.resolver.read?.(
				request(realize, image),
				transport,
			);
			return read
				? { report: runnerHostCampReport(read, nowMs), digest: digestOf(read) }
				: { report: runnerHostAbsentReport(input.hostId, nowMs), digest: "" };
		} catch {
			return {
				report: runnerHostAbsentReport(input.hostId, nowMs),
				digest: "",
			};
		}
	}

	function unresolved(realize: RealizeInput): ReconcileObservationRecord {
		return observation(
			realize,
			ReconcileStatus.BLOCKED,
			runnerHostAbsentReport(input.hostId, input.now()),
			"",
			input.now(),
			[
				{
					code:
						reference === "image"
							? "runner-host-image-unresolved"
							: "runner-host-release-unresolved",
					message: `Set ${realize.desired.setId} resolves no ${RUNNER_HOST_PRODUCT_ID} row with a digest-pinned ${reference}`,
					remediation:
						reference === "image"
							? "resolve the runner fleet's Set to a hobo-ci.runner-host/v1 row whose image realization parameter is pinned by @sha256 digest"
							: `this host's controller runs as a process: resolve the Set from Freight that carries its release (runnerFleetDelivery releaseIndexBase, runnerHostRealizationParameters), so the row has a digest-pinned ${reference}`,
				},
			],
		);
	}

	function wrongHost(realize: RealizeInput): boolean {
		return runnerHostIdForCamp(realize.campId) !== input.hostId;
	}

	function foreign(realize: RealizeInput): ReconcileObservationRecord {
		return observation(
			realize,
			ReconcileStatus.BLOCKED,
			runnerHostAbsentReport(input.hostId, input.now()),
			"",
			input.now(),
			[
				{
					code: "runner-host-camp-unbound",
					message: `this agent realizes hobo-ci-runners/${input.hostId}, not ${realize.campId}`,
					remediation:
						"run one agent per runner host, accepted for that host's Camp only",
				},
			],
		);
	}

	return Object.freeze({
		async converge(realize: RealizeInput, _ctx: CdContext) {
			if (wrongHost(realize)) return foreign(realize);
			const image = runnerHostImageOf(realize.resolved, reference);
			if (image === undefined) return unresolved(realize);
			try {
				const outcome = await input.resolver.reconcile(
					request(realize, image),
					transport,
				);
				const nowMs = input.now();
				const report = runnerHostCampReport(outcome, nowMs);
				const digest = digestOf(outcome);
				// CONVERGED only at the Set's digest, observed serving (I5): a
				// healthy controller at another digest is still converging.
				return observation(
					realize,
					digest === targetDigest(image) && report.resource.healthy
						? ReconcileStatus.CONVERGED
						: ReconcileStatus.CONVERGING,
					report,
					digest,
					nowMs,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const after = await current(realize, image);
				return observation(
					realize,
					ReconcileStatus.BLOCKED,
					after.report,
					after.digest,
					input.now(),
					[
						{
							code:
								error instanceof ResolverError
									? codeOf(message)
									: "realize-failed",
							message,
							remediation:
								"see packages/ci-gh-actions/README.md, Runner-host realizer, Runbook",
						},
					],
				);
			}
		},

		async observe(realize: RealizeInput, _ctx: CdContext) {
			if (wrongHost(realize)) return foreign(realize);
			const image = runnerHostImageOf(realize.resolved, reference);
			if (image === undefined) return unresolved(realize);
			const { report, digest } = await current(realize, image);
			const status =
				digest === targetDigest(image) && report.resource.healthy
					? ReconcileStatus.CONVERGED
					: ReconcileStatus.DRIFTED;
			return observation(realize, status, report, digest, input.now());
		},
	});
}

// ── Station side ───────────────────────────────────────────────────────────

const STATION: CdContext["principal"] = {
	kind: "service",
	id: "cd-station:runner-host-health",
};

/** Whether an observation is a runner-host agent's report. */
function isRunnerHostReport(observation: ReconcileObservationRecord): boolean {
	return observation.resources.some(
		(resource) => resource.kind === RUNNER_HOST_PRODUCT_ID,
	);
}

/**
 * Feed one accepted runner-host observation into Camp inventory: the health
 * claims become health-source conditions at the Station's clock, the claims
 * are merged, and a host that is not ready carries
 * `hobo.ci/runner-host-unready` (NO_PLACE) until it is. Returns what it did.
 */
export async function ingestRunnerHostHealth(
	input: Readonly<{
		inventory: Pick<CampInventory, "observe" | "taint" | "untaint">;
		observation: ReconcileObservationRecord;
		tenant: string;
		now: () => number;
	}>,
): Promise<Readonly<{ ingested: boolean; ready?: boolean }>> {
	const { observation } = input;
	if (!isRunnerHostReport(observation)) return { ingested: false };
	const nowMs = input.now();
	const ctx: CdContext = {
		tenant: input.tenant,
		principal: STATION,
		now: input.now,
	};
	// SAFETY: the feed accepted the observation for this lease's Camp.
	const campId = observation.campId as CampId;
	const health = runnerHostHealthConditions(observation.claims, nowMs);
	/** A refused inventory write is an ingest failure the caller reports. */
	const settled = (outcome: Outcome<unknown>, step: string) => {
		if (!outcome.ok)
			throw new Error(
				`runner-host-health-ingest-failed: ${step} for ${campId}: ${outcome.reasons.map((reason) => `${reason.code}: ${reason.message}`).join("; ")}`,
			);
	};
	const observed = await input.inventory.observe(
		{
			campId,
			source: SignalSource.HEALTH_SOURCE,
			conditions: health.conditions.map((condition) =>
				fromJson(CampConditionRecordSchema, {
					...condition,
					since: new Date(nowMs).toISOString(),
				}),
			),
			claims: observation.claims,
		},
		ctx,
	);
	settled(observed, "observe");
	const ready = health.conditions.every(
		(condition) => condition.status === "CONDITION_STATUS_TRUE",
	);
	// Taint and untaint replace by key and effect and journal nothing when
	// unchanged, so each report states the host's readiness outright: no
	// read-then-write that two concurrent reports could interleave.
	const marked = !ready
		? await input.inventory.taint(
				{
					campId,
					taint: create(TaintRecordSchema, {
						key: RUNNER_HOST_UNREADY_TAINT,
						value: health.advert,
						effect: TaintEffect.NO_PLACE,
						source: SignalSource.HEALTH_SOURCE,
						reason:
							health.conditions.find(
								(condition) => condition.status !== "CONDITION_STATUS_TRUE",
							)?.reason ?? "runner-host-unready",
					}),
				},
				ctx,
			)
		: await input.inventory.untaint(
				{
					campId,
					key: RUNNER_HOST_UNREADY_TAINT,
					effect: TaintEffect.NO_PLACE,
				},
				ctx,
			);
	settled(marked, ready ? "untaint" : "taint");
	return { ingested: true, ready };
}

const OBSERVATIONS_PATH = "/v1/cd/observations";

function acceptedObservation(
	request: FeedRequest,
): ReconcileObservationRecord | undefined {
	try {
		const body: unknown = JSON.parse(new TextDecoder().decode(request.body));
		if (!isJsonObject(body) || !isJsonObject(body.observation))
			return undefined;
		// SAFETY: plain JSON just parsed; fromJson parses it with the schema.
		const json = body.observation as ProtoJson;
		return fromJson(ReconcileObservationRecordSchema, json);
	} catch {
		return undefined;
	}
}

/**
 * Wrap the delivery feed so every observation the feed ACCEPTED (201, after
 * its own SVID, DPoP, lease and fence checks) from a runner-host agent is
 * also ingested into Camp inventory. A failed ingest never fails the agent's
 * report (the reconcile status is already journaled), but it is never
 * silent either: `onError` gets it, so stale readiness or a missed taint is
 * visible to the operator.
 */
export function withRunnerHostHealthIngest(
	factories: CdFactories,
	onError: (error: Error) => void,
): CdFactories {
	return Object.freeze({
		...factories,
		createDeliveryFeedHandler(
			deps: Parameters<CdFactories["createDeliveryFeedHandler"]>[0],
		) {
			const handler = factories.createDeliveryFeedHandler(deps);
			return Object.freeze({
				pathPrefix: handler.pathPrefix,
				async handle(request: FeedRequest, signal: AbortSignal) {
					const response = await handler.handle(request, signal);
					const path = new URL(request.path, "https://station.invalid")
						.pathname;
					if (
						response.status === 201 &&
						request.method.toUpperCase() === "POST" &&
						path === OBSERVATIONS_PATH
					) {
						const accepted = acceptedObservation(request);
						if (accepted)
							await ingestRunnerHostHealth({
								inventory: deps.inventory,
								observation: accepted,
								tenant: deps.tenant,
								now: deps.now,
							}).catch((error: Error) => onError(error));
					}
					return response;
				},
			});
		},
	});
}
