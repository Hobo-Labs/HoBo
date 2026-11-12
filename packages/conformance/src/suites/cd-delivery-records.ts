// Delivery-as-code conformance (plan 0024 WP20 examples, D3, D4, D21, D24).
// A `hobo.delivery.ts` module exports sources, trusted publishers, windows and
// pipelines; `hobo deploy pipeline apply --file` applies them. This suite
// checks the module before anything reaches the gate: the graph, lineage
// shape, fan-out shape, shadow-before-enforce, pinned trust, and that no
// record carries a secret.
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	checkSecretFree,
	runCdAssertions,
} from "./cd-kit.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const DELIVERY_RECORDS_SUITE = "hobo.cd.delivery-records/v1";

// public-contract: assertion names of the delivery-records suite.
export const DELIVERY_RECORDS_ASSERTIONS = Object.freeze([
	"nodeNamesAreUnique",
	"upstreamNodesExist",
	"graphIsAcyclic",
	"sourcesExist",
	"exactlyOneTarget",
	"fanoutOnlyWithPlacement",
	"enforceFollowsInform",
	"windowsAreDefined",
	"stagesAscendToFull",
	"publishersArePinned",
	"provenanceIsPinned",
	"recordsAreSecretFree",
] as const);
export type DeliveryRecordsAssertion =
	(typeof DELIVERY_RECORDS_ASSERTIONS)[number];

// Numeric values of cd.proto enums this suite reads.
export const CD_POLICY_MODE = Object.freeze({ INFORM: 1, ENFORCE: 2 } as const);
export const CD_FREIGHT_SUBJECT = Object.freeze({
	BINDLE: 1,
	RAIL: 2,
} as const);
export const CD_ROLLOUT_STRATEGY = Object.freeze({
	ALL_AT_ONCE: 1,
	CANARY: 2,
	BLUE_GREEN: 3,
	EXPERIMENT: 4,
} as const);

export type PipelineNodeLike = Readonly<{
	name: string;
	campIds: readonly string[];
	placement: string;
	fromNodes: readonly string[];
	fromSources: readonly string[];
	windows: readonly string[];
	strategy: number;
	stagePercents: readonly number[];
	policyMode: number;
	fanout?: Readonly<{ strategy: number }> | undefined;
}>;

export type PipelineLike = Readonly<{
	name: string;
	subject: number;
	nodes: readonly PipelineNodeLike[];
}>;

export type DeliveryModuleLike = Readonly<{
	sources: readonly Readonly<{
		name: string;
		subscriptions: readonly Readonly<{
			name: string;
			requireProvenance: boolean;
			trustedBuilderIds: readonly string[];
			trustedSignerIdentities: readonly string[];
		}>[];
	}>[];
	publishers: readonly Readonly<{
		name: string;
		issuer: string;
		audience: string;
		requiredClaims: Readonly<Record<string, string>>;
	}>[];
	windows: readonly Readonly<{ name: string }>[];
	pipelines: readonly PipelineLike[];
}>;

function nodesOf(
	module: DeliveryModuleLike,
): readonly Readonly<{ pipeline: PipelineLike; node: PipelineNodeLike }>[] {
	return module.pipelines.flatMap((pipeline) =>
		pipeline.nodes.map((node) => ({ pipeline, node })),
	);
}

function upstreamClosure(
	pipeline: PipelineLike,
	start: PipelineNodeLike,
): readonly PipelineNodeLike[] {
	const byName = new Map(pipeline.nodes.map((node) => [node.name, node]));
	const seen = new Set<string>();
	const out: PipelineNodeLike[] = [];
	const queue = [...start.fromNodes];
	while (queue.length > 0) {
		const name = queue.shift() ?? "";
		if (seen.has(name)) continue;
		seen.add(name);
		const node = byName.get(name);
		if (!node) continue;
		out.push(node);
		queue.push(...node.fromNodes);
	}
	return out;
}

