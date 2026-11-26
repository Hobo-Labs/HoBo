// Impedance boundaries for the Convex provider path (ADR-0144 §5): hard
// vendor limits and paradigm facts encoded as typed constants so planners,
// reviewers, and the PortabilityReport (ADR-0024) see them at plan time
// instead of discovering them in production. Narrative form lives in
// docs/competitors/convex.md "Impedance boundaries for the provider path".

// public-contract: the impedance record schema id consumers pin.
export const CONVEX_IMPEDANCE_SCHEMA = "hobo.provider-impedance/v1";

/** Hard Convex runtime limits (public vendor documentation, 2026-08). */
export const CONVEX_LIMITS = Object.freeze({
	/** Max query/mutation execution time. */
	queryMutationMs: 1_000,
	/** Max document size in bytes (1 MiB). */
	documentBytes: 1_048_576,
	/** Max action execution time (10 minutes). */
	actionMs: 600_000,
	/** Writes per mutation transaction cap (documents touched). */
	transactionWriteCap: 8_192,
} as const);

// public-contract: the paradigm fact PortabilityReport consumers pin (Plan 25 vocabulary).
export const CONVEX_PARADIGM = "document";

/**
 * Paradigms a Resource Definition may request that this provider CANNOT
 * honestly satisfy — a request for one of these is a recorded paradigm
 * mismatch (PortabilityReport lock-in source), never a silent adaptation.
 */
export const CONVEX_PARADIGM_MISMATCHES = Object.freeze([
	"relational",
	"kv",
	"graph",
	"lake",
	"olap",
] as const);

export interface ImpedanceFinding {
	readonly code: string;
	readonly severity: "info" | "warn" | "block";
	readonly message: string;
}

/**
 * Plan-time impedance findings for a requested paradigm + feature set.
 * Pure and deterministic: safe on the Matching-adjacent path. Findings are
 * evidence for the PortabilityReport; only paradigm mismatches block.
 */
function isParadigmMismatch(value: string): boolean {
	switch (value) {
		case "relational":
		case "kv":
		case "graph":
		case "lake":
		case "olap":
			return true;
		default:
			return false;
	}
}

export function convexImpedanceFindings(input: {
	readonly paradigm?: string;
	readonly features?: readonly string[];
}): readonly ImpedanceFinding[] {
	const findings: ImpedanceFinding[] = [];
	if (input.paradigm !== undefined && isParadigmMismatch(input.paradigm)) {
		findings.push({
			code: "paradigm-mismatch",
			severity: "block",
			message: `requested paradigm "${input.paradigm}" cannot be satisfied by a ${CONVEX_PARADIGM} store; declare paradigm "${CONVEX_PARADIGM}" or match a different provider`,
		});
	}
	const features = input.features ?? [];
	if (features.includes("replay") || features.includes("time-travel")) {
		findings.push({
			code: "no-control-plane-time-travel",
			severity: "warn",
			message:
				"data and functions hosted inside Convex are outside HoBo's event-sourced replay/time-travel and cross-Yard Trails; only the provisioning lifecycle is event-sourced",
		});
	}
	if (features.includes("wit") || features.includes("polyglot")) {
		findings.push({
			code: "ts-js-runtime-only",
			severity: "warn",
			message:
				"Convex functions are TypeScript/JavaScript only; the WIT membrane does not extend into Convex-hosted code",
		});
	}
	findings.push({
		code: "occ-contention",
		severity: "info",
		message:
			"Convex mutations retry on optimistic-concurrency conflicts; HoBo actors serialize via leases/fencing — high-contention aggregates behave differently under load",
	});
	return Object.freeze(findings);
}
