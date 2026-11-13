/**
 * HoBo's own runner fleet, delivered by HoBo CD (ADR-0182).
 *
 * The hosts that run HoBo's self-hosted GitHub Actions runners (the box
 * worker, mesh nodes and local runners serving `hobo`, `hobo-trunk` and
 * `hobo-local-host`) are Camps of one Yard. This module turns a declared host
 * list into what `@hobo/cd` reads, as plain records in protobuf JSON form
 * (`packages/cd/data-models/cd.proto`), so `hobo deploy pipeline apply --file
 * packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.json` applies them:
 *
 * - a Camp set for the `hobo-ci-runner-fleet` Bindle, selected by label;
 * - an OCI Freight source that polls GHCR for the worker image's release tags
 *   (`scripts/ci/push-ci-runner-image-ghcr.mts` publishes them);
 * - a Placement with a pilot group, and a pipeline node that fans out
 *   PROGRESSIVE_PER_GROUP: the pilot first and mandatory, a failure budget of
 *   one host, a quorum, and departing hosts left running (ORPHAN).
 *
 * It also maps what the mesh already reports about each host (its signed
 * advertisement: health, expiry, served labels) to Camp inventory conditions
 * and claims, from the health source. Nothing here changes job routing.
 *
 * It holds data and pure functions only: no I/O, no clock but the one given.
 */
import type { MeshNode } from "@hobo/ci/mesh";
import { z } from "zod";
import { RUNNER_LABEL, TRUNK_RUNNER_LABEL } from "./runner-labels.js";

// public-contract: names shared with @hobo/cd HOBO_CI_COMPONENTS.runnerFleet.
export const RUNNER_FLEET_BINDLE = "hobo-ci-runner-fleet";
// public-contract: pipeline name shared with @hobo/cd HOBO_CI_COMPONENTS.runnerFleet.
export const RUNNER_FLEET_PIPELINE = "hobo-ci-runner-fleet";
// public-contract: Camp set name the runner-fleet delivery config declares (exported for deploy/runner-fleet).
export const RUNNER_FLEET_CAMP_SET = "hobo-ci-runner-fleet";
// public-contract: placement name the runner-fleet pipeline targets (exported for deploy/runner-fleet).
export const RUNNER_FLEET_PLACEMENT = "hobo-ci-runner-fleet";
// public-contract: the Freight source polling GHCR for the worker image.
export const RUNNER_IMAGE_SOURCE = "hobo-ci-runner-image";
// public-contract: the Yard every runner host Camp belongs to (`<yard>/<host id>`).
export const RUNNER_FLEET_YARD = "hobo-ci-runners";
// public-contract: tags the push script publishes once per new image version, oldest first lexically.
export const RUNNER_IMAGE_RELEASE_TAG_PATTERN =
	"^release-[0-9]{14}-v[0-9a-f]{12}$";
// public-contract: the provider every runner host Camp declares; the fleet's Rail approves exactly it.
export const RUNNER_FLEET_PROVIDER = "self-hosted";
// public-contract: the id of the runner fleet's declared Station Rail.
export const RUNNER_FLEET_RAIL = "hobo-ci-runner-fleet";
// public-contract: credential locator the CD Station resolves to read GHCR (never stored).
export const RUNNER_IMAGE_CREDENTIAL_REF = "env://HOBO_CI_GHCR_READ_TOKEN";
// public-contract: the Freight artifact a container-mode controller runs (the worker image).
export const RUNNER_IMAGE_ARTIFACT = "hobo-ci-worker";
/**
 * The single-file releases a process-mode controller runs, one per program:
 * the box worker daemon (box workers and mesh nodes) and the local runner.
 * `scripts/build-controller-release.mts` builds them under these names and
 * writes `index.<artifact>.json` for each.
 */
// public-contract: Freight artifact names and runner-host realization parameter keys of the controller releases.
export const RUNNER_RELEASE_ARTIFACTS = Object.freeze({
	workerRelease: "hobo-ci-worker-release",
	localRunnerRelease: "hobo-ci-local-runner-release",
} as const);
export type RunnerReleaseParameter = keyof typeof RUNNER_RELEASE_ARTIFACTS;
// public-contract: the runner controller product, keyed by the resolver registry and offered to Matching.
export const RUNNER_HOST_PRODUCT_ID = "hobo-ci.runner-host/v1";
// public-contract: the one resource the runner fleet's Bindle declares (the plan row a runner-host Set carries).
export const RUNNER_HOST_RESOURCE = "runner-controller";
// public-contract: the verify suite the fleet node runs; the Station's runner-host suite answers it.
export const RUNNER_HOST_VERIFY_SUITE = "hobo-ci.runner-host/serving";

