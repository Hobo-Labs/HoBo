/**
 * Migration conformance — can the data actually leave?
 *
 * "Supports export" is the single most over-claimed field in any provider
 * catalog. An export endpoint that emits bytes nobody can verify, an import
 * that is only ever tested against the machine it came from, and a cutover
 * that fires before verification are all ways to have an export button and no
 * exit. The fourth case is the one operators care about at 3am: when the import
 * fails, is the source still there?
 */

import type { MigrationState } from "@hobo/claims";
import { DIGEST_PATTERN } from "@hobo/trust";
import type { JsonValue } from "../../json.js";

import {
	type AnonymousSuiteDefinition,
	type CaseJudgement,
	optionalBoolean,
	optionalMember,
	optionalText,
	requireRecord,
	requireText,
} from "./harness.js";
import { type AnonymousCase, AnonymousConformanceError } from "./types.js";

// public-contract: stable suite identifier used in evidence and reports.
export const MIGRATION_SUITE_ID = "hobo.anonymous.migration/v1";

export const MIGRATION_CHECKS = {
	exportIntegrityDigest: "migration.export-integrity-digest",
	importVerifiedAtDistinctDestination:
		"migration.import-verified-at-distinct-destination",
	cutoverAfterVerification: "migration.cutover-after-verification",
	sourceSurvivesFailedImport: "migration.source-survives-failed-import",
} as const;

export type MigrationCheck =
	(typeof MIGRATION_CHECKS)[keyof typeof MIGRATION_CHECKS];

export const MIGRATION_STEPS = [
	"export",
	"import",
	"cutover",
	"failed-import",
] as const;

export type MigrationStep = (typeof MIGRATION_STEPS)[number];

const MIGRATION_STATES: readonly MigrationState[] = [
	"MigrationRequired",
	"DestinationProvisioning",
	"SourceQuiescing",
	"Exporting",
	"Importing",
	"Verifying",
	"CutoverReady",
	"CutoverCommitted",
	"SourceRetiring",
	"OwnerControlled",
];

export interface MigrationStepRequest {
	readonly caseId: string;
	readonly step: MigrationStep;
	readonly sourceRef: string;
	readonly destinationRef: string;
}

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface MigrationStepOutcome {
	readonly caseId: string;
	readonly sourceRef: string;
	readonly exportDigest?: string;
	readonly importedDigest?: string;
	readonly destinationRef?: string;
	readonly verified?: boolean;
	readonly cutoverCommitted?: boolean;
	readonly sourceIntact?: boolean;
	readonly state?: MigrationState;
}

export type MigrationExpectation =
	| { readonly kind: "export-produces-integrity-digest" }
	| { readonly kind: "import-verifies-at-distinct-destination" }
	| { readonly kind: "cutover-requires-verification" }
	| { readonly kind: "cutover-blocked-without-verification" }
	| { readonly kind: "source-survives-failed-import" };

export type MigrationCase = AnonymousCase<
	MigrationStepRequest,
	MigrationExpectation
>;

const SOURCE_REF = "resource:conformance/claimable-1";
const DESTINATION_REF = "resource:conformance/destination-1";

