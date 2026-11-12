/**
 * Fleet and policy model for the HoBo.CD fleet journeys (plan 0024 WP20).
 * Placement and fan-out run on the conformance kit's reference engines (the
 * same ones the conformance suites prove). Failover (D23, I21) and Rail
 * inform → enforce (D24, I23) are modelled here at the decision level.
 * The model is deterministic: no clock, RNG or network.
 */
import {
	type FanoutScenario,
	type PlacementDecisionLike,
	type PlacementScenario,
	type ScenarioCamp,
	settleFanout,
} from "../../packages/conformance/src/index.js";
import { referenceDecide, referenceFanout } from "../../examples/cd-conformance-kit/src/reference/fleet.js";

// ── Retail edge fleet ────────────────────────────────────────────────────────

export function retailFleet(stores: number): ScenarioCamp[] {
	const regions = ["eu-west", "eu-central", "us-east", "us-west"] as const;
	return Array.from({ length: stores }, (_, i) => {
		const region = regions[i % regions.length] ?? "eu-west";
		return {
			campId: `store-${String(i).padStart(3, "0")}`,
			yard: `yard-${region}`,
			provider: i % 2 === 0 ? "cloudflare" : "vercel",
			regions: [region],
			labels: { tier: i < 8 ? "pilot" : "store" },
		};
	});
}

export type FleetRun = Readonly<{
	decision: PlacementDecisionLike;
	status: Awaited<ReturnType<typeof settleFanout>>;
	maxInFlight: number;
	started: readonly string[];
}>;

export async function rollOutToFleet(
	camps: readonly ScenarioCamp[],
	offline: ReadonlySet<string>,
	pilotSize: number,
	concurrency: number,
): Promise<FleetRun> {
	const scenario: PlacementScenario = {
		camps,
		scores: [],
		placement: { count: 0, spread: [{ topologyKey: "region", minGroups: 4 }], defaultGroupSize: 40 },
		nowMs: 1_000_000,
	};
	const outcome = referenceDecide(scenario, camps.map((c) => c.campId));
	if (!outcome.ok) throw new Error(`placement refused: ${outcome.reasons.map((r) => r.code).join(",")}`);
	const decision = outcome.value;
	const order = decision.groups.flatMap((g) => g.campIds);
	const pilot = order.slice(0, pilotSize);
	const fanout: FanoutScenario = {
		camps: order,
		groups: [
			{ name: "pilot", campIds: pilot, mandatory: true },
			{ name: "fleet", campIds: order.slice(pilotSize), mandatory: false },
		],
		strategy: 3,
		maxConcurrency: concurrency,
		maxFailures: Math.floor(order.length * 0.05),
		outcomes: Object.fromEntries(order.map((id) => [id, offline.has(id) ? "defer" : "succeed"])),
	};
	const world = referenceFanout(fanout);
	let maxInFlight = 0;
	const status = await settleFanout(world, order.length * 4, (s) => {
		maxInFlight = Math.max(maxInFlight, s.inFlight.length);
	});
	return { decision, status, maxInFlight, started: world.started() };
}

// ── Regional failover (D23, I21) ─────────────────────────────────────────────

export type FailoverCamp = Readonly<{ campId: string; provider: string; region: string; jurisdiction: "EU" | "US" }>;
export type FailoverEvent = Readonly<{ kind: "proposed" | "replacing" | "qualified" | "shifted" | "purged" | "refused"; from: string; to?: string; detail?: string }>;

export class FailoverModel {
	readonly taints = new Map<string, Set<"station" | "health-source" | "reconciler" | "operator">>();
	readonly events: FailoverEvent[] = [];
	readonly placedOn = new Set<string>();
	readonly purged = new Set<string>();
	inFlight = 0;

	constructor(
		readonly camps: readonly FailoverCamp[],
		readonly rail: Readonly<{ automatic: boolean; maxConcurrent: number; requiredSignals: number }>,
		readonly residency: "EU" | "US",
		readonly dataInCamp: ReadonlySet<string> = new Set(),
	) {}

