export const CONVEX_IMPEDANCE_SCHEMA = "hobo.provider-impedance/v1";

export const CONVEX_LIMITS = Object.freeze({
	queryMutationMs: 1_000,
	documentBytes: 1_048_576,
	actionMs: 600_000,
	transactionWriteCap: 8_192,
} as const);

export const CONVEX_PARADIGM = "document";

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
