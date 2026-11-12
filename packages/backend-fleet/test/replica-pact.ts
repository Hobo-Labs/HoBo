/**
 * The replica's side of `contracts/ephemeral-assignment-replica.pact.json`:
 * the scenario both sides run, a port that replays the pact, and a recorder
 * that turns real port calls into interactions.
 */
import { readFileSync } from "node:fs";
import type {
	EphemeralEntry,
	EphemeralKey,
	EphemeralStatePort,
	EphemeralTtlMs,
	EphemeralVersion,
	EphemeralWrite,
} from "@hobo/core";
import { parseEphemeralVersion } from "@hobo/core";
import {
	type EphemeralAssignmentReplica,
	ephemeralAssignmentReplica,
	parseFleetAssignment,
} from "../src/index.js";

export const PACT_KEY = "hobo-ci:production:fleet:assignment";

/** One port call as the pact records it. Only what the replica uses. */
export type PortRequest =
	| { readonly operation: "get"; readonly key: string }
	| {
			readonly operation: "putIfAbsent";
			readonly key: string;
			readonly value: string;
			readonly ttlMs: number;
	  }
	| {
			readonly operation: "compareAndSet";
			readonly key: string;
			readonly expected: string;
			readonly value: string;
			readonly ttlMs: number;
	  }
	| {
			readonly operation: "expire";
			readonly key: string;
			readonly ttlMs: number;
	  };

export type PortResponse =
	| {
			readonly entry: {
				readonly value: string;
				readonly version: string;
			} | null;
	  }
	| { readonly applied: true; readonly version: string }
	| { readonly applied: false }
	| { readonly present: boolean };

export type PortInteraction = {
	readonly description: string;
	readonly providerState: string;
	readonly request: PortRequest;
	readonly response: PortResponse;
};

export function loadReplicaPact(): readonly PortInteraction[] {
	const pact: { interactions: PortInteraction[] } = JSON.parse(
		readFileSync(
			new URL(
				"../contracts/ephemeral-assignment-replica.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	return pact.interactions;
}

function asWrite(response: PortResponse): EphemeralWrite {
	if ("applied" in response)
		return response.applied
			? { applied: true, version: parseEphemeralVersion(response.version) }
			: { applied: false };
	throw new Error("pact response is not a write");
}

/** Run one request against a real port and describe its answer. */
export async function execute(
	port: EphemeralStatePort,
	request: PortRequest,
	parse: {
		key(value: string): EphemeralKey;
		ttl(value: number): EphemeralTtlMs;
	},
): Promise<PortResponse> {
	const key = parse.key(request.key);
	switch (request.operation) {
		case "get": {
			const entry = await port.get(key);
			return {
				entry: entry ? { value: entry.value, version: entry.version } : null,
			};
		}
		case "putIfAbsent":
			return port.putIfAbsent(key, request.value, parse.ttl(request.ttlMs));
		case "compareAndSet":
			return port.compareAndSet(
				key,
				parseEphemeralVersion(request.expected),
				request.value,
				parse.ttl(request.ttlMs),
			);
		case "expire":
			return { present: await port.expire(key, parse.ttl(request.ttlMs)) };
	}
}

/** A port that answers from the pact, in order, and records what it was asked. */
export function replayPort(interactions: readonly PortInteraction[]) {
	const sent: PortRequest[] = [];
	let next = 0;
	const answer = (request: PortRequest): PortResponse => {
		sent.push(request);
		const interaction = interactions[next];
		next += 1;
		if (!interaction)
			throw new Error("the replica sent more calls than the pact");
		return interaction.response;
	};
	const unused = () => Promise.reject(new Error("not part of the contract"));
	const port: EphemeralStatePort = {
		async get(key) {
			const response = answer({ operation: "get", key });
			if (!("entry" in response)) throw new Error("not a read");
			return response.entry === null
				? undefined
				: ({
						value: response.entry.value,
						version: parseEphemeralVersion(response.entry.version),
					} satisfies EphemeralEntry);
		},
		async putIfAbsent(key, value, ttlMs) {
			return asWrite(answer({ operation: "putIfAbsent", key, value, ttlMs }));
		},
		async compareAndSet(key, expected: EphemeralVersion, value, ttlMs) {
			return asWrite(
				answer({ operation: "compareAndSet", key, expected, value, ttlMs }),
			);
		},
		async expire(key, ttlMs) {
			const response = answer({ operation: "expire", key, ttlMs });
			if (!("present" in response)) throw new Error("not an expire");
			return response.present;
		},
		getMany: unused,
		delete: unused,
		increment: unused,
	};
	return { port, sent };
}

const bootstrap = parseFleetAssignment({
	epoch: 1,
	active: "upstash",
	sealed: false,
	target: undefined,
	reason: "bootstrap",
	lossWindowMs: undefined,
	decidedAtMs: 0,
	decidedBy: "bootstrap",
});
const sealed = parseFleetAssignment({
	epoch: 2,
	active: "upstash",
	sealed: true,
	target: "turso",
	reason: "switch:commands-projected",
	lossWindowMs: undefined,
	decidedAtMs: 1_800_000_000_000,
	decidedBy: "hobo-ci-relay",
});

/** What the replica does in the pact, and what it concludes. */
export async function runReplicaScenario(
	replica: (port: EphemeralStatePort) => EphemeralAssignmentReplica,
	port: EphemeralStatePort,
): Promise<unknown[]> {
	const subject = replica(port);
	return [
		await subject.read(),
		await subject.accept(bootstrap),
		await subject.accept(sealed),
		await subject.accept(sealed),
		await subject.accept({ ...sealed, epoch: 4 }),
		(await subject.read(1)).map((entry) => entry.epoch),
		await subject.refresh(),
		await subject.seed(bootstrap),
	];
}

export const pactReplica = (port: EphemeralStatePort) =>
	ephemeralAssignmentReplica(port, "upstash", { key: PACT_KEY });
