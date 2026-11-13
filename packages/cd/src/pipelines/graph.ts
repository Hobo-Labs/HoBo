// Pure pipeline-graph validation (D4, D21, D24) and the derived facts the
// controller reads from a parsed graph. The controller gathers what lives
// elsewhere (topology, defined sources, placements) and passes it in, so this
// module has no I/O and every rule has one place.
import { clone } from "@bufbuild/protobuf";
import {
	AutoPromotion,
	Availability,
	CampManagement,
	DepartureAction,
	FreightSubject,
	HookKind,
	HookPoint,
	type PipelineNodeRecord,
	type PipelineRecord,
	PipelineRecordSchema,
	type PlacementRecord,
	PolicyMode,
	type ReasonRecord,
} from "../_generated/cd_pb.js";
import { PIPELINE_SCHEMA, SHADOW_REQUIRED } from "../events.js";
import type { CampTopology } from "../ports.js";
import { reason } from "../windows/reasons.js";
import { ORIGIN_SOURCES, PIPELINE_REASON, PROJECT_LABEL } from "./reasons.js";

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Facts from outside the record that validation needs. */
export type GraphFacts = Readonly<{
	camps: ReadonlyMap<string, CampTopology>;
	/** Names of defined Freight sources (`source.Defined`). */
	sources: ReadonlySet<string>;
	placements: ReadonlyMap<string, PlacementRecord>;
	/** Another pipeline already delivering this Bindle, if any. */
	bindleOwner?: string | undefined;
}>;

export function isPlaced(node: PipelineNodeRecord): boolean {
	return node.placement !== "";
}

export function isPreview(node: PipelineNodeRecord): boolean {
	return node.previewTtlMs > 0n;
}

/** UNSPECIFIED subject reads as BINDLE. */
export function subjectOf(subject: FreightSubject): FreightSubject {
	return subject === FreightSubject.UNSPECIFIED
		? FreightSubject.BINDLE
		: subject;
}

/** A Bindle's project: the segment before the first "/" ("" when unqualified). */
export function projectOf(bindle: string): string {
	const slash = bindle.indexOf("/");
	return slash > 0 ? bindle.slice(0, slash) : "";
}

/**
 * The availability strategy a node applies to its upstream nodes (R10):
 * UNSPECIFIED is QUORUM when any upstream node is placed, else ONE_OF.
 */
export function effectiveAvailability(
	node: PipelineNodeRecord,
	nodes: ReadonlyMap<string, PipelineNodeRecord>,
): Availability {
	if (node.availability !== Availability.UNSPECIFIED) return node.availability;
	const placedUpstream = node.fromNodes.some((name) => {
		const upstream = nodes.get(name);
		return upstream !== undefined && isPlaced(upstream);
	});
	return placedUpstream ? Availability.QUORUM : Availability.ONE_OF;
}

/** A parsed record: schema stamped, subject normalized, definer recorded. */
export function normalizePipeline(
	record: PipelineRecord,
	definedBy: string,
): PipelineRecord {
	const out = clone(PipelineRecordSchema, record);
	out.schemaVersion = PIPELINE_SCHEMA;
	out.subject = subjectOf(record.subject);
	out.definedBy = definedBy;
	return out;
}

/** Node names in an order where every upstream precedes its downstream, or undefined on a cycle. */
export function topologicalOrder(
	record: PipelineRecord,
): readonly string[] | undefined {
	const names = record.nodes.map((node) => node.name);
	const known = new Set(names);
	const indegree = new Map<string, number>(names.map((name) => [name, 0]));
	for (const node of record.nodes)
		for (const upstream of node.fromNodes)
			if (known.has(upstream))
				indegree.set(node.name, (indegree.get(node.name) ?? 0) + 1);
	const ready = names.filter((name) => indegree.get(name) === 0);
	const order: string[] = [];
	while (ready.length > 0) {
		const name = ready.shift();
		if (name === undefined) break;
		order.push(name);
		for (const node of record.nodes) {
			if (!node.fromNodes.includes(name)) continue;
			const left = (indegree.get(node.name) ?? 0) - 1;
			indegree.set(node.name, left);
			if (left === 0) ready.push(node.name);
		}
	}
	return order.length === new Set(names).size ? order : undefined;
}

