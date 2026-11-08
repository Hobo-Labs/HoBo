#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEFAULT_RELAY = "https://hobo-ci.vercel.app";
const DEFAULT_REPOSITORY = "Hobo-Labs/HoBo";

/** Timeout applied to each of GET /healthz and GET /readyz. */
export const RELAY_FETCH_TIMEOUT_MS = 15_000;

export type ProcessEnvLike = Record<string, string | undefined>;

export type RelayArgs = {
	relay: string;
	repository: string;
};

export type RelayProbe = {
	ok: boolean;
	status: number;
	bodyText: string;
};

export type Readiness = {
	ready: boolean;
	reasons: string[];
};

type FlagValue = {
	value: string;
	index: number;
};

const readyBodySchema = z.object({ ready: z.literal(true) });
export type ReadyBody = z.infer<typeof readyBodySchema>;

class RelayArgsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RelayArgsError";
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function readValue(
	argv: readonly string[],
	index: number,
	name: string,
): FlagValue {
	const arg = argv[index] ?? "";
	const prefix = `${name}=`;
	if (arg.startsWith(prefix)) {
		const value = arg.slice(prefix.length).trim();
		if (value === "") {
			throw new RelayArgsError(`Missing value for ${name}`);
		}
		return { value, index };
	}
	const next = argv[index + 1];
	if (next === undefined || next.startsWith("-")) {
		throw new RelayArgsError(`Missing value for ${name}`);
	}
	return { value: next, index: index + 1 };
}

function normalizeRelay(relay: string): string {
	let url: URL;
	try {
		url = new URL(relay.trim());
	} catch {
		throw new RelayArgsError(`Invalid --relay URL: ${relay}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new RelayArgsError(`Invalid --relay URL: ${relay}`);
	}
	return url.href.replace(/\/$/, "");
}

export function parseRelayArgs(
	argv: readonly string[],
	env: ProcessEnvLike,
): RelayArgs {
	let relay = nonEmpty(env.HOBO_CI_RELAY) ?? DEFAULT_RELAY;
	let repository = nonEmpty(env.HOBO_CI_REPOSITORY) ?? DEFAULT_REPOSITORY;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--") break;
		if (arg === "--relay" || arg.startsWith("--relay=")) {
			const parsed = readValue(argv, index, "--relay");
			relay = parsed.value;
			index = parsed.index;
			continue;
		}
		if (arg === "--repository" || arg.startsWith("--repository=")) {
			const parsed = readValue(argv, index, "--repository");
			repository = parsed.value;
			index = parsed.index;
			continue;
		}
		throw new RelayArgsError(`Unknown argument: ${arg}`);
	}

	const repositoryTrimmed = repository.trim();
	if (repositoryTrimmed === "") {
		throw new RelayArgsError("Missing value for --repository");
	}

	return {
		relay: normalizeRelay(relay),
		repository: repositoryTrimmed,
	};
}

export function parseReadyBody(bodyText: string): ReadyBody | null {
	if (bodyText.trim() === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return null;
	}
	const result = readyBodySchema.safeParse(parsed);
	return result.success ? result.data : null;
}

export function isReadyResponse(body: ReadyBody): boolean {
	return body.ready;
}

export function evaluateReadiness(
	health: RelayProbe,
	ready: RelayProbe,
): Readiness {
	const healthOk = health.ok === true;
	const readyOk = parseReadyBody(ready.bodyText) !== null;
	const reasons: string[] = [];
	if (!healthOk) {
		reasons.push(`healthz is not ok (HTTP ${health.status})`);
	}
	if (!readyOk) {
		reasons.push("readyz body.ready is not true");
	}
	return { ready: healthOk && readyOk, reasons };
}

export function printOperatorChecklist(repository: string): void {
	const steps = [
		"Configure sandbox credentials HOBO_CI_SANDBOX_* on the relay.",
		"Confirm worker health before dispatching a job.",
		"Set DATABASE_URL for the relay database.",
		"Register GitHub webhooks that target this relay.",
		`Run hobo ci enable for ${repository}.`,
	];
	for (let step = 0; step < steps.length; step += 1) {
		console.log(`${step + 1}. ${steps[step]}`);
	}
}

function endpoint(relay: string, path: "healthz" | "readyz"): string {
	const base = relay.endsWith("/") ? relay : `${relay}/`;
	return new URL(path, base).href;
}

async function fetchProbe(
	url: string,
	fetcher: typeof fetch,
): Promise<RelayProbe> {
	const response = await fetcher(url, {
		method: "GET",
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
	});
	return {
		ok: response.ok,
		status: response.status,
		bodyText: await response.text(),
	};
}

/**
 * CLI entry. Exit 0 when the relay is ready, 1 when it is unreachable or not
 * ready, and 2 when the arguments are invalid.
 * Repository is printed in the operator checklist only.
 */
export async function main(
	argv: readonly string[] = process.argv.slice(2),
	env: ProcessEnvLike = process.env,
	fetcher: typeof fetch = fetch,
): Promise<number> {
	let repository = DEFAULT_REPOSITORY;
	try {
		const args = parseRelayArgs(argv, env);
		repository = args.repository;
		const health = await fetchProbe(endpoint(args.relay, "healthz"), fetcher);
		const ready = await fetchProbe(endpoint(args.relay, "readyz"), fetcher);
		const evaluation = evaluateReadiness(health, ready);
		if (evaluation.ready) {
			console.log(`Relay ready: ${args.relay}`);
			return 0;
		}
		console.error(`Relay not ready: ${evaluation.reasons.join("; ")}`);
		printOperatorChecklist(repository);
		return 1;
	} catch (error) {
		if (error instanceof RelayArgsError) {
			console.error(error.message);
			return 2;
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Relay check failed: ${message}`);
		printOperatorChecklist(repository);
		return 1;
	}
}

function isDirectExecution(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
	void main().then(
		(code) => {
			process.exitCode = code;
		},
		(rejected) => {
			const message =
				rejected instanceof Error ? rejected.message : String(rejected);
			console.error(message);
			process.exitCode = 1;
		},
	);
}
