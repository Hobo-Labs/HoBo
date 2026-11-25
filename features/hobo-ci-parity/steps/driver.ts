import {
	answerRelayJob,
	NO_ROUTE_FACTS,
	type RelayJobAnswer,
	type RelayJobMessage,
	type RelayMode,
	type RouteFacts,
	type RunnerRouteEvent,
} from "../../../packages/ci/src/index.js";
import {
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
} from "../../../packages/ci/src/runner-order/testing.js";

export interface ParityDriver {
	commitOrder(repository: string, runnerOrderJson: string): void;
	setFacts(facts: RouteFacts): void;
	answer(message: RelayJobMessage): Promise<RelayJobAnswer>;
	journal(): Promise<readonly RunnerRouteEvent[]>;
}

export const PARITY_ACCOUNT = "acct-parity";

export class FakeParityDriver implements ParityDriver {
	private readonly orders = new Map<string, string>();
	private facts: RouteFacts = NO_ROUTE_FACTS;
	private readonly routeJournal = new InMemoryRouteJournal();
	private nowMs = 1_000;

	constructor(private readonly mode: RelayMode = "relay") {}

	commitOrder(repository: string, runnerOrderJson: string): void {
		this.orders.set(repository.toLowerCase(), runnerOrderJson);
	}

	setFacts(facts: RouteFacts): void {
		this.facts = facts;
	}

	async answer(message: RelayJobMessage): Promise<RelayJobAnswer> {
		this.nowMs += 1_000;
		const facts = this.facts;
		return answerRelayJob(message, {
			order: new InMemoryRunnerOrderSource(this.orders),
			facts: new InMemoryRouteFactsSource(() => facts),
			journal: this.routeJournal,
			nowMs: this.nowMs,
			mode: this.mode,
			node: "parity-node",
			accountId: PARITY_ACCOUNT,
			checks: undefined,
		});
	}

	journal(): Promise<readonly RunnerRouteEvent[]> {
		return this.routeJournal.decisions({
			accountId: PARITY_ACCOUNT,
			repository: undefined,
			sinceMs: 0,
			limit: 1_000,
		});
	}
}
