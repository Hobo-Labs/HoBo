/**
 * Journey model for the HoBo.CD acceptance features (plan 0024 WP20).
 *
 * A deterministic, port-level model of the delivery decisions the journeys
 * exercise: lineage (I16), windows (I17), approvals, proposal-only agents
 * (I10), rollback as a Delta (I7, D12), drift remediation, previews, GitOps
 * publishing (D5), and the Mann–Whitney verdict (D9). It holds no wall clock,
 * no RNG and no network. These features are executable specs, bound to this
 * model until the merged composition (`composeContinuousDelivery`, WP18)
 * replaces it as the binding (plan 0024 §11).
 */

// ── Mann–Whitney U, two-sided, normal approximation with tie correction ─────

export const SENSITIVITY_ALPHA = Object.freeze({ LOW: 0.01, MEDIUM: 0.05, HIGH: 0.1 } as const);
export type Sensitivity = keyof typeof SENSITIVITY_ALPHA;

function erf(x: number): number {
	// Abramowitz–Stegun 7.1.26, |error| < 1.5e-7.
	const sign = x < 0 ? -1 : 1;
	const t = 1 / (1 + 0.3275911 * Math.abs(x));
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
	return sign * y;
}

export type MannWhitney = Readonly<{ u: number; z: number; p: number }>;

/** Two-sided Mann–Whitney U of `a` vs `b` (normal approximation, tie-corrected). */
export function mannWhitney(a: readonly number[], b: readonly number[]): MannWhitney {
	const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
	const ranks: number[] = Array.from({ length: all.length }, () => 0);
	let tie = 0;
	for (let i = 0; i < all.length; ) {
		let j = i;
		while (j + 1 < all.length && all[j + 1]?.v === all[i]?.v) j += 1;
		const rank = (i + j + 2) / 2;
		for (let k = i; k <= j; k += 1) ranks[k] = rank;
		const t = j - i + 1;
		tie += t ** 3 - t;
		i = j + 1;
	}
	const n1 = a.length;
	const n2 = b.length;
	const r1 = all.reduce((sum, item, i) => (item.g === 0 ? sum + (ranks[i] ?? 0) : sum), 0);
	const u = r1 - (n1 * (n1 + 1)) / 2;
	const n = n1 + n2;
	const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1))));
	const z = sigma === 0 ? 0 : (u - (n1 * n2) / 2) / sigma;
	const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
	return { u, z, p };
}

/** D9: FAIL only when the canary is significantly worse (higher is worse); no data is FAIL. */
export function compareCanary(canary: readonly number[], baseline: readonly number[], sensitivity: Sensitivity, minObservations = 3): "PASS" | "FAIL" {
	if (canary.length < minObservations || baseline.length < minObservations) return "FAIL";
	const { z, p } = mannWhitney(canary, baseline);
	return p < SENSITIVITY_ALPHA[sensitivity] && z > 0 ? "FAIL" : "PASS";
}

// ── Delivery model ───────────────────────────────────────────────────────────

export type Principal = Readonly<{ id: string; kind: "human" | "agent" }>;
export type PromotionResult =
	| Readonly<{ status: "promoted"; setId: string }>
	| Readonly<{ status: "proposed"; proposalId: string }>
	| Readonly<{ status: "awaiting-window" }>
	| Readonly<{ status: "refused"; code: string; remediation: string }>;

type NodeSpec = { name: string; camp: string; upstream?: string; window?: string; soakMs: number };

export class DeliveryModel {
	now = 1_000_000;
	readonly nodes = new Map<string, NodeSpec>();
	readonly freight = new Set<string>();
	readonly yanked = new Set<string>();
	readonly qualified = new Map<string, number>();
	readonly approvals = new Map<string, number>();
	readonly freezes = new Map<string, boolean>();
	readonly overrides = new Map<string, number>();
	readonly sets = new Map<string, string[]>();
	readonly proposals: string[] = [];
	readonly journal: string[] = [];
	readonly drift = new Set<string>();

	node(name: string, camp: string, upstream?: string, soakMs = 0, window?: string): void {
		const spec: NodeSpec = { name, camp, soakMs };
		if (upstream !== undefined) spec.upstream = upstream;
		if (window !== undefined) spec.window = window;
		this.nodes.set(name, spec);
	}

	record(freightId: string): void {
		this.freight.add(freightId);
		this.journal.push(`freight.Recorded ${freightId}`);
	}

	current(camp: string): string | undefined {
		return this.sets.get(camp)?.at(-1);
	}

	windowOpen(name: string | undefined): boolean {
		if (name === undefined || !this.freezes.get(name)) return true;
		return (this.overrides.get(name) ?? 0) > this.now;
	}

