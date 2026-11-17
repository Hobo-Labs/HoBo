/**
 * `StoreRouteFacts`: route facts for relay mode (ADR-0183), read from what
 * the relay itself keeps rather than from GitHub's queue.
 *
 * - Fleet room comes from the lease ledger: the fleet serves the account when
 *   it has slots, takes a job while fewer leases are active than it has
 *   slots, and isolates public and fork jobs only when the node says so.
 * - Machines come from the machine registry: every advert of the account,
 *   online while renewed within the advert's lifetime.
 * - Spend comes from the spend reader (the ledger first, list prices second).
 * - Unhealthy runner types come from the provider health store.
 * - Minutes come from the minutes reader, for the repository's owner.
 *
 * Each read stands alone. One that fails leaves its part unmeasured and says
 * so through `onWarning`; it never fails the facts, because a missing
 * measurement never blocks a routing step.
 */
import {
	type FleetState,
	type HostedRunnerProvider,
	type MachineCandidate,
	type MachineRegistry,
	type MinutesReader,
	type MinutesUsage,
	monthStartMs,
	NO_ROUTE_FACTS,
	type ProviderHealthStore,
	type RouteFacts,
	type RouteFactsSource,
	type RunnerRouteRequest,
	registryMachineCandidates,
	type SpendReader,
} from "@hobo/ci";

/** The leases the fleet is running now; the relay's lease store has this read. */
export type ActiveLeaseSource = Readonly<{
	activeLeases(): Promise<readonly Readonly<{ accountId: string }>[]>;
}>;

/** The fleet this node can start runners on, when it has one. */
export type FleetRoom = Readonly<{
	/** Jobs the fleet runs at once. Zero means it serves nobody. */
	slots: number;
	/** Each job gets a machine nothing else shares, so public and fork jobs may run there. */
	isolated: boolean;
	leases: ActiveLeaseSource;
}>;

export type StoreRouteFactsDeps = Readonly<{
	/** The HoBo account the job belongs to. */
	accountId: string;
	/** Undefined when this node has no fleet: the fleet step is then off. */
	fleet: FleetRoom | undefined;
	machines: MachineRegistry | undefined;
	/**
	 * GitHub user ids of the machine owners who can read `repository`. An owner
	 * left out cannot, so a machine shared with anyone is not offered to
	 * someone else's job in it.
	 */
	readers: ((repository: string) => Promise<ReadonlySet<string>>) | undefined;
	spend: SpendReader | undefined;
	health: ProviderHealthStore | undefined;
	minutes: MinutesReader | undefined;
	/** One line per read that failed; the part it would have measured is left out. */
	onWarning: ((warning: StoreFactsWarning) => void) | undefined;
}>;

/** A read the facts went without. */
export type StoreFactsWarning = Readonly<{
	part: "fleet" | "machines" | "spend" | "health" | "minutes";
	message: string;
}>;

/** The repository's owner: whose Actions minutes a GitHub-hosted job spends. */
export function repositoryOwner(repository: string): string {
	const slash = repository.indexOf("/");
	return (slash < 0 ? repository : repository.slice(0, slash)).toLowerCase();
}

export class StoreRouteFacts implements RouteFactsSource {
	constructor(private readonly deps: StoreRouteFactsDeps) {}

	async facts(request: RunnerRouteRequest, nowMs: number): Promise<RouteFacts> {
		const [fleet, machines, spendUsd, unhealthy, minutes] = await Promise.all([
			this.read("fleet", undefined, () => this.fleet()),
			this.read("machines", [], () => this.machines(request, nowMs)),
			this.read("spend", NO_ROUTE_FACTS.spendUsd, () => this.spend(nowMs)),
			this.read("health", NO_ROUTE_FACTS.unhealthy, () =>
				this.unhealthy(nowMs),
			),
			this.read("minutes", undefined, () => this.minutes(request)),
		]);
		return {
			...NO_ROUTE_FACTS,
			fleet,
			machines,
			spendUsd,
			unhealthy,
			minutes,
		};
	}

	private async read<T>(
		part: StoreFactsWarning["part"],
		fallback: T,
		action: () => Promise<T>,
	): Promise<T> {
		try {
			return await action();
		} catch (error) {
			this.deps.onWarning?.({
				part,
				message: error instanceof Error ? error.message : String(error),
			});
			return fallback;
		}
	}

	private async fleet(): Promise<FleetState | undefined> {
		const room = this.deps.fleet;
		if (!room || room.slots <= 0) return undefined;
		const active = await room.leases.activeLeases();
		return {
			enabled: true,
			taking: active.length < room.slots,
			isolated: room.isolated,
		};
	}

	private async machines(
		request: RunnerRouteRequest,
		nowMs: number,
	): Promise<readonly MachineCandidate[]> {
		const registry = this.deps.machines;
		if (!registry) return [];
		const readers = this.deps.readers
			? await this.deps.readers(request.repository)
			: new Set<string>();
		return registryMachineCandidates(registry, {
			accountId: this.deps.accountId,
			nowMs,
			readers,
		});
	}

	private async spend(
		nowMs: number,
	): Promise<ReadonlyMap<HostedRunnerProvider, number>> {
		const reader = this.deps.spend;
		if (!reader) return NO_ROUTE_FACTS.spendUsd;
		const spent = await reader.spentUsd(
			this.deps.accountId,
			monthStartMs(nowMs),
		);
		// A spend that is not a real, non-negative number was not measured.
		return new Map(
			[...spent].filter(([, usd]) => Number.isFinite(usd) && usd >= 0),
		);
	}

	private async unhealthy(nowMs: number): Promise<ReadonlySet<string>> {
		const store = this.deps.health;
		if (!store) return NO_ROUTE_FACTS.unhealthy;
		return store.unhealthy(nowMs);
	}

	private async minutes(
		request: RunnerRouteRequest,
	): Promise<MinutesUsage | undefined> {
		const reader = this.deps.minutes;
		if (!reader) return undefined;
		const usage = await reader.usage(repositoryOwner(request.repository));
		if (!usage) return undefined;
		return usage.usedMinutes >= 0 && usage.includedMinutes >= 0
			? usage
			: undefined;
	}
}