const LOCAL_HOST_LABEL = "hobo-local-host";
const SERVED_LABELS = [
	RUNNER_LABEL,
	LOCAL_HOST_LABEL,
	TRUNK_RUNNER_LABEL,
] as const;
const FLEET_LABEL = "hobo.ci/runner-fleet";
const RING_LABEL = "hobo.ci/runner-ring";
const HOST_KIND_LABEL = "hobo.ci/runner-host";
const servesLabel = (label: string) => `hobo.ci/serves-${label}`;

/**
 * The served-label claims for the labels a host advertises: one per label the
 * fleet knows, `label:hobo.ci/serves-<label>` = whether it is advertised.
 * Claims narrow, never grant: a host that stopped serving a declared label
 * contradicts its Camp's topology and is not placed.
 */
export function servedLabelClaims(
	advertised: readonly string[],
): readonly Readonly<{ name: string; value: string }>[] {
	return SERVED_LABELS.map((label) =>
		Object.freeze({
			name: `label:${servesLabel(label)}`,
			value: String(advertised.includes(label)),
		}),
	);
}
const DEFINED_BY = "packages/ci-gh-actions/deploy/runner-fleet";
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HOST_KINDS = ["box-worker", "mesh-node", "local-runner"] as const;
const RINGS = ["pilot", "fleet"] as const;

/** A pilot host must keep taking jobs this long on new Freight before the rest move. */
const PILOT_SOAK_MS = 10 * 60_000;
/** Above the box worker's two-hour drain (`restart-worker.sh`), so a draining host is not failed. */
const HOST_PROGRESS_DEADLINE_MS = 3 * 60 * 60_000;
/** How long after the Set is applied the host is first asked whether it serves it. */
const VERIFY_WINDOW_MS = 60_000;

export type RunnerHostKind = (typeof HOST_KINDS)[number];
export type RunnerRing = (typeof RINGS)[number];
export type ServedRunnerLabel = (typeof SERVED_LABELS)[number];

// domain-view: one parsed runner host (the derived type every builder takes).
export type RunnerHost = Readonly<{
	/** The host's mesh node id; the Camp is `hobo-ci-runners/<id>`. */
	id: string;
	kind: RunnerHostKind;
	runnerLabels: readonly ServedRunnerLabel[];
	ring: RunnerRing;
}>;

export type RunnerHostsOutcome =
	| Readonly<{ ok: true; value: readonly RunnerHost[] }>
	| Readonly<{
			ok: false;
			code: "runner-hosts-invalid";
			problems: readonly string[];
			remediation: string;
	  }>;

const HostEntry = z.object({
	id: z.string().regex(HOST_ID, "not a lowercase host id (the mesh node id)"),
	kind: z.enum(HOST_KINDS),
	runnerLabels: z.array(z.enum(SERVED_LABELS)).min(1),
	ring: z.enum(RINGS).default("fleet"),
});
const HostList = z.array(HostEntry);

function invalid(problems: readonly string[]): RunnerHostsOutcome {
	return {
		ok: false,
		code: "runner-hosts-invalid",
		problems,
		remediation: REMEDIATION,
	};
}

/**
 * Parse a declared host list (the text of `deploy/runner-fleet/hosts.json`).
 * Every problem is listed; nothing partial is returned.
 */