	available(freightId: string, node: NodeSpec): boolean {
		if (!node.upstream) return true;
		const qualifiedAt = this.qualified.get(`${freightId}@${node.upstream}`);
		if (qualifiedAt !== undefined && this.now - qualifiedAt >= node.soakMs) return true;
		return (this.approvals.get(`${freightId}@${node.name}`) ?? 0) > this.now;
	}

	promote(freightId: string, nodeName: string, principal: Principal): PromotionResult {
		const node = this.nodes.get(nodeName);
		if (!node) return { status: "refused", code: "pipeline-node-unknown", remediation: "apply the pipeline first" };
		if (!this.freight.has(freightId) || this.yanked.has(freightId)) return { status: "refused", code: "freight-unusable", remediation: "promote usable Freight" };
		if (!this.available(freightId, node)) {
			return { status: "refused", code: "lineage-unsatisfied", remediation: `qualify the Freight upstream in ${node.upstream} or record an unexpired approval` };
		}
		if (principal.kind === "agent") {
			const proposalId = `proposal-${this.proposals.length + 1}`;
			this.proposals.push(proposalId);
			this.journal.push(`env.PromoteRequested ${freightId} ${nodeName} proposal`);
			return { status: "proposed", proposalId };
		}
		if (!this.windowOpen(node.window)) return { status: "awaiting-window" };
		const history = this.sets.get(node.camp) ?? [];
		this.sets.set(node.camp, [...history, freightId]);
		this.journal.push(`delta.Applied ${node.camp} ${freightId}`);
		return { status: "promoted", setId: `set-${node.camp}-${history.length + 1}` };
	}

	qualify(freightId: string, nodeName: string, verdict: "PASS" | "FAIL"): boolean {
		if (verdict !== "PASS") return false;
		this.qualified.set(`${freightId}@${nodeName}`, this.now);
		this.journal.push(`freight.Qualified ${freightId} ${nodeName}`);
		return true;
	}

	/** D12: zero exposure, then a Delta to the predecessor Set through the same gate. */
	rollback(camp: string): string | undefined {
		const history = this.sets.get(camp) ?? [];
		if (history.length < 2) return undefined;
		const previous = history.at(-2);
		if (previous === undefined) return undefined;
		this.sets.set(camp, [...history, previous]);
		this.journal.push(`env.PromoteRolledBack ${camp} ${previous}`);
		return previous;
	}

	approve(freightId: string, nodeName: string, ttlMs: number, maxMs: number): boolean {
		if (ttlMs > maxMs) return false;
		this.approvals.set(`${freightId}@${nodeName}`, this.now + ttlMs);
		this.journal.push(`freight.Approved ${freightId} ${nodeName}`);
		return true;
	}

	/** The reconciler's pass: drifted Camps re-converge to their desired Set. */
	reconcile(camp: string): "converged" | "remediated" {
		if (!this.drift.has(camp)) return "converged";
		this.drift.delete(camp);
		this.journal.push(`deployment.Converged ${camp} drift-remediate`);
		return "remediated";
	}
}

// ── Staged rollout under windows (D8, D10, I17) ──────────────────────────────

export const CANARY_STAGES = Object.freeze([5, 25, 50, 100] as const);

export class StagedRollout {
	stage = -1;
	held = false;
	constructor(
		private readonly model: DeliveryModel,
		private readonly window: string,
	) {}
	get percent(): number {
		return this.stage < 0 ? 0 : (CANARY_STAGES[this.stage] ?? 0);
	}
	/** Advance at a stage boundary; hold there while the window is closed. */
	boundary(): void {
		if (!this.model.windowOpen(this.window)) {
			this.held = true;
			return;
		}
		this.held = false;
		if (this.stage < CANARY_STAGES.length - 1) this.stage += 1;
	}
}

// ── Previews and GitOps publishing ───────────────────────────────────────────

export class Previews {
	readonly live = new Map<string, number>();
	create(id: string, nowMs: number, ttlMs: number): void {
		this.live.set(id, nowMs + ttlMs);
	}
	expire(nowMs: number): readonly string[] {
		const gone = [...this.live].filter(([, until]) => until <= nowMs).map(([id]) => id);
		for (const id of gone) this.live.delete(id);
		return gone;
	}
}

export class GitOpsPublisher {
	readonly commits = new Map<string, string>();
	synced: string | undefined;
	publish(setId: string, content: string): string {
		const revision = `rev-${content.length}-${setId}`;
		this.commits.set(setId, revision);
		return revision;
	}
	observe(revision: string): "CONVERGING" | "CONVERGED" {
		return this.synced === revision ? "CONVERGED" : "CONVERGING";
	}
}
