import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSecretRef, type SecretRef, SecretValue } from "@hobo/bindings";
import type {
	SecretCustodyPort,
	SecretCustodyScope,
	SecretResolverPort,
} from "../src/custody.js";
import type {
	ProcessResult,
	ProcessRunner,
	ProcessRunOptions,
} from "../src/migration.js";
import type {
	NeonTransport,
	TransportRequest,
	TransportResponse,
} from "../src/transport.js";

export function fixture(name: string): string {
	return readFileSync(
		fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
		"utf8",
	);
}

export type StubExchange = {
	readonly status: number;
	readonly body: string;
	readonly headers?: Readonly<Record<string, string>>;
	/** Simulates a timeout or dropped connection. */
	readonly throws?: Error;
};

export type StubTransport = NeonTransport & {
	readonly requests: readonly TransportRequest[];
	readonly posts: readonly TransportRequest[];
	readonly gets: readonly TransportRequest[];
};

export function createStubTransport(
	exchanges: readonly StubExchange[],
): StubTransport {
	const requests: TransportRequest[] = [];
	const queue = [...exchanges];
	return {
		get requests() {
			return requests;
		},
		get posts() {
			return requests.filter((request) => request.method === "POST");
		},
		get gets() {
			return requests.filter((request) => request.method === "GET");
		},
		async request(request: TransportRequest): Promise<TransportResponse> {
			requests.push(request);
			const next = queue.shift();
			if (next === undefined) {
				throw new Error(
					`stub transport ran out of exchanges at ${request.method} ${request.url}`,
				);
			}
			if (next.throws !== undefined) throw next.throws;
			return {
				status: next.status,
				headers: next.headers ?? {},
				body: next.body,
			};
		},
	};
}

export type StubCustody = SecretCustodyPort &
	SecretResolverPort & {
		readonly deposits: readonly {
			readonly ref: string;
			readonly scope: SecretCustodyScope;
		}[];
	};

/** In-memory custody. Values are held here so tests can prove they left. */
export function createStubCustody(): StubCustody {
	const values = new Map<string, string>();
	const deposits: { ref: string; scope: SecretCustodyScope }[] = [];
	let counter = 0;
	return {
		get deposits() {
			return deposits;
		},
		async deposit(value: string, scope: SecretCustodyScope): Promise<string> {
			counter += 1;
			const ref = `hobo-secret://test-vault/${scope.providerId}/secret-${counter}#value`;
			values.set(ref, value);
			deposits.push({ ref, scope });
			return ref;
		},
		async resolve(ref: SecretRef): Promise<SecretValue> {
			const value = values.get(ref);
			if (value === undefined) throw new Error("unknown secret ref");
			return new SecretValue(parseSecretRef(ref), value);
		},
	};
}

export type RecordedRun = {
	readonly argv: readonly string[];
	readonly options: ProcessRunOptions;
};

export type StubRunner = ProcessRunner & {
	readonly runs: readonly RecordedRun[];
};

export function createStubRunner(
	result: ProcessResult = { code: 0, stdout: "", stderr: "" },
): StubRunner {
	const runs: RecordedRun[] = [];
	return {
		get runs() {
			return runs;
		},
		async run(argv, options) {
			runs.push({ argv: [...argv], options });
			return result;
		},
	};
}

export function fixedClock(startMs: number): () => number {
	return () => startMs;
}

export const FIXTURE_NOW_MS = Date.parse("2026-08-08T13:00:00.000Z");
export const FIXTURE_DATABASE_ID = "01999999-0000-7000-8000-000000000001";
