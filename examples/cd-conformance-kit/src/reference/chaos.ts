// Reference chaos world and fan-out load world. A small simulated fleet: a
// Station with a fenced reconciler per Camp, a source, and a failover budget.
// Faults act on the simulation; mutants model the failure modes the chaos
// lane exists to catch (repeat applies, early purge, NO_RUN from self-report,
// lost checkpoints, wedging).
import type { CdChaosFault, CdChaosHarness, ChaosObservation, ChaosWorld, FanoutLoadHarness, FanoutLoadWorld } from "@hobo/conformance";

export type ChaosMutant =
	| "reapplies-after-crash"
	| "lost-checkpoint"
	| "trusts-flapping-agent"
	| "failover-storm"
	| "purges-early"
	| "wedges-after-outage"
	| "trusts-payload";

const CAMPS = ["edge-1", "edge-2", "edge-3", "edge-4"] as const;

class SimWorld implements ChaosWorld {
	desired = 1;
	readonly applied = new Map<string, number>(CAMPS.map((camp) => [camp, 1]));
	readonly applyLog = new Map<string, number>();
	checkpoint = 1;
	checkpointRegressions = 0;
	noRunTaints = 0;
	failoversInFlight = 0;
	purgedEarly = 0;
	unverifiedFreight = 0;
	readonly faults = new Set<CdChaosFault>();
	crashed = new Set<string>();
	flaps = 0;
	wedged = false;
	sourceVersion = 1;

	constructor(private readonly mutant?: ChaosMutant) {}

	async inject(fault: CdChaosFault): Promise<void> {
		this.faults.add(fault);
		if (fault === "source-registry-outage") {
			// A webhook nudges during the outage; only a verified read may create Freight.
			if (this.mutant === "trusts-payload") this.unverifiedFreight += 1;
			this.sourceVersion += 1;
			return;
		}
		this.desired += 1;
		if (fault === "mass-lease-loss") this.failoversInFlight = this.mutant === "failover-storm" ? CAMPS.length : 1;
	}

	async heal(fault: CdChaosFault): Promise<void> {
		this.faults.delete(fault);
		if (fault === "store-failover" && this.mutant === "lost-checkpoint") {
			this.checkpoint = 0;
			this.checkpointRegressions += 1;
		}
		if (fault === "source-registry-outage" && this.mutant === "wedges-after-outage") this.wedged = true;
	}

	#apply(camp: string): void {
		const key = `${camp}@${this.desired}`;
		this.applyLog.set(key, (this.applyLog.get(key) ?? 0) + 1);
	}

	async step(): Promise<void> {
		if (this.wedged) return;
		if (this.faults.has("source-registry-outage")) return;
		if (!this.faults.has("source-registry-outage") && this.sourceVersion > this.desired) this.desired = this.sourceVersion;
		if (this.faults.has("agent-flapping-conditions")) {
			this.flaps += 1;
			if (this.mutant === "trusts-flapping-agent" && this.flaps >= 3) this.noRunTaints = 1;
		}
		for (const camp of CAMPS) {
			const partitioned = this.faults.has("agent-partitioned") && camp === "edge-1";
			const leaseLost = this.faults.has("mass-lease-loss");
			const storeDown = this.faults.has("store-failover");
			if (partitioned || leaseLost || storeDown) continue;
			if ((this.applied.get(camp) ?? 0) >= this.desired) continue;
			if (this.faults.has("reconciler-killed-mid-converge") && !this.crashed.has(camp)) {
				// Applied, then killed before observing.
				this.#apply(camp);
				this.crashed.add(camp);
				continue;
			}
			if (this.crashed.has(camp)) {
				this.crashed.delete(camp);
				if (this.mutant === "reapplies-after-crash") this.#apply(camp);
				this.applied.set(camp, this.desired);
				continue;
			}
			this.#apply(camp);
			this.applied.set(camp, this.desired);
		}
		if (!this.faults.has("mass-lease-loss") && this.failoversInFlight > 0) {
			if (this.mutant === "purges-early") this.purgedEarly = 1;
			this.failoversInFlight = 0;
		}
		if (!this.faults.has("store-failover")) this.checkpoint = Math.max(this.checkpoint, this.desired);
	}

	async observe(): Promise<ChaosObservation> {
		const duplicateApplies = [...this.applyLog.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
		return {
			converged: CAMPS.every((camp) => this.applied.get(camp) === this.desired) && this.desired >= this.sourceVersion,
			duplicateApplies,
			noRunTaints: this.noRunTaints,
			failoversInFlight: this.failoversInFlight,
			failoverBudget: 1,
			purgedBeforeReplacementQualified: this.purgedEarly,
			checkpointRegressions: this.checkpointRegressions,
			unverifiedFreight: this.unverifiedFreight,
		};
	}
}

export function refChaosHarness(mutant?: ChaosMutant): CdChaosHarness {
	return { subject: mutant ? `reference-chaos[${mutant}]` : "reference-chaos", create: async () => new SimWorld(mutant) };
}

// ── Load ─────────────────────────────────────────────────────────────────────

export type LoadMutant = "scans-fleet-quadratically";

/** A fan-out over `camps` with 10% group concurrency; each tick is O(batch). */
export function refLoadHarness(mutant?: LoadMutant): FanoutLoadHarness {
	return {
		subject: mutant ? `reference-load[${mutant}]` : "reference-load",
		clock: () => performance.now(),
		create: async (camps: number): Promise<FanoutLoadWorld> => {
			const ids = Array.from({ length: camps }, (_, i) => `camp-${i}`);
			const state = new Map<string, "pending" | "in-flight" | "succeeded">(ids.map((id) => [id, "pending"]));
			const batch = Math.max(1, Math.floor(camps / 10));
			let cursor = 0;
			const inFlight: string[] = [];
			return {
				tick: async () => {
					if (mutant === "scans-fleet-quadratically") {
						for (const a of ids) for (const b of ids.slice(0, 200)) if (a === b) state.get(a);
					}
					while (inFlight.length < batch && cursor < ids.length) {
						const id = ids[cursor++];
						if (id === undefined) break;
						state.set(id, "in-flight");
						inFlight.push(id);
					}
				},
				settle: async () => {
					for (const id of inFlight.splice(0)) state.set(id, "succeeded");
				},
				completed: async () => cursor >= ids.length && inFlight.length === 0,
			};
		},
	};
}
