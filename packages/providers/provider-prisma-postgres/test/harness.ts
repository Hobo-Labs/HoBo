import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSecretRef, type SecretRef, SecretValue } from "@hobo/bindings";

import type {
	ProcessResult,
	ProcessRunner,
	ProcessRunOptions,
} from "../src/cli.js";
import type {
	SecretCustodyPort,
	SecretCustodyScope,
	SecretResolverPort,
} from "../src/custody.js";

export function fixture(name: string): string {
	return readFileSync(
		fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
		"utf8",
	);
}

export type RecordedRun = {
	readonly argv: readonly string[];
	readonly options: ProcessRunOptions;
};

export type StubRunner = ProcessRunner & {
	readonly runs: readonly RecordedRun[];
};

export type StubRunStep = ProcessResult | { readonly throws: Error };

export function createStubRunner(steps: readonly StubRunStep[]): StubRunner {
	const runs: RecordedRun[] = [];
	const queue = [...steps];
	return {
		get runs() {
			return runs;
		},
		async run(argv, options) {
			runs.push({ argv: [...argv], options });
			const next = queue.shift();
			if (next === undefined) {
				throw new Error(`stub runner ran out of steps at ${argv.join(" ")}`);
			}
			if ("throws" in next) throw next.throws;
			return next;
		},
	};
}

export function stdout(text: string): ProcessResult {
	return { code: 0, stdout: text, stderr: "" };
}

export type StubCustody = SecretCustodyPort &
	SecretResolverPort & {
		readonly deposits: readonly {
			readonly ref: string;
			readonly scope: SecretCustodyScope;
		}[];
	};

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

export function fixedClock(startMs: number): () => number {
	return () => startMs;
}

export const FIXTURE_NOW_MS = Date.parse("2026-08-08T13:00:00.000Z");
export const FIXTURE_PROJECT_ID = "proj_fake000000000000";
