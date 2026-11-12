/**
 * HoBo's own runner fleet, delivered by HoBo CD (plan 0024, ADR-0180).
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
import { RUNNER_LABEL, TRUNK_RUNNER_LABEL } from "./runner-labels.js";

// public-contract: names shared with @hobo/cd HOBO_CI_COMPONENTS.runnerFleet.
export const RUNNER_FLEET_BINDLE = "hobo-ci-runner-fleet";
export const RUNNER_FLEET_PIPELINE = "hobo-ci-runner-fleet";
export const RUNNER_FLEET_CAMP_SET = "hobo-ci-runner-fleet";
export const RUNNER_FLEET_PLACEMENT = "hobo-ci-runner-fleet";
// public-contract: the Freight source polling GHCR for the worker image.
export const RUNNER_IMAGE_SOURCE = "hobo-ci-runner-image";
// public-contract: the Yard every runner host Camp belongs to (`<yard>/<host id>`).
export const RUNNER_FLEET_YARD = "hobo-ci-runners";
// public-contract: tags the push script publishes once per new image version, oldest first lexically.
export const RUNNER_IMAGE_RELEASE_TAG_PATTERN =
	"^release-[0-9]{14}-v[0-9a-f]{12}$";
// public-contract: credential locator the CD Station resolves to read GHCR (never stored).
export const RUNNER_IMAGE_CREDENTIAL_REF = "env://HOBO_CI_GHCR_READ_TOKEN";

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
const DEFINED_BY = "packages/ci-gh-actions/deploy/runner-fleet";
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HOST_KINDS = ["box-worker", "mesh-node", "local-runner"] as const;
const RINGS = ["pilot", "fleet"] as const;

/** A pilot host must keep taking jobs this long on new Freight before the rest move. */
const PILOT_SOAK_MS = 10 * 60_000;
/** Above the box worker's two-hour drain (`restart-worker.sh`), so a draining host is not failed. */
const HOST_PROGRESS_DEADLINE_MS = 3 * 60 * 60_000;

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
	values: readonly T[],
	value: unknown,
): value is T {
	return values.some((v) => v === value);
}

/**
 * Parse a declared host list (`deploy/runner-fleet/hosts.json`). Every
 * problem is listed; nothing partial is returned.
 */
export function parseRunnerHosts(input: unknown): RunnerHostsOutcome {
	const problems: string[] = [];
	const hosts: RunnerHost[] = [];
	if (!Array.isArray(input))
		return {
			ok: false,
			code: "runner-hosts-invalid",
			problems: ["the host list must be a JSON array"],
			remediation: REMEDIATION,
		};
	const seen = new Set<string>();
	for (const [index, item] of input.entries()) {
		const at = `hosts[${index}]`;
		if (!isRecord(item)) {
			problems.push(`${at}: not an object`);
			continue;
		}
		const { id, kind, runnerLabels } = item;
		const ring = item.ring ?? "fleet";
		if (typeof id !== "string" || !HOST_ID.test(id))
			problems.push(
				`${at}.id: ${JSON.stringify(id)} is not a lowercase host id (the mesh node id)`,
			);
		else if (seen.has(id)) problems.push(`${at}: duplicate host id ${id}`);
		if (typeof id === "string") seen.add(id);
		if (!oneOf(HOST_KINDS, kind))
			problems.push(`${at}.kind: one of ${HOST_KINDS.join(", ")}`);
		if (!oneOf(RINGS, ring)) problems.push(`${at}.ring: pilot or fleet`);
		const labels: ServedRunnerLabel[] = [];
		if (!Array.isArray(runnerLabels) || runnerLabels.length === 0)
			problems.push(`${at}.runnerLabels: a non-empty list`);
		else
			for (const label of runnerLabels) {
				if (oneOf(SERVED_LABELS, label)) labels.push(label);
				else
					problems.push(
						`${at}.runnerLabels: ${JSON.stringify(label)} is not one of ${SERVED_LABELS.join(", ")}`,
					);
			}
		if (kind === "local-runner" && labels.some((l) => l !== LOCAL_HOST_LABEL))
			problems.push(`${at}: a local-runner serves only hobo-local-host`);
		if (kind !== "local-runner" && labels.includes(LOCAL_HOST_LABEL))
			problems.push(`${at}: only a local-runner serves hobo-local-host`);
		if (typeof id === "string" && oneOf(HOST_KINDS, kind) && oneOf(RINGS, ring))
			hosts.push(
				Object.freeze({
					id,
					kind,
					runnerLabels: Object.freeze([...new Set(labels)].sort()),
					ring,
				}),
			);
	}
	if (input.length > 1 && !hosts.some((h) => h.ring === "pilot"))
		problems.push(
			"no pilot host: mark one host ring pilot so new Freight reaches it first",
		);
	if (problems.length > 0)
		return {
			ok: false,
			code: "runner-hosts-invalid",
			problems,
			remediation: REMEDIATION,
		};
	return {
		ok: true,
		value: Object.freeze(hosts.sort((a, b) => (a.id < b.id ? -1 : 1))),
	};
}