export function parseRunnerHosts(text: string): RunnerHostsOutcome {
	let json: ReturnType<typeof JSON.parse>;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return invalid([`not JSON: ${String(error)}`]);
	}
	const parsed = HostList.safeParse(json);
	if (!parsed.success)
		return invalid(
			parsed.error.issues.map(
				(issue) => `hosts.${issue.path.join(".")}: ${issue.message}`,
			),
		);
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const [index, host] of parsed.data.entries()) {
		const at = `hosts.${index}`;
		if (seen.has(host.id)) problems.push(`${at}: duplicate host id ${host.id}`);
		seen.add(host.id);
		const local = host.runnerLabels.includes(LOCAL_HOST_LABEL);
		if (
			host.kind === "local-runner" &&
			host.runnerLabels.some((l) => l !== LOCAL_HOST_LABEL)
		)
			problems.push(`${at}: a local-runner serves only hobo-local-host`);
		if (host.kind !== "local-runner" && local)
			problems.push(`${at}: only a local-runner serves hobo-local-host`);
	}
	if (parsed.data.length > 1 && !parsed.data.some((h) => h.ring === "pilot"))
		problems.push(
			"no pilot host: mark one host ring pilot so new Freight reaches it first",
		);
	if (problems.length > 0) return invalid(problems);
	const hosts: RunnerHost[] = parsed.data.map((host) =>
		Object.freeze({
			...host,
			runnerLabels: Object.freeze([...new Set(host.runnerLabels)].sort()),
		}),
	);
	return {
		ok: true,
		value: Object.freeze(hosts.sort((a, b) => (a.id < b.id ? -1 : 1))),
	};
}

const REMEDIATION =
	"Fix packages/ci-gh-actions/deploy/runner-fleet/hosts.json: one entry per runner host with its mesh node id (lowercase), kind, the runner labels it serves and its ring, and exactly one pilot when there is more than one host.";

export const campIdOf = (host: Pick<RunnerHost, "id">): string =>
	`${RUNNER_FLEET_YARD}/${host.id}`;

function hostLabels(host: RunnerHost): Readonly<Record<string, string>> {
	return Object.freeze(
		Object.fromEntries([
			[FLEET_LABEL, "true"],
			[RING_LABEL, host.ring],
			[HOST_KIND_LABEL, host.kind],
			...SERVED_LABELS.map((label) => [
				servesLabel(label),
				String(host.runnerLabels.includes(label)),
			]),
		]),
	);
}

// domain-view: the CampTopology shape @hobo/cd's TopologyReader returns.
export type RunnerCampTopology = Readonly<{
	campId: string;
	yardId: string;
	stationId: string;
	provider: string;
	regions: readonly string[];
	envType: string;
	labels: Readonly<Record<string, string>>;
	management: "CAMP_MANAGEMENT_MANAGED";
}>;

/** The declared Camp per runner host (`@hobo/cd` CampTopology form). */
export function runnerFleetTopology(
	hosts: readonly RunnerHost[],
	options: Readonly<{ stationId: string; provider?: string }>,
): readonly RunnerCampTopology[] {
	return hosts.map((host) =>
		Object.freeze({
			campId: campIdOf(host),
			yardId: RUNNER_FLEET_YARD,
			stationId: options.stationId,
			provider: options.provider ?? RUNNER_FLEET_PROVIDER,
			regions: [],
			envType: "ci",
			labels: hostLabels(host),
			management: "CAMP_MANAGEMENT_MANAGED" as const,
		}),
	);
}

// domain-view: a @hobo/stations Rail declaration (createRail input) for the runner fleet.
export type RunnerFleetRail = Readonly<{
	id: string;
	name: string;
	version: string;
	/** Empty: the Station the CD runtime composes (HOBO_STATION). */
	stationId: string;
	approvedProviders: readonly string[];
	delivery: Readonly<{ campSets: readonly string[] }>;
	metadata: Readonly<Record<string, string>>;
}>;

/**
 * The Station Rail the runner fleet is delivered under: it binds the fleet's
 * Camp set (so Placement sees its Camps) and approves the one provider its
 * Camps declare (so Placement can evaluate provider approval instead of
 * refusing `rail-providers-unknown`). A delivery module exports it as `rails`;
 * the CD runtime reads it as declared topology for the Station it composes.
 */
export function runnerFleetRail(): RunnerFleetRail {
	return Object.freeze({
		id: RUNNER_FLEET_RAIL,
		name: RUNNER_FLEET_RAIL,
		version: "1",
		stationId: "",
		approvedProviders: Object.freeze([RUNNER_FLEET_PROVIDER]),
		delivery: Object.freeze({
			campSets: Object.freeze([RUNNER_FLEET_CAMP_SET]),
		}),
		metadata: Object.freeze({ definedBy: DEFINED_BY }),
	});
}

type Selector = Readonly<{ labels: Readonly<Record<string, string>> }>;

