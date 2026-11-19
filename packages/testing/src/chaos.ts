import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";

// public-contract: the closed set of faults the chaos lane can inject; each names a real failure mode a provider API exhibits.
export const CHAOS_FAULTS = Object.freeze([
	"network-error",
	"timeout",
	"server-error",
	"rate-limited",
	"truncated-body",
	"malformed-body",
] as const);

export type ChaosFault = (typeof CHAOS_FAULTS)[number];

export interface ChaosInjection {
	readonly at: number;
	readonly fault: ChaosFault;
}

export interface ChaosTransport {
	readonly transport: HttpTransport;
	readonly calls: readonly TransportRequest[];
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
			throw new ChaosPlanError(
				`two chaos faults are scheduled for call ${injection.at}`,
				"schedule at most one fault per call index",
			);
		}
		seen.add(injection.at);
	}
	return Object.freeze([...injections].sort((a, b) => a.at - b.at));
}

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