export const MIGRATION_CASES: readonly MigrationCase[] = Object.freeze([
	{
		id: "migration/export-produces-integrity-digest",
		check: MIGRATION_CHECKS.exportIntegrityDigest,
		title: "export emits a content digest the destination can check against",
		request: {
			caseId: "migration/export-produces-integrity-digest",
			step: "export",
			sourceRef: SOURCE_REF,
			destinationRef: DESTINATION_REF,
		},
		expect: { kind: "export-produces-integrity-digest" },
	},
	{
		id: "migration/import-verifies-at-a-different-destination",
		check: MIGRATION_CHECKS.importVerifiedAtDistinctDestination,
		title:
			"the export imports and verifies into a genuinely different resource",
		request: {
			caseId: "migration/import-verifies-at-a-different-destination",
			step: "import",
			sourceRef: SOURCE_REF,
			destinationRef: DESTINATION_REF,
		},
		expect: { kind: "import-verifies-at-distinct-destination" },
	},
	{
		id: "migration/cutover-follows-verification",
		check: MIGRATION_CHECKS.cutoverAfterVerification,
		title: "cutover commits only once the destination has been verified",
		request: {
			caseId: "migration/cutover-follows-verification",
			step: "cutover",
			sourceRef: SOURCE_REF,
			destinationRef: DESTINATION_REF,
		},
		expect: { kind: "cutover-requires-verification" },
	},
	{
		id: "migration/cutover-blocked-without-verification",
		check: MIGRATION_CHECKS.cutoverAfterVerification,
		title: "an unverified destination cannot be cut over to",
		request: {
			caseId: "migration/cutover-blocked-without-verification",
			step: "failed-import",
			sourceRef: SOURCE_REF,
			destinationRef: DESTINATION_REF,
		},
		expect: { kind: "cutover-blocked-without-verification" },
	},
	{
		id: "migration/source-survives-a-failed-import",
		check: MIGRATION_CHECKS.sourceSurvivesFailedImport,
		title: "a failed import leaves the source resource intact and usable",
		request: {
			caseId: "migration/source-survives-a-failed-import",
			step: "failed-import",
			sourceRef: SOURCE_REF,
			destinationRef: DESTINATION_REF,
		},
		expect: { kind: "source-survives-failed-import" },
	},
]);

export function parseMigrationStepOutcome(
	raw: JsonValue,
	caseId: string,
): MigrationStepOutcome {
	const record = requireRecord(raw, caseId, "migration outcome");
	const reportedCaseId = requireText(record.caseId, caseId, "caseId");
	if (reportedCaseId !== caseId) {
		throw new AnonymousConformanceError(
			caseId,
			`outcome reports caseId ${JSON.stringify(reportedCaseId)}`,
		);
	}

	const exportDigest = optionalText(
		record.exportDigest,
		caseId,
		"exportDigest",
	);
	const importedDigest = optionalText(
		record.importedDigest,
		caseId,
		"importedDigest",
	);
	const destinationRef = optionalText(
		record.destinationRef,
		caseId,
		"destinationRef",
	);
	const verified = optionalBoolean(record.verified, caseId, "verified");
	const cutoverCommitted = optionalBoolean(
		record.cutoverCommitted,
		caseId,
		"cutoverCommitted",
	);
	const sourceIntact = optionalBoolean(
		record.sourceIntact,
		caseId,
		"sourceIntact",
	);
	const state = optionalMember(record.state, caseId, "state", MIGRATION_STATES);

	return {
		caseId,
		sourceRef: requireText(record.sourceRef, caseId, "sourceRef"),
		...(exportDigest !== undefined ? { exportDigest } : undefined),
		...(importedDigest !== undefined ? { importedDigest } : undefined),
		...(destinationRef !== undefined ? { destinationRef } : undefined),
		...(verified !== undefined ? { verified } : undefined),
		...(cutoverCommitted !== undefined ? { cutoverCommitted } : undefined),
		...(sourceIntact !== undefined ? { sourceIntact } : undefined),
		...(state !== undefined ? { state } : undefined),
	};
}

function judgeMigrationCase(
	suiteCase: MigrationCase,
	outcome: MigrationStepOutcome,
): CaseJudgement {
	switch (suiteCase.expect.kind) {
		case "export-produces-integrity-digest":
			return judgeExportDigest(outcome);
		case "import-verifies-at-distinct-destination":
			return judgeImport(suiteCase, outcome);
		case "cutover-requires-verification":
			return judgeCutover(outcome);
		case "cutover-blocked-without-verification":
			return judgeCutoverBlocked(outcome);
		case "source-survives-failed-import":
			return judgeSourceSurvival(suiteCase, outcome);
	}
}

function judgeExportDigest(outcome: MigrationStepOutcome): CaseJudgement {
	if (outcome.exportDigest === undefined) {
		return {
			outcome: "fail",
			detail:
				"export produced no integrity digest, so an import cannot be checked",
		};
	}
	if (!DIGEST_PATTERN.test(outcome.exportDigest)) {
		return {
			outcome: "fail",
			detail: `export digest ${JSON.stringify(outcome.exportDigest)} is not a lowercase sha256:<hex> digest`,
		};
	}
	return {
		outcome: "pass",
		detail: `export produced integrity digest ${outcome.exportDigest}`,
	};
}