function ancestorsOf(
	name: string,
	nodes: ReadonlyMap<string, PipelineNodeRecord>,
): Set<string> {
	const seen = new Set<string>();
	const stack = [...(nodes.get(name)?.fromNodes ?? [])];
	while (stack.length > 0) {
		const next = stack.pop();
		if (next === undefined || seen.has(next)) continue;
		seen.add(next);
		stack.push(...(nodes.get(next)?.fromNodes ?? []));
	}
	return seen;
}

/** Every problem with a pipeline graph, each with a remediation. Empty means valid. */
export function validatePipeline(
	record: PipelineRecord,
	facts: GraphFacts,
): readonly ReasonRecord[] {
	const out: ReasonRecord[] = [];
	const add = (
		code: string,
		message: string,
		remediation: string,
		subject: string,
	) => out.push(reason(code, message, remediation, subject));
	const subject = subjectOf(record.subject);
	const rail = subject === FreightSubject.RAIL;

	if (!SLUG.test(record.name))
		add(
			PIPELINE_REASON.invalid,
			`pipeline name "${record.name}" is not a slug`,
			"Use 1–63 lowercase letters, digits and hyphens.",
			"name",
		);
	if (record.bindle.trim() === "")
		add(
			PIPELINE_REASON.invalid,
			"the pipeline names no Bindle",
			"Set bindle (the Rail id for a RAIL pipeline).",
			"bindle",
		);
	if (record.nodes.length === 0)
		add(
			PIPELINE_REASON.invalid,
			"the pipeline has no nodes",
			"Declare at least one node.",
			"nodes",
		);
	if (facts.bindleOwner !== undefined && facts.bindleOwner !== record.name)
		add(
			PIPELINE_REASON.bindleTaken,
			`Bindle "${record.bindle}" is delivered by pipeline "${facts.bindleOwner}"`,
			"Edit that pipeline; a Bindle has one pipeline (D4).",
			"bindle",
		);

	const nodes = new Map<string, PipelineNodeRecord>();
	for (const node of record.nodes) {
		if (!SLUG.test(node.name))
			add(
				PIPELINE_REASON.invalid,
				`node name "${node.name}" is not a slug`,
				"Use 1–63 lowercase letters, digits and hyphens.",
				`nodes.${node.name}`,
			);
		if (nodes.has(node.name))
			add(
				PIPELINE_REASON.invalid,
				`node "${node.name}" is declared twice`,
				"Give every node a unique name.",
				`nodes.${node.name}`,
			);
		nodes.set(node.name, node);
	}

	const campOwner = new Map<string, string>();
	const project = projectOf(record.bindle);
	for (const node of record.nodes) {
		const at = `nodes.${node.name}`;
		const placed = isPlaced(node);
		const listed = node.campIds.length > 0;
		if (placed === listed)
			add(
				PIPELINE_REASON.targets,
				`node "${node.name}" must name exactly one of camp_ids or placement`,
				"List the Camps, or name a Placement for a fleet node (D21) — never both.",
				at,
			);

		if (node.fromSources.length === 0 && node.fromNodes.length === 0)
			add(
				PIPELINE_REASON.noSource,
				`node "${node.name}" has no source`,
				"Add a Freight source to a root node, or an upstream node.",
				at,
			);
		for (const source of node.fromSources)
			if (!facts.sources.has(source) && !ORIGIN_SOURCES.has(source))
				add(
					PIPELINE_REASON.unknownSource,
					`Freight source "${source}" is not defined`,
					`Define the source first (hobo deploy sources), or use one of ${[...ORIGIN_SOURCES.keys()].join(", ")} for pushed Freight.`,
					`${at}.fromSources`,
				);
		for (const upstream of node.fromNodes)
			if (!nodes.has(upstream) || upstream === node.name)
				add(
					PIPELINE_REASON.unknownUpstream,
					`upstream node "${upstream}" is not in the pipeline`,
					"Name an existing node of the same pipeline.",
					`${at}.fromNodes`,
				);

		for (const campId of node.campIds) {
			const topology = facts.camps.get(campId);
			if (!topology) {
				add(
					PIPELINE_REASON.unknownCamp,
					`Camp "${campId}" is not in the topology`,
					"Declare the Camp under a Yard first, or fix the id.",
					`${at}.campIds`,
				);
				continue;
			}
			const label = topology.labels[PROJECT_LABEL];
			if (!rail && label !== undefined && label !== project)
				add(
					PIPELINE_REASON.campOutsideProject,
					`Camp "${campId}" belongs to project "${label}", not "${project || record.bindle}"`,
					"Deliver a Bindle only to Camps of its own project.",
					`${at}.campIds`,
				);
			const observeOnly = topology.management === CampManagement.OBSERVE_ONLY;
			if (observeOnly && !(rail && node.policyMode === PolicyMode.INFORM))
				add(
					PIPELINE_REASON.campNotManaged,
					`Camp "${campId}" is OBSERVE_ONLY`,
					"Promote the Camp to MANAGED first, or bind it only in an INFORM node of a RAIL pipeline (D5, D25).",
					`${at}.campIds`,
				);
			const owner = campOwner.get(campId);
			if (owner !== undefined && owner !== node.name)
				add(
					PIPELINE_REASON.duplicateCamp,
					`Camp "${campId}" is in nodes "${owner}" and "${node.name}"`,
					"A Camp belongs to one node of a pipeline (one in-flight promotion per Camp).",
					`${at}.campIds`,
				);
			campOwner.set(campId, node.name);
		}

		if (placed) {
			const placement = facts.placements.get(node.placement);
			if (!placement)
				add(
					PIPELINE_REASON.unknownPlacement,
					`Placement "${node.placement}" is not defined`,
					"Define the Placement first (hobo deploy placement).",
					`${at}.placement`,
				);
			const groups = new Set(
				placement?.groups.map((group) => group.name) ?? [],
			);
			for (const group of node.fanout?.mandatoryGroups ?? [])
				if (placement && !groups.has(group))
					add(
						PIPELINE_REASON.unknownGroup,
						`mandatory group "${group}" is not a group of Placement "${node.placement}"`,
						"Name groups the Placement declares.",
						`${at}.fanout.mandatoryGroups`,
					);
			if (isPreview(node))
				add(
					PIPELINE_REASON.previewNotLeaf,
					`preview node "${node.name}" cannot be placed`,
					"A preview clones one source Camp; list it.",
					at,
				);
		} else {
			if (
				node.fanout ||
				node.failover ||
				node.departure !== DepartureAction.UNSPECIFIED
			)
				add(
					PIPELINE_REASON.placedFieldOnList,
					`node "${node.name}" sets fan-out, failover or departure without a placement`,
					"Remove them, or target the node with a Placement.",
					at,
				);
		}
		if (
			node.fanout &&
			(node.fanout.maxConcurrencyPercent > 100 ||
				node.fanout.maxFailuresPercent > 100)
		)
			add(
				PIPELINE_REASON.invalid,
				"fan-out percentages must be within 0–100",
				"Use a percent of the decision (0–100).",
				`${at}.fanout`,
			);
		if (node.quorum && node.quorum.minQualifiedPercent > 100)
			add(
				PIPELINE_REASON.invalid,
				"quorum percent must be within 0–100",
				"Use a percent of the decision (0–100).",
				`${at}.quorum`,
			);

		const availability = effectiveAvailability(node, nodes);
		const placedUpstream = node.fromNodes.some((name) => {
			const upstream = nodes.get(name);
			return upstream !== undefined && isPlaced(upstream);
		});
		if (availability === Availability.ALL && placedUpstream)
			add(
				PIPELINE_REASON.availability,
				`node "${node.name}" requires ALL over a placed upstream node`,
				"Use QUORUM: one unreachable Camp would otherwise block the node forever (C18).",
				`${at}.availability`,
			);

		if (
			node.autoPromotion === AutoPromotion.MATCH_UPSTREAM &&
			(node.fromNodes.length !== 1 || node.fromSources.length > 0)
		)
			add(
				PIPELINE_REASON.matchUpstream,
				`node "${node.name}" uses MATCH_UPSTREAM with ${node.fromNodes.length} upstream nodes and ${node.fromSources.length} sources`,
				"MATCH_UPSTREAM follows exactly one upstream node; use NEWEST otherwise.",
				`${at}.autoPromotion`,
			);

		const stages = node.stagePercents;
		if (
			stages.length > 0 &&
			(stages.some(
				(p, i) => p < 1 || p > 100 || (i > 0 && p <= (stages[i - 1] ?? 0)),
			) ||
				stages[stages.length - 1] !== 100)
		)
			add(
				PIPELINE_REASON.invalid,
				`stage percents ${stages.join(",")} must rise strictly within 1–100 and end at 100`,
				"Use e.g. 5,25,50,100 (CD_RAMP_DEFAULTS).",
				`${at}.stagePercents`,
			);
		for (const hook of node.hooks)
			if (
				hook.kind === HookKind.UNSPECIFIED ||
				hook.point === HookPoint.UNSPECIFIED ||
				hook.ref.trim() === ""
			)
				add(
					PIPELINE_REASON.invalid,
					`a hook of node "${node.name}" lacks kind, point or ref`,
					"Set kind (RUNBOOK|NOTIFY|SUITE), point and ref.",
					`${at}.hooks`,
				);
		for (const window of node.windows)
			if (!SLUG.test(window))
				add(
					PIPELINE_REASON.invalid,
					`window name "${window}" is not a slug`,
					"Name a defined change window.",
					`${at}.windows`,
				);

		if (!rail && node.policyMode !== PolicyMode.UNSPECIFIED)
			add(
				PIPELINE_REASON.policyMode,
				`node "${node.name}" sets policy_mode in a BINDLE pipeline`,
				"policy_mode belongs to RAIL pipelines only (D24); remove it.",
				`${at}.policyMode`,
			);
		if (rail && node.policyMode === PolicyMode.UNSPECIFIED)
			add(
				PIPELINE_REASON.policyMode,
				`node "${node.name}" of a RAIL pipeline has no policy_mode`,
				"Set INFORM to shadow the Rail, or ENFORCE after an INFORM node.",
				`${at}.policyMode`,
			);
		if (rail && node.policyMode === PolicyMode.ENFORCE) {
			const informUpstream = [...ancestorsOf(node.name, nodes)].some(
				(name) => nodes.get(name)?.policyMode === PolicyMode.INFORM,
			);
			if (node.fromSources.length > 0 || !informUpstream)
				add(
					SHADOW_REQUIRED,
					`ENFORCE node "${node.name}" has no INFORM node upstream on every path`,
					"Add an INFORM node upstream and take Freight only from upstream nodes (I23).",
					`${at}.policyMode`,
				);
		}
	}

	for (const node of record.nodes) {
		if (!isPreview(node)) continue;
		const downstream = record.nodes.find((other) =>
			other.fromNodes.includes(node.name),
		);
		if (downstream)
			add(
				PIPELINE_REASON.previewNotLeaf,
				`preview node "${node.name}" feeds node "${downstream.name}"`,
				"Preview environments are ephemeral leaves; promote from a durable node instead.",
				`nodes.${node.name}`,
			);
	}

	if (record.nodes.length > 0 && !topologicalOrder(record))
		add(
			PIPELINE_REASON.cycle,
			"the pipeline graph has a cycle",
			"Remove an upstream edge so Freight flows one way.",
			"nodes",
		);
	return out;
}