const REMEDIATION =
	"Fix packages/ci-gh-actions/deploy/runner-fleet/hosts.json: one entry per runner host with its mesh node id, kind, the runner labels it serves and its ring, then regenerate hobo.delivery.json (pnpm --filter @hobo/ci-gh-actions runner-fleet:delivery).";

export const campIdOf = (host: Pick<RunnerHost, "id">): string =>
	`${RUNNER_FLEET_YARD}/${host.id}`;

function hostLabels(host: RunnerHost): Readonly<Record<string, string>> {
	const labels: Record<string, string> = {
		[FLEET_LABEL]: "true",
		[RING_LABEL]: host.ring,
		[HOST_KIND_LABEL]: host.kind,
	};
	for (const label of SERVED_LABELS)
		labels[servesLabel(label)] = String(host.runnerLabels.includes(label));
	return Object.freeze(labels);
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
			provider: options.provider ?? "self-hosted",
			regions: [],
			envType: "ci",
			labels: hostLabels(host),
			management: "CAMP_MANAGEMENT_MANAGED" as const,
		}),
	);
}

type Selector = Readonly<{ labels: Readonly<Record<string, string>> }>;

// domain-view: the delivery-module exports (protobuf JSON of cd.proto records).
export type RunnerFleetDelivery = Readonly<{
	sources: readonly Readonly<{
		schemaVersion: "hobo.cd.source/v1";
		name: string;
		bindle: string;
		subscriptions: readonly Readonly<{
			name: string;
			kind: "SUBSCRIPTION_KIND_OCI_REPOSITORY";
			locator: string;
			selection: "SELECTION_STRATEGY_LEXICAL";
			allowPattern: string;
			artifactName: string;
			artifactKind: "ARTIFACT_KIND_OCI_IMAGE";
			credentialRef: string;
		}>[];
		assembly: "ASSEMBLY_RULE_INDEPENDENT";
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
 * The delivery module (`hobo deploy pipeline apply --file`) for the runner
 * fleet. `hosts` only shapes the pilot group's presence; membership is by
 * label, so adding a host is a topology change, not a pipeline change.
 */
export function runnerFleetDelivery(
	hosts: readonly RunnerHost[],
	options: Readonly<{ repository: string }>,
): RunnerFleetDelivery {
	const hasPilot = hosts.some((h) => h.ring === "pilot");
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
						artifactName: "hobo-ci-worker",
						artifactKind: "ARTIFACT_KIND_OCI_IMAGE",
						credentialRef: RUNNER_IMAGE_CREDENTIAL_REF,
					},
				],
				assembly: "ASSEMBLY_RULE_INDEPENDENT",
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
				? SERVED_LABELS.map((label) =>
						Object.freeze({
							name: `label:${servesLabel(label)}`,
							value: String(node.labels.includes(label)),
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