// domain-view: the delivery-module exports (protobuf JSON of cd.proto records).
export type RunnerFleetDelivery = Readonly<{
	sources: readonly Readonly<{
		schemaVersion: "hobo.cd.source/v1";
		name: string;
		bindle: string;
		subscriptions: readonly Readonly<
			| {
					name: string;
					kind: "SUBSCRIPTION_KIND_OCI_REPOSITORY";
					locator: string;
					selection: "SELECTION_STRATEGY_LEXICAL";
					allowPattern: string;
					artifactName: string;
					artifactKind: "ARTIFACT_KIND_OCI_IMAGE";
					credentialRef: string;
			  }
			| {
					name: string;
					kind: "SUBSCRIPTION_KIND_HTTP_INDEX";
					locator: string;
					selection: "SELECTION_STRATEGY_LEXICAL";
					allowPattern: string;
					artifactName: string;
					artifactKind: "ARTIFACT_KIND_FUNCTION_BUNDLE";
			  }
		>[];
		/** INDEPENDENT for the image alone; SAME_VERSION when releases ride with it. */
		assembly: "ASSEMBLY_RULE_INDEPENDENT" | "ASSEMBLY_RULE_SAME_VERSION";
		automatic: boolean;
		definedBy: string;
	}>[];
	campSets: readonly Readonly<{
		name: string;
		selector: Selector;
		definedBy: string;
	}>[];
	placements: readonly Readonly<{
		schemaVersion: "hobo.cd.placement/v1";
		name: string;
		campSets: readonly string[];
		count: number;
		groups: readonly Readonly<{
			name: string;
			selector: Selector;
			maxSize?: number;
		}>[];
		definedBy: string;
	}>[];
	pipelines: readonly Readonly<{
		schemaVersion: "hobo.cd.pipeline/v1";
		name: string;
		bindle: string;
		nodes: readonly Readonly<{
			name: string;
			campIds?: readonly string[];
			placement: string;
			fromSources: readonly string[];
			autoPromotion: "AUTO_PROMOTION_NEWEST";
			strategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE";
			verification: Readonly<{
				windowMs: string;
				requiredObservations: number;
				progressDeadlineMs: string;
				failOnNoData: true;
				suites: readonly Readonly<{ suite: string }>[];
			}>;
			fanout: Readonly<{
				strategy: "FANOUT_STRATEGY_PROGRESSIVE_PER_GROUP";
				maxConcurrency: number;
				minSuccessMs: string;
				progressDeadlineMs: string;
				maxFailures: number;
				mandatoryGroups: readonly string[];
				rollbackOnHalt: boolean;
			}>;
			quorum: Readonly<{ minQualifiedPercent: number }>;
			departure: "DEPARTURE_ACTION_ORPHAN";
		}>[];
		definedBy: string;
	}>[];
}>;

/** The GHCR repository the push script publishes the worker image to. */
export function runnerImageRepository(repository: string): string {
	return `ghcr.io/${repository.toLowerCase()}/hobo-ci-worker`;
}

/**
 * The release index an HTTP_INDEX subscription reads for one release, under
 * `base` (an `https://` directory the release build's output is published to).
 */
export function runnerReleaseIndexUrl(base: string, artifact: string): string {
	const url = new URL(
		`index.${artifact}.json`,
		base.endsWith("/") ? base : `${base}/`,
	);
	if (url.protocol !== "https:" || url.username || url.password)
		throw new Error(
			"the runner release index base must be an https:// URL with no credentials in it",
		);
	return url.href;
}

/**
 * The delivery module (`hobo deploy pipeline apply --file`) for the runner
 * fleet. `hosts` only shapes the pilot group's presence; membership is by
 * label, so adding a host is a topology change, not a pipeline change.
 *
 * With `releaseIndexBase`, each Freight also carries the controller releases
 * of the same version (HTTP_INDEX subscriptions on the indexes
 * `scripts/build-controller-release.mts` writes, assembled SAME_VERSION with
 * the image): a release's digest is the sha256 of its own bytes, which is
 * what a process-mode host stages and verifies, never the image's manifest
 * digest. `runnerHostRealizationParameters` maps such a Freight to the
 * runner-host row's parameters.
 */
