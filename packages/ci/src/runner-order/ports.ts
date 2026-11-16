/**
 * The ports a runner-order host is built from. Each is the one way the
 * engine reads or writes something outside itself: the committed order, what
 * is true right now, the route journal, machines, provider health, billing
 * reads and stored runs.
 *
 * Job mode and relay mode (ADR-0183) implement them differently: job mode from
 * the workflow's context and GitHub's queue, relay mode from the relay's own
 * records. `./testing.ts` holds an in-memory fake of each and the conformance
 * function every real implementation must pass.
 */
import type {
	MachineAdvert,
	RelayJobAnswer,
	RelayJobMessage,
	RunnerRouteEvent,
} from "../_generated/relay_job_pb.js";
import type { RunnerRouteRequest } from "../_generated/runner_route_pb.js";
import type { InsightRun } from "../insights/types.js";
import type { RouteFacts } from "./decide.js";
import type { ProviderHealth } from "./health.js";
import type { MinutesUsage } from "./limits.js";
import type { MachineSharing } from "./machines.js";
import type { ParsedRunnerOrder } from "./order.js";
import type { HostedRunnerProvider } from "./providers.js";

/**
 * The runner order a repository has committed. `problem` is empty when the
 * order parsed; otherwise it is the parser's sentence and `order` is the
 * default, which nothing may walk while the problem stands.
 */
export type RunnerOrderLookup = Readonly<{
	order: ParsedRunnerOrder;
	problem: string;
}>;

export interface RunnerOrderSource {
	/** The order at `ref` (a git ref or commit), or the default branch's when undefined. */
	order(
		repository: string,
		ref: string | undefined,
	): Promise<RunnerOrderLookup>;
}

export interface RouteFactsSource {
	/** What is true for this request at `nowMs`. A part not measured is left out, never guessed. */
	facts(request: RunnerRouteRequest, nowMs: number): Promise<RouteFacts>;
}

/** Which journal entries to read: newest first, at most `limit`. */
export type RouteDecisionQuery = Readonly<{
	accountId: string;
	/** One repository's entries, or the account's when undefined. */
	repository: string | undefined;
	/** Entries at or after this epoch millisecond. */
	sinceMs: number;
	limit: number;
}>;

export interface RouteJournal {
	/**
	 * Keep one entry. Recording the same relay job's same event type twice
	 * (a redelivery) keeps the first.
	 */
	record(event: RunnerRouteEvent): Promise<void>;
	/** Entries of the account, newest first. */
	decisions(query: RouteDecisionQuery): Promise<readonly RunnerRouteEvent[]>;
}

export interface MachineRegistry {
	/** Every machine the account has, in id order. */
	list(accountId: string): Promise<readonly MachineAdvert[]>;
	/** Add a machine, or replace its advert. The account is the owner's id. */
	put(advert: MachineAdvert): Promise<void>;
	/** Pause or resume it. `by` is the login that asked. Unknown ids throw. */
	setPaused(id: string, paused: boolean, by: string): Promise<void>;
	/** Unknown ids throw. */
	setSharing(id: string, sharing: MachineSharing): Promise<void>;
	/** Forget it at once. Removing an unknown id does nothing. */
	remove(id: string): Promise<void>;
}

export interface ProviderHealthStore {
	/** The record for a `providerHealthKey`; a new, healthy one when none is kept. */
	get(key: string): Promise<ProviderHealth>;
	put(key: string, health: ProviderHealth): Promise<void>;
	/** Keys the walk should pass over at `nowMs`: tripped and not due a trial. */
	unhealthy(nowMs: number): Promise<ReadonlySet<string>>;
}

export interface MinutesReader {
	/** The owner's Actions minutes this cycle, or undefined when they cannot be read. */
	usage(owner: string): Promise<MinutesUsage | undefined>;
}

export interface SpendReader {
	/** US dollars spent per hosted provider since `monthStartMs`. A missing entry is unmeasured. */
	spentUsd(
		accountId: string,
		monthStartMs: number,
	): Promise<ReadonlyMap<HostedRunnerProvider, number>>;
}

/** Which stored runs to read: newest first, at most `limit`. */
export type InsightRunQuery = Readonly<{
	repository: string;
	/** Runs created at or after this epoch millisecond. */
	sinceMs: number;
	limit: number;
}>;

export interface InsightStore {
	/** Keep one run attempt; the same run id and attempt again replaces it. */
	ingest(run: InsightRun): Promise<void>;
	runs(query: InsightRunQuery): Promise<readonly InsightRun[]>;
}

/**
 * Answers a relay job made only of check steps, or returns undefined so the
 * job is routed instead.
 */
export type RelayChecks = (
	message: RelayJobMessage,
) => Promise<RelayJobAnswer | undefined>;