function judgeImport(
	suiteCase: MigrationCase,
	outcome: MigrationStepOutcome,
): CaseJudgement {
	if (
		outcome.exportDigest === undefined ||
		outcome.importedDigest === undefined
	) {
		return {
			outcome: "fail",
			detail:
				"the import step did not report both the export and imported digests",
		};
	}
	if (outcome.destinationRef === undefined) {
		return {
			outcome: "fail",
			detail: "the import named no destination resource",
		};
	}
	if (outcome.destinationRef === outcome.sourceRef) {
		return {
			outcome: "fail",
			detail:
				"the import verified against the source itself; that proves nothing about portability",
		};
	}
	if (outcome.destinationRef !== suiteCase.request.destinationRef) {
		return {
			outcome: "fail",
			detail: `import landed in ${outcome.destinationRef}, not the requested ${suiteCase.request.destinationRef}`,
		};
	}
	if (outcome.importedDigest !== outcome.exportDigest) {
		return {
			outcome: "fail",
			detail: `imported digest ${outcome.importedDigest} does not match exported ${outcome.exportDigest}`,
		};
	}
	if (outcome.verified !== true) {
		return {
			outcome: "fail",
			detail: "the destination was never verified after import",
		};
	}
	return {
		outcome: "pass",
		detail: `import verified at ${outcome.destinationRef} against ${outcome.exportDigest}`,
	};
}

function judgeCutover(outcome: MigrationStepOutcome): CaseJudgement {
	if (outcome.verified !== true) {
		return {
			outcome: "fail",
			detail:
				"the cutover case ran without a verified destination to cut over to",
		};
	}
	if (outcome.cutoverCommitted !== true) {
		return {
			outcome: "fail",
			detail: "the destination verified but cutover never committed",
		};
	}
	if (outcome.state !== undefined && outcome.state !== "CutoverCommitted") {
		return {
			outcome: "fail",
			detail: `cutover reported committed but the migration state is ${outcome.state}`,
		};
	}
	return {
		outcome: "pass",
		detail: "cutover committed only after destination verification",
	};
}

function judgeCutoverBlocked(outcome: MigrationStepOutcome): CaseJudgement {
	if (outcome.verified === true) {
		return {
			outcome: "fail",
			detail:
				"the failed-import case reported a verified destination, so nothing was blocked",
		};
	}
	if (outcome.cutoverCommitted === true) {
		return {
			outcome: "fail",
			detail: "cutover committed against an unverified destination",
		};
	}
	return {
		outcome: "pass",
		detail: "an unverified destination did not receive a cutover",
	};
}

function judgeSourceSurvival(
	suiteCase: MigrationCase,
	outcome: MigrationStepOutcome,
): CaseJudgement {
	if (outcome.verified === true) {
		return {
			outcome: "fail",
			detail: "the import was supposed to fail but reported verification",
		};
	}
	if (outcome.sourceRef !== suiteCase.request.sourceRef) {
		return {
			outcome: "fail",
			detail: `the outcome describes ${outcome.sourceRef}, not the source under test`,
		};
	}
	if (outcome.sourceIntact !== true) {
		return {
			outcome: "fail",
			detail: "a failed import left the source resource damaged or gone",
		};
	}
	if (outcome.cutoverCommitted === true) {
		return {
			outcome: "fail",
			detail: "cutover committed despite the import failing",
		};
	}
	return {
		outcome: "pass",
		detail: `${outcome.sourceRef} survived a failed import with no cutover`,
	};
}

export const MIGRATION_CONFORMANCE_SUITE: AnonymousSuiteDefinition<
	MigrationStepRequest,
	MigrationExpectation,
	MigrationStepOutcome
> = Object.freeze({
	suiteId: MIGRATION_SUITE_ID,
	dimension: "migration",
	checks: Object.freeze(Object.values(MIGRATION_CHECKS)),
	cases: MIGRATION_CASES,
	parse: parseMigrationStepOutcome,
	judge: judgeMigrationCase,
});