export function runnerFleetDelivery(
	hosts: readonly RunnerHost[],
	options: Readonly<{ repository: string; releaseIndexBase?: string }>,
): RunnerFleetDelivery {
	const hasPilot = hosts.some((h) => h.ring === "pilot");
	const base = options.releaseIndexBase;
	const releases = base
		? Object.values(RUNNER_RELEASE_ARTIFACTS).map((artifact) => ({
				name: artifact,
				kind: "SUBSCRIPTION_KIND_HTTP_INDEX" as const,
				locator: runnerReleaseIndexUrl(base, artifact),
				selection: "SELECTION_STRATEGY_LEXICAL" as const,
				// The release build is given the image's release tag as its version.
				allowPattern: RUNNER_IMAGE_RELEASE_TAG_PATTERN,
				artifactName: artifact,
				artifactKind: "ARTIFACT_KIND_FUNCTION_BUNDLE" as const,
			}))
		: [];
	return Object.freeze({
		sources: [
			{
				schemaVersion: "hobo.cd.source/v1",
				name: RUNNER_IMAGE_SOURCE,
				bindle: RUNNER_FLEET_BINDLE,
				subscriptions: [
					{
						name: RUNNER_IMAGE_SOURCE,
						kind: "SUBSCRIPTION_KIND_OCI_REPOSITORY",
						locator: runnerImageRepository(options.repository),
						// Release tags carry their publish time, so lexical order is publish order.
						selection: "SELECTION_STRATEGY_LEXICAL",
						allowPattern: RUNNER_IMAGE_RELEASE_TAG_PATTERN,
						artifactName: RUNNER_IMAGE_ARTIFACT,
						artifactKind: "ARTIFACT_KIND_OCI_IMAGE",
						credentialRef: RUNNER_IMAGE_CREDENTIAL_REF,
					},
					...releases,
				],
				assembly:
					releases.length > 0
						? "ASSEMBLY_RULE_SAME_VERSION"
						: "ASSEMBLY_RULE_INDEPENDENT",
				automatic: true,
				definedBy: DEFINED_BY,
			},
		],
		campSets: [
			{
				name: RUNNER_FLEET_CAMP_SET,
				selector: { labels: { [FLEET_LABEL]: "true" } },
				definedBy: DEFINED_BY,
			},
		],
		placements: [
			{
				schemaVersion: "hobo.cd.placement/v1",
				name: RUNNER_FLEET_PLACEMENT,
				campSets: [RUNNER_FLEET_CAMP_SET],
				// Every eligible runner host.
				count: 0,
				groups: [
					{
						name: "pilot",
						selector: { labels: { [RING_LABEL]: "pilot" } },
						maxSize: 1,
					},
					{
						name: "fleet",
						selector: { labels: { [RING_LABEL]: "fleet" } },
					},
				],
				definedBy: DEFINED_BY,
			},
		],
		pipelines: [
			{
				schemaVersion: "hobo.cd.pipeline/v1",
				name: RUNNER_FLEET_PIPELINE,
				bindle: RUNNER_FLEET_BINDLE,
				nodes: [
					{
						name: "fleet",
						placement: RUNNER_FLEET_PLACEMENT,
						fromSources: [RUNNER_IMAGE_SOURCE],
						autoPromotion: "AUTO_PROMOTION_NEWEST",
						// A runner host takes no routed traffic: each host swaps its
						// controller whole, and the fan-out (one host at a time, the
						// pilot first) is the progressive part. A canary would need a
						// traffic capability and is refused progressive-unsupported.
						strategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE",
						// A host qualifies only on its agent's own observation: the
						// Set converged at its digest and the host ready (serving,
						// advert fresh and healthy). Until the agent reports on the
						// Set the suite is retried, up to the drain-sized deadline.
						verification: {
							windowMs: String(VERIFY_WINDOW_MS),
							requiredObservations: 1,
							progressDeadlineMs: String(HOST_PROGRESS_DEADLINE_MS),
							failOnNoData: true,
							suites: [{ suite: RUNNER_HOST_VERIFY_SUITE }],
						},
						fanout: {
							strategy: "FANOUT_STRATEGY_PROGRESSIVE_PER_GROUP",
							// One runner host at a time: the fleet keeps taking jobs while it moves.
							maxConcurrency: 1,
							minSuccessMs: String(PILOT_SOAK_MS),
							progressDeadlineMs: String(HOST_PROGRESS_DEADLINE_MS),
							maxFailures: 1,
							mandatoryGroups: hasPilot ? ["pilot"] : [],
							rollbackOnHalt: true,
						},
						quorum: { minQualifiedPercent: 50 },
						// A host that leaves the placement keeps its runner controller running.
						departure: "DEPARTURE_ACTION_ORPHAN",
					},
				],
				definedBy: DEFINED_BY,
			},
		],
	});
}