export async function runDeliveryRecordsConformance(
	subject: string,
	module: DeliveryModuleLike,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<DeliveryRecordsAssertion>> {
	return runCdAssertions<DeliveryRecordsAssertion>(
		DELIVERY_RECORDS_SUITE,
		subject,
		{
			nodeNamesAreUnique: async () => {
				for (const pipeline of module.pipelines) {
					const names = pipeline.nodes.map((node) => node.name);
					check(
						new Set(names).size === names.length,
						`pipeline ${pipeline.name} repeats a node name`,
						"give every node a unique name",
					);
				}
			},
			upstreamNodesExist: async () => {
				for (const { pipeline, node } of nodesOf(module)) {
					const names = new Set(pipeline.nodes.map((n) => n.name));
					for (const up of node.fromNodes)
						check(
							names.has(up),
							`${pipeline.name}/${node.name} reads from unknown node ${up}`,
							"name an upstream node of the same pipeline",
						);
				}
			},
			graphIsAcyclic: async () => {
				for (const { pipeline, node } of nodesOf(module)) {
					check(
						!upstreamClosure(pipeline, node).includes(node),
						`${pipeline.name}/${node.name} is its own upstream`,
						"a pipeline is a DAG (D4)",
					);
				}
			},
			sourcesExist: async () => {
				const sources = new Set(module.sources.map((source) => source.name));
				for (const { pipeline, node } of nodesOf(module)) {
					for (const source of node.fromSources)
						check(
							sources.has(source),
							`${pipeline.name}/${node.name} reads unknown source ${source}`,
							"define the Freight source in the same module",
						);
					check(
						node.fromSources.length + node.fromNodes.length > 0,
						`${pipeline.name}/${node.name} has no Freight input`,
						"read from a source or an upstream node",
					);
				}
			},
			exactlyOneTarget: async () => {
				for (const { pipeline, node } of nodesOf(module)) {
					const lists = node.campIds.length > 0;
					const placed = node.placement.length > 0;
					check(
						lists !== placed,
						`${pipeline.name}/${node.name} ${lists ? "lists Camps and names a placement" : "has no target"}`,
						"a node lists camp_ids or names a placement, never both (D21)",
					);
				}
			},
			fanoutOnlyWithPlacement: async () => {
				for (const { pipeline, node } of nodesOf(module)) {
					if (node.fanout !== undefined)
						check(
							node.placement.length > 0,
							`${pipeline.name}/${node.name} fans out over a Camp list`,
							"fan-out needs a placement (D21)",
						);
				}
			},
			enforceFollowsInform: async () => {
				for (const { pipeline, node } of nodesOf(module)) {
					if (pipeline.subject !== CD_FREIGHT_SUBJECT.RAIL) {
						check(
							node.policyMode === 0,
							`${pipeline.name}/${node.name} sets policy_mode on a Bindle pipeline`,
							"policy_mode is for RAIL pipelines only",
						);
						continue;
					}
					check(
						node.policyMode === CD_POLICY_MODE.INFORM ||
							node.policyMode === CD_POLICY_MODE.ENFORCE,
						`${pipeline.name}/${node.name} has no policy_mode`,
						"RAIL nodes are INFORM or ENFORCE (D24)",
					);
					if (node.policyMode === CD_POLICY_MODE.ENFORCE) {
						check(
							upstreamClosure(pipeline, node).some(
								(up) => up.policyMode === CD_POLICY_MODE.INFORM,
							),
							`${pipeline.name}/${node.name} enforces without an INFORM node upstream`,
							"shadow before enforce: put a qualified INFORM node upstream (I23)",
						);
					}
				}
			},
			windowsAreDefined: async () => {
				const windows = new Set(module.windows.map((window) => window.name));
				for (const { pipeline, node } of nodesOf(module)) {
					for (const window of node.windows)
						check(
							windows.has(window),
							`${pipeline.name}/${node.name} names unknown window ${window}`,
							"define the change window in the same module",
						);
				}
			},
			stagesAscendToFull: async () => {
				for (const { pipeline, node } of nodesOf(module)) {
					const stages = node.stagePercents;
					if (stages.length === 0) continue;
					check(
						stages.every(
							(p, i) =>
								p > 0 && p <= 100 && (i === 0 || p > (stages[i - 1] ?? 0)),
						),
						`${pipeline.name}/${node.name} stages ${stages.join(",")} do not ascend`,
						"stage percents ascend within 1..100",
					);
					check(
						stages.at(-1) === 100,
						`${pipeline.name}/${node.name} stops at ${stages.at(-1)} percent`,
						"the last stage is 100 (CD_RAMP_DEFAULTS)",
					);
				}
			},
			publishersArePinned: async () => {
				for (const publisher of module.publishers) {
					check(
						publisher.issuer.startsWith("https://"),
						`publisher ${publisher.name} issuer ${publisher.issuer} is not https`,
						"trust an https OIDC issuer",
					);
					check(
						publisher.audience.length > 0,
						`publisher ${publisher.name} has no audience`,
						"pin the token audience",
					);
					const claims = Object.entries(publisher.requiredClaims);
					check(
						claims.length > 0,
						`publisher ${publisher.name} pins no claim`,
						"pin repository/project and ref claims (exact match)",
					);
					for (const [claim, value] of claims)
						check(
							!value.includes("*"),
							`publisher ${publisher.name} claim ${claim} is a wildcard`,
							"claims are exact-match; no wildcards",
						);
				}
			},
			provenanceIsPinned: async () => {
				for (const source of module.sources) {
					for (const sub of source.subscriptions) {
						if (!sub.requireProvenance) continue;
						check(
							sub.trustedBuilderIds.length > 0,
							`${source.name}/${sub.name} requires provenance but pins no builder`,
							"pin trusted_builder_ids (D3)",
						);
						check(
							sub.trustedSignerIdentities.length > 0,
							`${source.name}/${sub.name} requires provenance but pins no signer`,
							"pin trusted_signer_identities (D3)",
						);
					}
				}
			},
			recordsAreSecretFree: async () =>
				checkSecretFree(module, "the delivery module"),
		},
		options,
	);
}
