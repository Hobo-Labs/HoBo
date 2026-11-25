/**
 * The chaos lane: deterministic fault injection for the deployment path.
 *
 * Why this exists. The resolver plane's central claim is convergence — every
 * `reconcile()` is read-or-create, so running it twice yields one resource and
 * the same `physicalId`. That claim is easy to satisfy on the happy path and
 * easy to break on the unhappy one: a network error *after* a provider has
 * created a resource but *before* the driver observed it is exactly the case
 * where a naive driver creates a second resource on retry. Unit tests with a
 * cooperative transport never reach that state.
 *
 * `@hobo/sdk`'s `chaos()` is an authoring factory for chaos *declarations* — a
 * record describing an experiment. It injects nothing. This module is the
 * missing other half: a transport that actually fails, and a suite that asserts
 * the invariants survive it.
 *
 * Determinism is the design constraint, not a nicety. Faults fire at a chosen
 * call *index*, never at random, so a failure names one reproducible scenario
 * instead of a flake. A chaos lane that fails randomly gets retried until green
 * and then deleted, which is worse than not having one.
 */
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";

// public-contract: the closed set of faults the chaos lane can inject; each names a real failure mode a provider API exhibits.
export const CHAOS_FAULTS = Object.freeze([
	/** The socket dies. The provider may or may not have applied the write. */
	"network-error",
	/** The request exceeds its deadline. Same ambiguity as network-error. */
	"timeout",
	/** A 5xx with a body. The write's fate is unknown to the caller. */
	"server-error",
	/** A 429. Retryable, but only if the caller is convergent. */
	"rate-limited",
	/** A 200 whose body is cut short — the worst case, since it looks like success. */
	"truncated-body",
	/** A 200 whose body is not the JSON the driver expects. */
	"malformed-body",
] as const);

export type ChaosFault = (typeof CHAOS_FAULTS)[number];

/** One scheduled fault: the zero-based call index it fires on. */
export interface ChaosInjection {
	readonly at: number;
	readonly fault: ChaosFault;
}

export interface ChaosTransport {
	readonly transport: HttpTransport;
	/** Every request the driver issued, in order, including faulted ones. */
	readonly calls: readonly TransportRequest[];
	/** Faults actually fired. Fewer than scheduled means the driver stopped early. */
	readonly fired: readonly ChaosInjection[];
}

export class ChaosPlanError extends Error {
	readonly code = "CHAOS_PLAN_INVALID";
	readonly remediation: string;
	constructor(message: string, remediation: string) {
		super(message);
		this.name = "ChaosPlanError";
		this.remediation = remediation;
	}
}

function parseInjections(
	injections: readonly ChaosInjection[],
): readonly ChaosInjection[] {
	if (!Array.isArray(injections)) {
		throw new ChaosPlanError(
			"chaos injections must be an array",
			"pass an array of { at, fault } records, or [] for a fault-free run",
		);
	}
	const seen = new Set<number>();
	for (const injection of injections) {
		if (!Number.isInteger(injection?.at) || injection.at < 0) {
			throw new ChaosPlanError(
				`chaos injection index ${String(injection?.at)} is not a non-negative integer`,
				"index faults by zero-based call number so the scenario is reproducible",
			);
		}
		if (!CHAOS_FAULTS.includes(injection.fault)) {
			throw new ChaosPlanError(
				`unknown chaos fault ${JSON.stringify(injection?.fault)}`,
				`use one of: ${CHAOS_FAULTS.join(", ")}`,
			);
		}
		if (seen.has(injection.at)) {
			// Two faults on one call would make the scenario ambiguous, and an
			// ambiguous scenario cannot be reported as a reproducible failure.
			throw new ChaosPlanError(
				`two chaos faults are scheduled for call ${injection.at}`,
				"schedule at most one fault per call index",
			);
		}
		seen.add(injection.at);
	}
	return Object.freeze([...injections].sort((a, b) => a.at - b.at));
}

/**
 * Wrap a transport so scheduled calls fail instead of reaching the inner one.
 *
 * A faulted call never reaches `inner`, so a "network-error" genuinely models
 * the provider never seeing the request. To model the harder case — the
 * provider *did* apply the write but the caller never learned it — schedule the
 * fault on a call the inner transport has already been allowed to service by
 * putting the fault on a *later* index; `calls` records the ordering so a test
 * can assert which side of the write the fault landed on.
 */
export function chaosTransport(
	inner: HttpTransport,
	injections: readonly ChaosInjection[] = [],
): ChaosTransport {
	const plan = parseInjections(injections);
	const byIndex = new Map(plan.map((i) => [i.at, i.fault]));
	const calls: TransportRequest[] = [];
	const fired: ChaosInjection[] = [];

	const transport: HttpTransport = async (request) => {
		const index = calls.length;
		calls.push(request);
		const fault = byIndex.get(index);
		if (fault === undefined) return inner(request);
		fired.push({ at: index, fault });
		return applyFault(fault, request, inner);
	};

	return {
		transport,
		get calls() {
			return Object.freeze([...calls]);
		},
		get fired() {
			return Object.freeze([...fired]);
		},
	};
}

async function applyFault(
	fault: ChaosFault,
	request: TransportRequest,
	inner: HttpTransport,
): Promise<TransportResponse> {
	switch (fault) {
		case "network-error":
			throw new Error("chaos: connection reset by peer");
		case "timeout":
			// Surfaced as an error rather than a hang: a test that hangs is a
			// test nobody runs. The driver sees what an aborted request looks
			// like, which is the behaviour under test.
			throw new Error(
				`chaos: request exceeded ${request.timeoutMs}ms deadline`,
			);
		case "server-error":
			return {
				status: 500,
				headers: { "content-type": "application/json" },
				body: '{"error":"chaos: internal server error"}',
			};
		case "rate-limited":
			return {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "1" },
				body: '{"error":"chaos: rate limited"}',
			};
		case "truncated-body": {
			// Let the real call happen, then cut the body. This is the nastiest
			// fault available: status 200, so a driver that trusts the status
			// line and not the payload reports success on a half-read response.
			const real = await inner(request);
			return {
				...real,
				body: real.body.slice(0, Math.max(0, Math.floor(real.body.length / 2))),
			};
		}
		case "malformed-body": {
			const real = await inner(request);
			return { ...real, body: "chaos: not json" };
		}
	}
}