// domain-view: the runner fleet's Bindle declaration (`@hobo/bindles` manifest JSON).
export type RunnerFleetDeclaration = Readonly<{
	schema: "hobo.manifest/v1";
	componentHost: Readonly<{ kind: "oci"; version: "1" }>;
	resources: Readonly<
		Record<
			typeof RUNNER_HOST_RESOURCE,
			Readonly<{
				type: "data.v1";
				port: `hobo:${typeof RUNNER_HOST_PRODUCT_ID}`;
			}>
		>
	>;
}>;

/**
 * The planning declaration of the `hobo-ci-runner-fleet` Bindle: one
 * resource, the runner controller, asking for the runner-host product as its
 * port (`{ type: "data.v1", port: "hobo:hobo-ci.runner-host/v1" }`), so
 * Matching places it only on an offering of exactly that product (a runner
 * host Camp's). Which controller a Set runs is not declared here: it is the
 * Freight's own artifacts (`runnerHostRealizationParameters`), so one
 * declaration plans every version.
 *
 * The fleet's Freight comes from its source with no declaration member, so
 * its `declaration_hash` is the source definition's digest; the Station
 * pairs this declaration with a Freight only while the source, as applied,
 * still has that digest (`hobo`'s `cd-runtime.ts`).
 */
export function runnerFleetDeclaration(): RunnerFleetDeclaration {
	return Object.freeze({
		schema: "hobo.manifest/v1",
		// The controller ships as an OCI image (and, for a process host, a
		// release paired with it in the same Freight).
		componentHost: Object.freeze({ kind: "oci", version: "1" }),
		resources: Object.freeze({
			[RUNNER_HOST_RESOURCE]: Object.freeze({
				type: "data.v1",
				port: `hobo:${RUNNER_HOST_PRODUCT_ID}`,
			}),
		}),
	});
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const OCI_BY_DIGEST = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/u;

/** One artifact of a Freight manifest, as `@hobo/cd` records it. */
export type RunnerFreightArtifact = Readonly<{
	name: string;
	digest: string;
	coordinate: string;
}>;

/**
 * The runner-host row's realization parameters for one Freight: `image`, the
 * worker image pinned by its manifest digest (what a container-mode host
 * pulls), and, when the Freight carries them, each controller release as
 * `<artifact>@sha256:<sha256 of its bytes>` (what a process-mode host
 * stages: `workerRelease` on a box worker or mesh node, `localRunnerRelease`
 * on a local runner). Undefined when the Freight has no digest-pinned image.
 */
export function runnerHostRealizationParameters(
	artifacts: readonly RunnerFreightArtifact[],
):
	| Readonly<
			{ image: string } & Partial<Record<RunnerReleaseParameter, string>>
	  >
	| undefined {
	const image = artifacts.find(
		(artifact) => artifact.name === RUNNER_IMAGE_ARTIFACT,
	)?.coordinate;
	if (!image || !OCI_BY_DIGEST.test(image)) return undefined;
	const parameters: { image: string } & Partial<
		Record<RunnerReleaseParameter, string>
	> = { image };
	for (const [parameter, name] of Object.entries(RUNNER_RELEASE_ARTIFACTS)) {
		const release = artifacts.find((artifact) => artifact.name === name);
		if (release && DIGEST.test(release.digest))
			// SAFETY: Object.entries of RUNNER_RELEASE_ARTIFACTS yields its own keys.
			parameters[parameter as RunnerReleaseParameter] =
				`${name}@${release.digest}`;
	}
	return Object.freeze(parameters);
}

/**
 * Which realization parameter a host runs: the image for a controller that
 * runs as a container, else the release of the program its kind runs.
 */
export function runnerHostReferenceParameter(
	kind: RunnerHostKind,
	mode: "container" | "process",
): "image" | RunnerReleaseParameter {
	if (mode === "container") return "image";
	return kind === "local-runner" ? "localRunnerRelease" : "workerRelease";
}

type ConditionStatus =
	| "CONDITION_STATUS_TRUE"
	| "CONDITION_STATUS_FALSE"
	| "CONDITION_STATUS_UNKNOWN";

// domain-view: one CampInventory.observe input in protobuf JSON form.
export type RunnerCampObservation = Readonly<{
	campId: string;
	source: "SIGNAL_SOURCE_HEALTH_SOURCE";
	conditions: readonly Readonly<{
		type:
			| "CAMP_CONDITION_TYPE_REACHABLE"
			| "CAMP_CONDITION_TYPE_LEASED"
			| "CAMP_CONDITION_TYPE_READY";
		status: ConditionStatus;
		source: "SIGNAL_SOURCE_HEALTH_SOURCE";
		reason: string;
		since: string;
	}>[];
	claims: readonly Readonly<{
		name: string;
		value: string;
		reportedBy: string;
		observedAt: string;
	}>[];
}>;

/**
 * What the mesh reports about each declared host, as Camp inventory
 * observations from the health source. A fresh advertisement is contact
 * (REACHABLE) and a live mesh lease (LEASED, until it expires); `healthy`
 * (not draining, host not critical) is READY. A host with no advertisement is
 * UNKNOWN, never assumed healthy. The served labels are claims: they narrow
 * (a host that stopped serving a declared label reads as inconsistent) and
 * never grant.
 */
export function runnerFleetCampObservations(
	hosts: readonly RunnerHost[],
	nodes: readonly MeshNode[],
	nowMs: number,
): readonly RunnerCampObservation[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const observedAt = new Date(nowMs).toISOString();
	return hosts.map((host) => {
		const node = byId.get(host.id);
		const since =
			node?.sinceMs === undefined ? "" : new Date(node.sinceMs).toISOString();
		const condition = (
			type: RunnerCampObservation["conditions"][number]["type"],
			status: ConditionStatus,
			reason: string,
		) =>
			Object.freeze({
				type,
				status,
				source: "SIGNAL_SOURCE_HEALTH_SOURCE" as const,
				reason,
				since,
			});
		let conditions: RunnerCampObservation["conditions"];
		if (!node)
			conditions = [
				condition(
					"CAMP_CONDITION_TYPE_REACHABLE",
					"CONDITION_STATUS_UNKNOWN",
					"mesh-advert-missing",
				),
				condition(
					"CAMP_CONDITION_TYPE_LEASED",
					"CONDITION_STATUS_UNKNOWN",
					"mesh-advert-missing",
				),
				condition(
					"CAMP_CONDITION_TYPE_READY",
					"CONDITION_STATUS_UNKNOWN",
					"mesh-advert-missing",
				),
			];
		else if (node.validUntilMs <= nowMs)
			conditions = [
				condition(
					"CAMP_CONDITION_TYPE_REACHABLE",
					"CONDITION_STATUS_FALSE",
					"mesh-advert-expired",
				),
				condition(
					"CAMP_CONDITION_TYPE_LEASED",
					"CONDITION_STATUS_FALSE",
					"mesh-lease-expired",
				),
				condition(
					"CAMP_CONDITION_TYPE_READY",
					"CONDITION_STATUS_FALSE",
					"mesh-advert-expired",
				),
			];
		else
			conditions = [
				condition(
					"CAMP_CONDITION_TYPE_REACHABLE",
					"CONDITION_STATUS_TRUE",
					"mesh-advert-fresh",
				),
				condition(
					"CAMP_CONDITION_TYPE_LEASED",
					"CONDITION_STATUS_TRUE",
					`mesh-lease-valid-until:${new Date(node.validUntilMs).toISOString()}`,
				),
				node.healthy
					? condition(
							"CAMP_CONDITION_TYPE_READY",
							"CONDITION_STATUS_TRUE",
							"runner-host-healthy",
						)
					: condition(
							"CAMP_CONDITION_TYPE_READY",
							"CONDITION_STATUS_FALSE",
							"runner-host-draining-or-pressured",
						),
			];
		const claims =
			node && node.validUntilMs > nowMs
				? servedLabelClaims(node.labels).map((claim) =>
						Object.freeze({
							...claim,
							reportedBy: `mesh:${node.id}`,
							observedAt,
						}),
					)
				: [];
		return Object.freeze({
			campId: campIdOf(host),
			source: "SIGNAL_SOURCE_HEALTH_SOURCE" as const,
			conditions: Object.freeze(conditions),
			claims: Object.freeze(claims),
		});
	});
}
