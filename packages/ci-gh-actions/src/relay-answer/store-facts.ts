import {
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
	type RunnerFleetState,
	type RunnerRouteRequest,
	registryMachineCandidates,
	type SpendReader,
} from "@hobo/ci";

export type ActiveLeaseSource = Readonly<{
	activeLeases(): Promise<readonly Readonly<{ accountId: string }>[]>;
}>;

export type RunnerFleetRoom = Readonly<{
	slots: number;
	isolated: boolean;
	leases: ActiveLeaseSource;
}>;

export type StoreRouteFactsDeps = Readonly<{
	accountId: string;
	fleet: RunnerFleetRoom | undefined;
	machines: MachineRegistry | undefined;
	readers: ((repository: string) => Promise<ReadonlySet<string>>) | undefined;
	spend: SpendReader | undefined;
	health: ProviderHealthStore | undefined;
	minutes: MinutesReader | undefined;
	onWarning: ((warning: StoreFactsWarning) => void) | undefined;
}>;

export type StoreFactsWarning = Readonly<{
	part: "fleet" | "machines" | "spend" | "health" | "minutes";
	message: string;
}>;

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

	private async fleet(): Promise<RunnerFleetState | undefined> {
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
