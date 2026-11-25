/**
 * Bounded readiness polling that distinguishes propagation from an answer.
 *
 * ADR-0159 §3: "auth-shaped responses fail fast; propagation-shaped 404/5xx
 * retry". A 401 is not a slow DNS record — it is the endpoint telling you your
 * request is wrong, and retrying it twenty times converts a one-line fix into
 * a two-minute timeout with a misleading message. So the status classifier is
 * explicit and closed: a small retry set, a small fail-fast set, and anything
 * else treated as an answer.
 *
 * Delay is exponential from `initialDelayMs`, doubling per attempt, capped at
 * `READINESS_MAX_DELAY_MS` so the default 20 attempts cannot become an
 * unbounded wait.
 */

import { TestHarnessError } from "./errors.js";

export interface ReadinessResponse {
	readonly status: number;
}

export type ReadinessProbe = (url: string) => Promise<ReadinessResponse>;

export interface UntilReadyOptions {
	readonly attempts?: number;
	readonly initialDelayMs?: number;
}

export const DEFAULT_READINESS_ATTEMPTS = 20;
export const DEFAULT_READINESS_INITIAL_DELAY_MS = 500;
export const READINESS_MAX_DELAY_MS = 5_000;

/** Deliberate rejections: an answer, not a propagation delay. */
export const READINESS_FAIL_FAST_STATUSES: readonly number[] = Object.freeze([
	400, 401, 403,
]);

/** Propagation-shaped: the resource may simply not be visible yet. */
export const READINESS_RETRY_STATUSES: readonly number[] = Object.freeze([
	404, 408, 425, 429,
]);

export type ReadinessDecision = "ready" | "retry" | "reject";

export function classifyReadinessStatus(status: number): ReadinessDecision {
	if (READINESS_FAIL_FAST_STATUSES.includes(status)) return "reject";
	if (READINESS_RETRY_STATUSES.includes(status)) return "retry";
	if (status >= 500) return "retry";
	if (status >= 400) return "reject";
	return "ready";
}

async function defaultSleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

export interface UntilReadyRunOptions extends UntilReadyOptions {
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `url` through `probe` until it answers ready, answers deliberately, or
 * the attempt budget is exhausted. Network throws count as propagation.
 */
export async function untilReadyWith(
	probe: ReadinessProbe,
	url: string,
	options: UntilReadyRunOptions = {},
): Promise<ReadinessResponse> {
	const attempts = options.attempts ?? DEFAULT_READINESS_ATTEMPTS;
	const initialDelayMs =
		options.initialDelayMs ?? DEFAULT_READINESS_INITIAL_DELAY_MS;
	if (!Number.isInteger(attempts) || attempts < 1) {
		throw new TestHarnessError(
			"HARNESS_READINESS_OPTIONS_INVALID",
			`untilReady attempts must be an integer >= 1, received ${String(attempts)}`,
			"pass a positive integer for `attempts`, or omit it to take the default of 20",
		);
	}
	if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
		throw new TestHarnessError(
			"HARNESS_READINESS_OPTIONS_INVALID",
			`untilReady initialDelayMs must be a non-negative number, received ${String(initialDelayMs)}`,
			"pass a non-negative `initialDelayMs`, or omit it to take the default of 500",
		);
	}
	const sleep = options.sleep ?? defaultSleep;

	let lastStatus: number | undefined;
	let lastError: string | undefined;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		let response: ReadinessResponse | undefined;
		try {
			response = await probe(url);
		} catch (cause) {
			lastError = cause instanceof Error ? cause.message : String(cause);
		}

		if (response !== undefined) {
			const decision = classifyReadinessStatus(response.status);
			if (decision === "ready") return response;
			if (decision === "reject") {
				throw new TestHarnessError(
					"HARNESS_READINESS_REJECTED",
					`${url} answered ${response.status}; a deliberate rejection is an answer, not a propagation delay`,
					"fix the request (credentials, path, or method) — retrying a 400/401/403 cannot make it succeed",
				);
			}
			lastStatus = response.status;
			lastError = undefined;
		}

		if (attempt + 1 < attempts) {
			await sleep(
				Math.min(initialDelayMs * 2 ** attempt, READINESS_MAX_DELAY_MS),
			);
		}
	}

	const observed =
		lastError !== undefined
			? `network failure: ${lastError}`
			: `last status ${String(lastStatus)}`;
	throw new TestHarnessError(
		"HARNESS_READINESS_EXHAUSTED",
		`${url} never became ready within ${attempts} attempts (${observed})`,
		"raise `attempts`/`initialDelayMs`, or check the resource actually deployed — the in-process lane only opens listeners for HTTP-shaped resources with a resolved entrypoint",
	);
}

/** Default probe: the platform `fetch`, status only, body discarded. */
export function createFetchReadinessProbe(
	fetchImpl?: typeof globalThis.fetch,
): ReadinessProbe {
	return async (url: string): Promise<ReadinessResponse> => {
		const impl = fetchImpl ?? globalThis.fetch;
		if (typeof impl !== "function") {
			throw new Error("no global fetch available for readiness probing");
		}
		const response = await impl(url, { method: "GET" });
		return { status: response.status };
	};
}
