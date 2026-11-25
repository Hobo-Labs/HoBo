// Promoted from src/draft/technical-proofs/evals-training-promotion-gates-poc
// (src/lint/use-training-lint.ts), inverted for the bare-marker form
// (ADR-0125): a "use training" method MAY carry explicit intent + contract +
// rubric groundings; when it does not, the bindings are inferred and
// generated (training.infer / hobo stub), so the lint reports them as
// inferred `info` findings instead of errors.

import { isJsonString } from "../json.js";

const REQUIRED_GROUNDINGS = ["intent", "contract", "rubric"] as const;

export interface UseTrainingLintFinding {
	readonly kind: (typeof REQUIRED_GROUNDINGS)[number];
	readonly message: string;
	readonly severity: "error" | "info";
}

export interface UseTrainingLintResult {
	readonly ok: boolean;
	readonly findings: readonly UseTrainingLintFinding[];
	/** True when groundings will be inferred/generated rather than declared. */
	readonly inferred?: boolean;
	readonly required?: readonly string[];
}

export function lintUseTrainingSource(source: string): UseTrainingLintResult {
	if (!isJsonString(source) || source.length === 0) {
		throw new TypeError("source must be a non-empty string");
	}

	if (
		!source.includes('"use training"') &&
		!source.includes("'use training'")
	) {
		return { ok: true, findings: [] };
	}

	const findings: UseTrainingLintFinding[] = [];
	const hasIntent = /@intent\b/.test(source) || /\bintent\s*:/.test(source);
	const hasContract =
		/\bcontract\s*:/.test(source) ||
		/\bContract\b/.test(source) ||
		/contractRef/.test(source);
	const hasRubric = /\brubric\s*:/.test(source) || /rubricRef/.test(source);

	if (!hasIntent) {
		findings.push(
			finding("intent", "intent not declared — will be inferred/generated"),
		);
	}
	if (!hasContract) {
		findings.push(
			finding(
				"contract",
				"contract not declared — an inferred:// contract ref will be generated",
			),
		);
	}
	if (!hasRubric) {
		findings.push(
			finding(
				"rubric",
				"rubric not declared — a default exact-match rubric will be inferred",
			),
		);
	}

	return {
		ok: true,
		findings,
		inferred: findings.length > 0,
		required: [...REQUIRED_GROUNDINGS],
	};
}

function finding(
	kind: UseTrainingLintFinding["kind"],
	message: string,
): UseTrainingLintFinding {
	return { kind, message, severity: "info" };
}