	/** A signal that the Camp cannot run; NO_RUN needs required_signals with one Station-observed (D19). */
	signal(campId: string, source: "station" | "health-source" | "reconciler" | "operator"): void {
		const set = this.taints.get(campId) ?? new Set();
		set.add(source);
		this.taints.set(campId, set);
	}

	noRun(campId: string): boolean {
		const signals = this.taints.get(campId) ?? new Set();
		if (signals.has("operator")) return true;
		const independent = [...signals].filter((s) => s !== "reconciler");
		return independent.length >= this.rail.requiredSignals && signals.has("station");
	}

	/** One controller tick: propose, then run at most max_concurrent failovers. */
	tick(): void {
		for (const from of [...this.placedOn].sort()) {
			if (!this.noRun(from) || this.purged.has(from)) continue;
			if (this.events.some((e) => e.from === from && (e.kind === "replacing" || e.kind === "refused"))) continue;
			if (!this.events.some((e) => e.from === from && e.kind === "proposed")) this.events.push({ kind: "proposed", from });
			if (!this.rail.automatic || this.inFlight >= this.rail.maxConcurrent) continue;
			if (this.dataInCamp.has(from)) {
				this.events.push({ kind: "refused", from, detail: "failover-unsafe: data lives in the source Camp; run a Trails replica handover" });
				continue;
			}
			const to = this.camps
				.filter((c) => c.jurisdiction === this.residency && !this.placedOn.has(c.campId) && !this.noRun(c.campId))
				.sort((a, b) => a.campId.localeCompare(b.campId))[0];
			if (!to) {
				this.events.push({ kind: "refused", from, detail: "placement-unsatisfiable" });
				continue;
			}
			this.inFlight += 1;
			this.events.push({ kind: "replacing", from, to: to.campId });
			this.placedOn.add(to.campId);
		}
	}

	/** Replacement verification PASS, then cutover, then GRACEFUL purge. */
	qualify(from: string): void {
		const replacing = this.events.find((e) => e.from === from && e.kind === "replacing");
		if (!replacing?.to) return;
		this.events.push({ kind: "qualified", from, to: replacing.to });
		this.events.push({ kind: "shifted", from, to: replacing.to });
		this.events.push({ kind: "purged", from });
		this.purged.add(from);
		this.placedOn.delete(from);
		this.inFlight -= 1;
	}

	recover(campId: string): void {
		this.taints.delete(campId);
	}
}

// ── Rail inform → enforce (D24, I23) ─────────────────────────────────────────

export type RailEffect = "allow" | "deny";
export type EnforceOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>;

export class RailModel {
	enforced: string;
	candidate: string | undefined;
	informQualified = false;
	readonly shadow: { delta: string; enforced: RailEffect; candidate: RailEffect; diverged: boolean }[] = [];
	constructor(
		enforced: string,
		private readonly decide: (rail: string, delta: string) => RailEffect,
	) {
		this.enforced = enforced;
	}
	bindInform(rail: string): void {
		this.candidate = rail;
	}
	/** The gate: the enforced Rail decides; the candidate is shadowed and recorded. */
	gate(delta: string): RailEffect {
		const effect = this.decide(this.enforced, delta);
		if (this.candidate) {
			const shadowEffect = this.decide(this.candidate, delta);
			this.shadow.push({ delta, enforced: effect, candidate: shadowEffect, diverged: effect !== shadowEffect });
		}
		return effect;
	}
	/** R12: ≤ 2 % noncompliant and the declared number of divergences over the window. */
	verifyInform(noncompliantRatio: number, expectedDivergences: number): "PASS" | "FAIL" {
		const divergences = this.shadow.filter((s) => s.diverged).length;
		const verdict = noncompliantRatio <= 0.02 && divergences <= expectedDivergences ? "PASS" : "FAIL";
		this.informQualified = verdict === "PASS";
		return verdict;
	}
	enforce(rail: string): EnforceOutcome {
		if (this.candidate !== rail || !this.informQualified) return { ok: false, code: "shadow-required" };
		this.enforced = rail;
		this.candidate = undefined;
		return { ok: true };
	}
}
