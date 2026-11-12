// The CD toolset and platform matrices, and the WP20 §10 rows (plan 0024).
//
// - Toolset: one build reaches CD through seven ingress paths and must yield
//   one Freight id (D2, D3, I15).
// - Platform: one Freight across every traffic rung and none, every artifact
//   kind, a built-in and a WASM-component resolver (D6, D7, I1, I6, I14).
// - Air gap: a Yard with egress disabled promotes via a local source and an
//   agent (D5, I3).
// - Journal replay: rebuilding from the journal equals the live state (I8).
//
// The harness binds each cell to a real composition; the suite only decides.
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	canonicalText,
	check,
	checkTypedRefusal,
	requireCapability,
	runCdAssertions,
	SHA256_DIGEST,
} from "./cd-kit.js";
import {
	type CD_ARTIFACT_KIND,
	CD_RECONCILE_STATUS,
	CD_REFUSAL,
	type Outcome,
} from "./cd-shapes.js";

// ── Toolset matrix ───────────────────────────────────────────────────────────

export const TOOLSET_MATRIX_SUITE = "hobo.cd.toolset-matrix/v1";

// public-contract: the seven ingress paths of the toolset matrix (D3).
export const CD_INGRESS_PATHS = Object.freeze([
	"oci-poll",
	"git-poll",
	"github-oidc-push",
	"gitlab-oidc-push",
	"in-toto-attestation",
	"cdevent-nudge",
	"hobo-ci",
] as const);
export type CdIngressPath = (typeof CD_INGRESS_PATHS)[number];

export type ToolsetMatrixAssertion =
	| `ingress:${CdIngressPath}`
	| "sameFreightIdAcrossPaths"
	| "payloadAloneCreatesNoFreight";

export interface ToolsetMatrixHarness {
	readonly subject: string;
	/** Bring the reference build into a fresh CD through `path`; return the Freight recorded. */
	ingest(
		path: CdIngressPath,
	): Promise<Outcome<Readonly<{ freightId: string }>>>;
	/** Post an unattested CDEvent `artifact.published` for a build the sources do not serve. */
	nudgeWithoutEvidence?(): Promise<
		Readonly<{
			freightIds: readonly string[];
			scheduledPolls: readonly string[];
		}>
	>;
}

export async function runToolsetMatrix(
	harness: ToolsetMatrixHarness,
	options?: CdSuiteOptions,
): Promise<
	CdConformanceReport<ToolsetMatrixAssertion> &
		Readonly<{ freightIds: Readonly<Partial<Record<CdIngressPath, string>>> }>
> {
	const ids: Partial<Record<CdIngressPath, string>> = {};
	const checks: Partial<Record<ToolsetMatrixAssertion, () => Promise<void>>> =
		{};
	for (const path of CD_INGRESS_PATHS) {
		checks[`ingress:${path}`] = async () => {
			const outcome = await harness.ingest(path);
			check(
				outcome.ok,
				`ingress ${path} was refused: ${outcome.ok ? "" : outcome.reasons.map((r) => r.code).join(",")}`,
				"every supported toolset reaches CD (D3)",
			);
			if (!outcome.ok) return;
			check(
				SHA256_DIGEST.test(outcome.value.freightId),
				`Freight id ${outcome.value.freightId} is not sha256:<hex>`,
				"the Freight id is sha256 over the canonical manifest (D2)",
			);
			ids[path] = outcome.value.freightId;
		};
	}
	checks.sameFreightIdAcrossPaths = async () => {
		const distinct = new Set(Object.values(ids));
		check(
			Object.keys(ids).length === CD_INGRESS_PATHS.length,
			`only ${Object.keys(ids).length} of ${CD_INGRESS_PATHS.length} paths produced Freight`,
			"every ingress path must produce Freight",
		);
		check(
			distinct.size === 1,
			`seven paths produced ${distinct.size} Freight ids`,
			"the same build is the same Freight whichever way it arrives (§10 WP20)",
		);
	};
	checks.payloadAloneCreatesNoFreight = async () => {
		const nudge = requireCapability(
			harness.nudgeWithoutEvidence,
			"nudgeWithoutEvidence",
		);
		const result = await nudge();
		check(
			result.freightIds.length === 0,
			"an unattested CDEvent created Freight",
			"trigger, don't trust: payloads schedule polls only (I15)",
		);
		check(
			result.scheduledPolls.length > 0,
			"an unattested CDEvent scheduled no poll",
			"map the event to sources and schedule polls (§10 WP1)",
		);
	};
	const report = await runCdAssertions(
		TOOLSET_MATRIX_SUITE,
		harness.subject,
		// oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the loop above assigned every assertion key.
		checks as Record<ToolsetMatrixAssertion, () => Promise<void>>,
		options,
	);
	return Object.freeze({ ...report, freightIds: Object.freeze({ ...ids }) });
}

// ── Platform matrix ──────────────────────────────────────────────────────────

export const PLATFORM_MATRIX_SUITE = "hobo.cd.platform-matrix/v1";

