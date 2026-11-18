/**
 * The one interface the parity scenarios drive a relay through.
 *
 * A step never reaches into a port or a simulator itself: it commits an
 * order, says what is true now, hands over a relay job and reads back the
 * answer and the journal. `FakeParityDriver` backs it with the in-memory
 * ports of `@hobo/ci/runner-order/testing` and the real `answerRelayJob`;
 * a driver over the GitHub simulator implements the same interface, so a
 * scenario does not change when it moves to the simulator.
 */
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
	/** Commit a `runnerOrder` (its JSON text) in a repository's `.hobo/ci.json`. */
	commitOrder(repository: string, runnerOrderJson: string): void;
	/** Say what is true from now on: fleet room, machines, limits, health. */
	setFacts(facts: RouteFacts): void;
	/** Hand one relay job to the answerer and return its answer. */
	answer(message: RelayJobMessage): Promise<RelayJobAnswer>;
	/** The route journal of the account, newest first. */
	journal(): Promise<readonly RunnerRouteEvent[]>;
}

export const PARITY_ACCOUNT = "acct-parity";

/** The driver over the wave-0 fakes: no network, no clock, no store. */
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
