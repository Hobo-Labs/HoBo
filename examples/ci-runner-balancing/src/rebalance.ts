/**
 * The rebalance actor. It consumes one RebalanceRequested command, reads
 * current routed-variable state, folds usage snapshots and hard-block
 * evidence into the CreditLedgerView projection, asks the pure dispatcher
 * for `dispatch.Decided` records, appends the resulting events to the
 * event store the caller supplies, and (in apply mode) drives the
 * execution adapter to patch Actions variables. The returned RebalancePlan
 * is the snapshot a read store keeps for "what is routing where right now".
 * The actor never mutates the read model directly — callers project the
 * appended events.
 */

import { create, toJson } from "@bufbuild/protobuf";

import {
	DecisionKind,
	type DispatchDecision,
	DispatchDecisionSchema,
	type HardBlockSignal,
	type RebalancePlan,
	RebalancePlanSchema,
	RebalanceRequestedSchema,
	type UsageSnapshot,
	UsageSnapshotSchema,
} from "./_generated/runner_balancing_pb.js";
import { decide } from "./decide.js";
import { buildCreditLedgerView } from "./ledger.js";
import {
	type JsonObject,
	type JsonValue,
	type ParsedRegistry,
	parseRegistryDocument,
} from "./parse.js";

export interface UsageSource {
	providerId: string;
	read(): Promise<UsageSnapshot>;
}

export interface VariablesReader {
	get(name: string): Promise<string | undefined>;
}

export interface VariablesWriter extends VariablesReader {
	set(name: string, value: string): Promise<void>;
}

/** One event-store append; family names come from docs/design/event-families.md. */
export interface LedgerEvent {
	family: string;
	payload: JsonObject;
}

export type VariableState = { [name: string]: string | undefined };

export interface RebalanceDeps {
	variables: VariablesWriter;
	usageSources: readonly UsageSource[];
	/** Reactive backstop evidence (failed-run scan); optional. */
	failureSignals?: () => Promise<readonly HardBlockSignal[]>;
}

export interface RebalanceOptions {
	/** Untrusted registry document; crosses the parse boundary here. */
	registryDocument: JsonValue;
	mode: "plan" | "apply";
	requestedBy: string;
	/** Pinned ledger sequence token recorded on every decision. */
	seq: string;
	pins?: readonly string[];
	flipUpPct?: number | undefined;
	flipBackPct?: number | undefined;
	allowNonFungibleFallback?: boolean;
}

export interface RebalanceResult {
	plan: RebalancePlan;
	events: readonly LedgerEvent[];
	snapshots: readonly UsageSnapshot[];
	hardBlocks: readonly HardBlockSignal[];
	applied: ReadonlyArray<{ variable: string; value: string }>;
	registry: ParsedRegistry;
	current: Readonly<VariableState>;
}

function variablesToRead(registry: ParsedRegistry): string[] {
	const names = new Set<string>();
	for (const track of registry.tracks) {
		names.add(track.variable);
		for (const rung of track.rungs) {
			for (const guard of rung.requires) {
				names.add(guard.variable);
			}
		}
	}
	return [...names];
}

export async function runRebalance(
	deps: RebalanceDeps,
	options: RebalanceOptions,
): Promise<RebalanceResult> {
	const registry = parseRegistryDocument(options.registryDocument);
	const command = create(RebalanceRequestedSchema, {
		requestedBy: options.requestedBy,
		mode: options.mode,
		ledgerSeq: options.seq,
	});
	const events: LedgerEvent[] = [];

	const current: VariableState = {};
	for (const name of variablesToRead(registry)) {
		current[name] = await deps.variables.get(name);
	}

	const snapshots = await Promise.all(
		deps.usageSources.map((source) => source.read()),
	);
	for (const snapshot of snapshots) {
		events.push({
			family: "meter.UsageRecorded",
			// SAFETY: protobuf JSON view is a JsonObject event payload.
			payload: toJson(UsageSnapshotSchema, snapshot) as JsonObject,
		});
	}

	const hardBlocks = [...(await (deps.failureSignals?.() ?? Promise.resolve([])))];
	const ledger = buildCreditLedgerView({
		providers: registry.providers,
		envelopes: registry.envelopes,
		snapshots,
		hardBlocks,
		seq: options.seq,
	});
	for (const entry of ledger.entries) {
		const facts = registry.providerById.get(entry.providerId)?.cost;
		const hadFreeTier = (facts?.freeUnitsPerMonth ?? 0) > 0;
		if (hadFreeTier && entry.freeHeadroomUnits === 0) {
			events.push({
				family: "credit.Exhausted",
				payload: { providerId: entry.providerId, ledgerSeq: ledger.seq },
			});
		}
	}

	const decisions = decide({
		tracks: registry.tracks,
		current,
		ledger,
		pins: new Set(options.pins ?? []),
		resourceBlocks: hardBlocks.filter((signal) => signal.resource !== ""),
		flipUpPct: options.flipUpPct,
		flipBackPct: options.flipBackPct,
		allowNonFungibleFallback: options.allowNonFungibleFallback ?? false,
	});
	for (const decision of decisions) {
		events.push({
			family: "dispatch.Decided",
			// SAFETY: protobuf JSON view is a JsonObject event payload.
			payload: toJson(DispatchDecisionSchema, decision) as JsonObject,
		});
	}

	const applied: Array<{ variable: string; value: string }> = [];
	if (command.mode === "apply") {
		for (const decision of flips(decisions)) {
			await deps.variables.set(decision.variable, decision.toValue);
			applied.push({ variable: decision.variable, value: decision.toValue });
			events.push({
				family: "exec.Succeeded",
				payload: {
					variable: decision.variable,
					value: decision.toValue,
					ledgerSeq: options.seq,
				},
			});
		}
	}

	return {
		plan: create(RebalancePlanSchema, { ledgerSeq: options.seq, decisions }),
		events,
		snapshots,
		hardBlocks,
		applied,
		registry,
		current,
	};
}

export function flips(
	decisions: readonly DispatchDecision[],
): DispatchDecision[] {
	return decisions.filter((decision) => decision.kind === DecisionKind.FLIP);
}