// public-contract: traffic rungs in lowering order (D7), plus no traffic capability.
export const CD_TRAFFIC_RUNGS = Object.freeze([
	"edge.canary",
	"lb.weighted",
	"dns.weighted",
	"inprocess.weighted",
	"none",
] as const);
export type CdTrafficRung = (typeof CD_TRAFFIC_RUNGS)[number];

// public-contract: resolver kinds the platform matrix covers (D6).
export const CD_RESOLVER_KINDS = Object.freeze([
	"built-in",
	"wasm-component",
] as const);
export type CdResolverKind = (typeof CD_RESOLVER_KINDS)[number];

export type CdArtifactKindName = keyof typeof CD_ARTIFACT_KIND;
// public-contract: every artifact kind the platform matrix delivers.
export const CD_ARTIFACT_KIND_NAMES = Object.freeze([
	"WASM_COMPONENT",
	"FUNCTION_BUNDLE",
	"STATIC_ASSETS",
	"OCI_IMAGE",
	"VM_IMAGE",
	"PACKAGE",
	"SOURCE_TREE",
] as const satisfies readonly CdArtifactKindName[]);

export type PlatformCell = Readonly<{
	rung: CdTrafficRung;
	artifactKind: CdArtifactKindName;
	resolver: CdResolverKind;
	/** canary requires progressive exposure; rolling does not. */
	strategy: "canary" | "rolling";
}>;

export type PlatformDelivery = Readonly<{
	/** Final reconcile status of the target Camp. */
	status: number;
	freightDigests: readonly string[];
	/** Artifact digests of the Set the Camp converged to. */
	setDigests: readonly string[];
	/** Rung recorded by rollout.Lowered; "none" for a rolling delivery without traffic. */
	loweredRung: CdTrafficRung;
}>;

export interface PlatformMatrixHarness {
	readonly subject: string;
	deliver(cell: PlatformCell): Promise<Outcome<PlatformDelivery>>;
}

export function platformCells(): readonly PlatformCell[] {
	const cells: PlatformCell[] = [];
	for (const resolver of CD_RESOLVER_KINDS) {
		for (const artifactKind of CD_ARTIFACT_KIND_NAMES) {
			for (const rung of CD_TRAFFIC_RUNGS) {
				cells.push({ rung, artifactKind, resolver, strategy: "canary" });
			}
			cells.push({ rung: "none", artifactKind, resolver, strategy: "rolling" });
		}
	}
	return cells;
}

export function platformCellName(cell: PlatformCell): string {
	return `${cell.resolver}/${cell.artifactKind}/${cell.rung}/${cell.strategy}`;
}

