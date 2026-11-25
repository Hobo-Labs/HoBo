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

export type RunnerOrderLookup = Readonly<{
	order: ParsedRunnerOrder;
	problem: string;
}>;

export interface RunnerOrderSource {
	order(
		repository: string,
		ref: string | undefined,
	): Promise<RunnerOrderLookup>;
}

export interface RouteFactsSource {
	facts(request: RunnerRouteRequest, nowMs: number): Promise<RouteFacts>;
}

export type RouteDecisionQuery = Readonly<{
	accountId: string;

	repository: string | undefined;

	sinceMs: number;
	limit: number;
}>;

export interface RouteJournal {
	record(event: RunnerRouteEvent): Promise<void>;

	decisions(query: RouteDecisionQuery): Promise<readonly RunnerRouteEvent[]>;
}

export interface MachineRegistry {
	list(accountId: string): Promise<readonly MachineAdvert[]>;

	put(advert: MachineAdvert): Promise<void>;

	setPaused(id: string, paused: boolean, by: string): Promise<void>;

	setSharing(id: string, sharing: MachineSharing): Promise<void>;

	remove(id: string): Promise<void>;
}

export interface ProviderHealthStore {
	get(key: string): Promise<ProviderHealth>;
	put(key: string, health: ProviderHealth): Promise<void>;

	unhealthy(nowMs: number): Promise<ReadonlySet<string>>;
}

export interface MinutesReader {
	usage(owner: string): Promise<MinutesUsage | undefined>;
}

export interface SpendReader {
	spentUsd(
		accountId: string,
		monthStartMs: number,
	): Promise<ReadonlyMap<HostedRunnerProvider, number>>;
}

export type InsightRunQuery = Readonly<{
	repository: string;

	sinceMs: number;
	limit: number;
}>;

export interface InsightStore {
	ingest(run: InsightRun): Promise<void>;
	runs(query: InsightRunQuery): Promise<readonly InsightRun[]>;
}

export type RelayChecks = (
	message: RelayJobMessage,
) => Promise<RelayJobAnswer | undefined>;
