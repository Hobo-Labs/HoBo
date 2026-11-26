/**
 * The port calls the statement pact records, in order, with a fixed clock and
 * fixed incarnations so every statement and reply is reproducible. Each call
 * is one statement; the purge is off and the table already exists (the
 * provider state).
 */
import {
	type EphemeralStatePort,
	parseEphemeralKey,
	parseEphemeralTtlMs,
	parseEphemeralVersion,
} from "@hobo/core";

import {
	createLibsqlEphemeralState,
	type LibsqlStatementClient,
} from "../../src/index.js";

export const PACT_NOW_MS = 1_800_000_000_000;

export function pactPort(client: LibsqlStatementClient): EphemeralStatePort {
	const incarnations = ["inc-1", "inc-2", "inc-3"];
	return createLibsqlEphemeralState({
		client,
		now: () => PACT_NOW_MS,
		newIncarnation: () => incarnations.shift() ?? "unexpected",
		purge: false,
	});
}

/** What the scenario observed through the port, for the consumer test to pin. */
export async function runPactScenario(
	state: EphemeralStatePort,
): Promise<unknown[]> {
	const lease = parseEphemeralKey("pact:lease:42");
	const counter = parseEphemeralKey("pact:rate:42");
	const absent = parseEphemeralKey("pact:absent");
	const ttl = parseEphemeralTtlMs(60_000);
	return [
		await state.putIfAbsent(lease, '{"runner":"r-1"}', ttl),
		await state.putIfAbsent(lease, '{"runner":"r-2"}', ttl),
		await state.get(lease),
		await state.compareAndSet(
			lease,
			parseEphemeralVersion("inc-1:1"),
			'{"runner":"r-1","state":"dispatched"}',
			ttl,
		),
		await state.delete(lease, parseEphemeralVersion("inc-1:1")),
		await state.getMany([lease, absent]),
		await state.increment(counter, 5, ttl),
		await state.increment(counter, -2, ttl, "refresh"),
		await state.expire(absent, ttl),
		await state.delete(lease),
	];
}