export async function runPlatformMatrix(
	harness: PlatformMatrixHarness,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<string>> {
	const checks: Record<string, () => Promise<void>> = {};
	for (const cell of platformCells()) {
		checks[platformCellName(cell)] = async () => {
			const outcome = await harness.deliver(cell);
			if (cell.strategy === "canary" && cell.rung === "none") {
				checkTypedRefusal(
					outcome,
					`a required canary on ${platformCellName(cell)}`,
					CD_REFUSAL.progressiveUnsupported,
				);
				return;
			}
			check(
				outcome.ok,
				`delivery refused: ${outcome.ok ? "" : outcome.reasons.map((r) => r.code).join(",")}`,
				"every platform has a realization path or a typed refusal (I14)",
			);
			if (!outcome.ok) return;
			const d = outcome.value;
			check(
				d.status === CD_RECONCILE_STATUS.CONVERGED,
				`Camp ended in status ${d.status}`,
				"converge by pull and confirm by observation",
			);
			check(
				[...d.setDigests].sort().join(",") ===
					[...d.freightDigests].sort().join(","),
				"the converged Set's digests differ from the Freight's",
				"promote, never rebuild (I1)",
			);
			check(
				d.loweredRung === cell.rung,
				`lowered to ${d.loweredRung}, not ${cell.rung}`,
				"record the realized rung; never downgrade silently (D7, I6)",
			);
		};
	}
	return runCdAssertions(
		PLATFORM_MATRIX_SUITE,
		harness.subject,
		checks,
		options,
	);
}

// ── Air-gapped Yard (§10 WP20) ───────────────────────────────────────────────

export const AIRGAP_SUITE = "hobo.cd.airgap/v1";

export const AIRGAP_ASSERTIONS = Object.freeze([
	"promotesViaLocalSourceAndAgent",
	"noEgressBeyondTheYard",
	"stationNeverDialsTheAgent",
	"stationHoldsNoTargetCredential",
] as const);
export type AirgapAssertion = (typeof AIRGAP_ASSERTIONS)[number];

export type EgressGuard = Readonly<{
	transport: HttpTransport;
	/** Hosts the guard refused, in order. */
	refused(): readonly string[];
	/** Hosts the guard let through, in order. */
	allowed(): readonly string[];
}>;

/** An HttpTransport that refuses every host outside `allowedHosts` (egress disabled). */
export function createEgressGuard(
	allowedHosts: readonly string[],
	inner: HttpTransport,
): EgressGuard {
	const allow = new Set(allowedHosts);
	const refused: string[] = [];
	const allowed: string[] = [];
	const transport: HttpTransport = async (
		request: TransportRequest,
	): Promise<TransportResponse> => {
		const host = new URL(request.url).host;
		if (!allow.has(host)) {
			refused.push(host);
			throw new Error(`egress to ${host} is disabled in this Yard`);
		}
		allowed.push(host);
		return inner(request);
	};
	return {
		transport,
		refused: () => [...refused],
		allowed: () => [...allowed],
	};
}

export type AirgapRun = Readonly<{
	/** Final status of the target Camp. */
	status: number;
	/** Connections the Station opened toward the agent (must be 0, I3). */
	stationToAgentConnections: number;
	/** Credential refs the Station resolved for the target (must be empty, I3). */
	stationTargetCredentials: readonly string[];
}>;

export interface AirgapHarness {
	readonly subject: string;
	/** Hosts inside the Yard (local registry, Station feed). */
	readonly yardHosts: readonly string[];
	/** Run: define a local source, poll, promote, let an agent converge, with every outbound call through `transport`. */
	run(transport: HttpTransport): Promise<AirgapRun>;
	/** The transport the run's in-Yard hosts are served by. */
	inner: HttpTransport;
}

export async function runAirgapConformance(
	harness: AirgapHarness,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<AirgapAssertion>> {
	let cached: Readonly<{ run: AirgapRun; guard: EgressGuard }> | undefined;
	const once = async () => {
		if (!cached) {
			const guard = createEgressGuard(harness.yardHosts, harness.inner);
			cached = { run: await harness.run(guard.transport), guard };
		}
		return cached;
	};
	return runCdAssertions<AirgapAssertion>(
		AIRGAP_SUITE,
		harness.subject,
		{
			promotesViaLocalSourceAndAgent: async () => {
				const { run } = await once();
				check(
					run.status === CD_RECONCILE_STATUS.CONVERGED,
					`target ended in status ${run.status}`,
					"an air-gapped Yard promotes via a local source and an agent (§10 WP20)",
				);
			},
			noEgressBeyondTheYard: async () => {
				const { guard } = await once();
				check(
					guard.refused().length === 0,
					`attempted egress to ${guard.refused().join(",")}`,
					"with egress disabled, reach only in-Yard hosts",
				);
				check(
					guard.allowed().length > 0,
					"no in-Yard request was made",
					"the local source and feed are reached over the Yard network",
				);
			},
			stationNeverDialsTheAgent: async () => {
				const { run } = await once();
				check(
					run.stationToAgentConnections === 0,
					`the Station opened ${run.stationToAgentConnections} connection(s) to the agent`,
					"agents dial out; the Station never connects to an agent (I3)",
				);
			},
			stationHoldsNoTargetCredential: async () => {
				const { run } = await once();
				check(
					run.stationTargetCredentials.length === 0,
					`the Station resolved ${run.stationTargetCredentials.join(",")}`,
					"in agent mode credentials stay with the agent (I3)",
				);
			},
		},
		options,
	);
}

// ── Journal replay (§10 WP20) ────────────────────────────────────────────────

export const JOURNAL_REPLAY_SUITE = "hobo.cd.journal-replay/v1";

export const JOURNAL_REPLAY_ASSERTIONS = Object.freeze([
	"liveRunRecordsState",
	"replayEqualsLive",
	"replayIsStable",
] as const);
export type JournalReplayAssertion = (typeof JOURNAL_REPLAY_ASSERTIONS)[number];

export interface JournalReplayHarness<TJournal, TState> {
	readonly subject: string;
	/** Run a full pipeline (ingest → promote dev/staging/prod → verify → qualify) live; return its journal and read-model state. */
	live(): Promise<Readonly<{ journal: TJournal; state: TState }>>;
	/** Rebuild every projection from the journal alone, in a fresh process-equivalent world. */
	replay(journal: TJournal): Promise<TState>;
}

export async function runJournalReplayConformance<TJournal, TState>(
	harness: JournalReplayHarness<TJournal, TState>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<JournalReplayAssertion>> {
	let cached: Readonly<{ journal: TJournal; state: TState }> | undefined;
	const live = async () => {
		cached ??= await harness.live();
		return cached;
	};
	return runCdAssertions<JournalReplayAssertion>(
		JOURNAL_REPLAY_SUITE,
		harness.subject,
		{
			liveRunRecordsState: async () => {
				const { state } = await live();
				check(
					canonicalText(state) !== "{}" && state !== undefined,
					"the live run produced empty state",
					"a full pipeline run records Freight, promotions and Sets",
				);
			},
			replayEqualsLive: async () => {
				const { journal, state } = await live();
				const replayed = await harness.replay(journal);
				check(
					canonicalText(replayed) === canonicalText(state),
					"state rebuilt from the journal differs from live",
					"every projection folds from the journal only (I8, §10 WP20)",
				);
			},
			replayIsStable: async () => {
				const { journal } = await live();
				const a = canonicalText(await harness.replay(journal));
				const b = canonicalText(await harness.replay(journal));
				check(
					a === b,
					"two replays of one journal disagree",
					"replay is deterministic: injected clock, no RNG (I8)",
				);
			},
		},
		options,
	);
}
