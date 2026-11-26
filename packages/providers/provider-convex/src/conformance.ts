/**
 * The Convex hosting conformance profile: the list of things that must be
 * demonstrated before any Convex hosting form is allowed to carry a
 * `data.convex/v1` claim.
 *
 * It is a reusable data profile, not a runner. `evaluateConvexConformance`
 * folds submitted outcomes into a report and is deliberately fail-closed:
 * a check with no outcome, or an outcome of `unknown`, is not a pass.
 *
 * The checks encode facts verified against the official documentation on
 * 2026-08-08 — most importantly that a Convex backup contains table
 * documents and (optionally) file storage, and does NOT contain code,
 * configuration, environment variables, or pending scheduled functions.
 */

import {
	CONVEX_CONFORMANCE_SUITE_REF,
	type VerifiedSourceRef,
} from "./capability-profile.js";
import {
	CONVEX_HOSTING_FORM_IDS,
	type ConvexHostingFormId,
} from "./hosting-forms.js";

// public-contract: conformance profile record schema id.
export const CONFORMANCE_PROFILE_SCHEMA =
	"hobo.provider-conformance-profile/v1";
// public-contract: conformance report record schema id.
export const CONFORMANCE_REPORT_SCHEMA = "hobo.provider-conformance-report/v1";

export type ConformanceCheckResult = "pass" | "fail" | "unknown";

export type ConformanceCategory =
	| "runtime"
	| "durability"
	| "network"
	| "backup"
	| "continuity"
	| "claim"
	| "secrecy";

export interface ConvexConformanceCheck {
	readonly id: string;
	readonly title: string;
	readonly category: ConformanceCategory;
	/** Hosting forms this check is required for. */
	readonly appliesTo: readonly ConvexHostingFormId[];
	/** A blocking check failing means the claim cannot be made at all. */
	readonly blocking: boolean;
	readonly rationale: string;
}

const ALL_FORMS: readonly ConvexHostingFormId[] = CONVEX_HOSTING_FORM_IDS;
const SELF_HOSTED: readonly ConvexHostingFormId[] = [
	"convex.selfhosted-oci/v1",
];
const DURABLE_FORMS: readonly ConvexHostingFormId[] = [
	"convex.selfhosted-oci/v1",
	"convex.cloud-sponsored-transfer/v1",
];

export const CONVEX_CONFORMANCE_CHECKS: readonly ConvexConformanceCheck[] =
	Object.freeze([
		{
			id: "image-boots-on-supported-arch",
			title: "the pinned backend image boots on every architecture we claim",
			category: "runtime",
			appliesTo: SELF_HOSTED,
			blocking: true,
			rationale:
				"the multi-arch index carries linux/amd64 and linux/arm64; a claim on any other platform is unproven",
		},
		{
			id: "state-survives-recreation",
			title: "deployment state survives container recreation",
			category: "durability",
			appliesTo: SELF_HOSTED,
			blocking: true,
			rationale:
				"with the default SQLite engine everything lives under /convex/data; without a persistent volume recreation is data loss",
		},
		{
			id: "both-public-http-surfaces-route",
			title: "both public HTTP surfaces route",
			category: "network",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"the client/CLI API (:3210) and HTTP actions (:3211) are separate listeners; exposing one and assuming the other is a common self-host break",
		},
		{
			id: "tls-valid",
			title: "TLS is valid on every exposed surface",
			category: "network",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"browser clients and webhook senders both fail closed on an invalid certificate",
		},
		{
			id: "websocket-upgrade-reconnect-idle",
			title: "WebSocket upgrade, reconnect, and idle survival",
			category: "network",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"Convex reactivity is a long-lived WebSocket; proxies that drop idle connections or refuse upgrades break live queries without breaking HTTP",
		},
		{
			id: "documents-survive-redeploy",
			title: "documents survive a code redeploy",
			category: "durability",
			appliesTo: ALL_FORMS,
			blocking: true,
			rationale: "pushing functions must never be a data event",
		},
		{
			id: "file-storage-survives-redeploy-and-migration",
			title: "file storage survives redeploy and backend migration",
			category: "durability",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"stored files live beside documents on the volume or in the S3 files bucket; a migration that moves documents but not `_storage` silently loses user uploads",
		},
		{
			id: "modules-indexes-search-in-durable-storage",
			title: "modules, indexes, and search segments are in durable storage",
			category: "durability",
			appliesTo: SELF_HOSTED,
			blocking: true,
			rationale:
				"S3_STORAGE_MODULES_BUCKET and S3_STORAGE_SEARCH_BUCKET exist because these are separate storage roles; leaving them on ephemeral disk while documents are durable is a partial claim",
		},
		{
			id: "env-config-continuity-explicit",
			title:
				"environment variables and deployment config are carried explicitly",
			category: "continuity",
			appliesTo: ALL_FORMS,
			blocking: true,
			rationale:
				"backups do not contain environment variables or deployment configuration; anything not carried explicitly is lost",
		},
		{
			id: "backup-consistent",
			title: "the backup is a consistent point-in-time snapshot",
			category: "backup",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"a snapshot taken while the source still accepts writes is not a restorable baseline",
		},
		{
			id: "restore-into-different-backend",
			title: "the backup restores into a DIFFERENT backend",
			category: "backup",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"restoring in place proves nothing about portability; the strong claim depends on cross-backend restore actually working",
		},
		{
			id: "code-config-not-assumed-in-data-backup",
			title: "code and config are not assumed to be inside the data backup",
			category: "backup",
			appliesTo: ALL_FORMS,
			blocking: true,
			rationale:
				"documented explicitly upstream: a backup lacks deployment code and configuration (functions, crons.ts, auth.config.js, schema.ts), pending scheduled functions, and environment variables",
		},
		{
			id: "scheduled-work-explicitly-reconciled",
			title: "scheduled work is explicitly reconciled after a move",
			category: "continuity",
			appliesTo: ALL_FORMS,
			blocking: true,
			rationale:
				"pending scheduled functions are not in the backup; they must be enumerated from _scheduled_functions and re-established or consciously dropped",
		},
		{
			id: "connector-cutover-atomic-or-compensating",
			title: "connector cutover is atomic, or compensating",
			category: "claim",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"clients must not observe a window where half of them talk to the old backend and half to the new one; if atomicity is impossible the compensation must be defined and exercised",
		},
		{
			id: "historical-pre-claim-authority-fails-against-destination",
			title: "the pre-claim authority fails against the destination",
			category: "claim",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"an admin key is irrevocable, so exclusive ownership is only provable by showing the old key does not work on the new backend",
		},
		{
			id: "source-destruction-observable",
			title: "destruction of the temporary source is observable",
			category: "claim",
			appliesTo: DURABLE_FORMS,
			blocking: true,
			rationale:
				"'we deleted it' is not evidence; the destroyed backend and its authority must be independently unreachable",
		},
		{
			id: "no-admin-key-material-in-artifacts",
			title:
				"no admin key material in logs, events, plans, receipts, fixtures, or snapshots",
			category: "secrecy",
			appliesTo: ALL_FORMS,
			blocking: true,
			rationale:
				"an admin key cannot be rotated; one leak into a committed fixture or an event body permanently compromises that deployment",
		},
	] satisfies readonly ConvexConformanceCheck[]);

export const CONVEX_CONFORMANCE_CHECK_IDS: readonly string[] = Object.freeze(
	CONVEX_CONFORMANCE_CHECKS.map((check) => check.id),
);

export interface ConvexConformanceProfile {
	readonly schema: typeof CONFORMANCE_PROFILE_SCHEMA;
	readonly id: string;
	readonly checks: readonly ConvexConformanceCheck[];
	readonly sourceRefs: readonly VerifiedSourceRef[];
}

export const CONVEX_CONFORMANCE_PROFILE: ConvexConformanceProfile =
	Object.freeze({
		schema: CONFORMANCE_PROFILE_SCHEMA,
		id: CONVEX_CONFORMANCE_SUITE_REF,
		checks: CONVEX_CONFORMANCE_CHECKS,
		sourceRefs: Object.freeze([
			Object.freeze({
				url: "https://docs.convex.dev/database/backup-restore",
				checkedOn: "2026-08-08",
				note: "backup = table documents (+ optional file storage in `_storage`); explicitly excludes code/config, pending scheduled functions, and environment variables; cross-deployment restore is supported within a team and is destructive",
			}),
			Object.freeze({
				url: "https://docs.convex.dev/database/import-export/export",
				checkedOn: "2026-08-08",
				note: "`npx convex export --path` produces the same zip a dashboard backup does; streaming export goes through the Data Sync API",
			}),
			Object.freeze({
				url: "https://docs.convex.dev/cli/deploy-key-types",
				checkedOn: "2026-08-08",
				note: "an admin key is an irrevocable secret baked into the deployment; deploy keys are revocable via dashboard or `npx convex deployment token delete`",
			}),
		]),
	});

export interface ConformanceCheckOutcome {
	readonly checkId: string;
	readonly result: ConformanceCheckResult;
	/** Where the evidence lives (run folder, receipt, PR link). */
	readonly evidenceRef?: string;
	readonly note?: string;
}

export interface ConvexConformanceReport {
	readonly schema: typeof CONFORMANCE_REPORT_SCHEMA;
	readonly ok: boolean;
	readonly profileId: string;
	readonly hostingFormId: ConvexHostingFormId;
	readonly requiredCheckIds: readonly string[];
	readonly passedCheckIds: readonly string[];
	readonly failedCheckIds: readonly string[];
	readonly unknownCheckIds: readonly string[];
	readonly missingCheckIds: readonly string[];
	readonly unrecognizedCheckIds: readonly string[];
}

/** Checks required for a given hosting form. Pure. */
export function requiredChecksForHostingForm(
	hostingFormId: ConvexHostingFormId,
): readonly ConvexConformanceCheck[] {
	return CONVEX_CONFORMANCE_CHECKS.filter((check) =>
		check.appliesTo.includes(hostingFormId),
	);
}

/**
 * Fold outcomes into a report. Fail-closed: `ok` is true only when every
 * required check has an explicit `pass`. Missing and `unknown` both block.
 */
export function evaluateConvexConformance(input: {
	readonly hostingFormId: ConvexHostingFormId;
	readonly outcomes: readonly ConformanceCheckOutcome[];
}): ConvexConformanceReport {
	const required = requiredChecksForHostingForm(input.hostingFormId);
	const requiredIds = required.map((check) => check.id);
	const byId = new Map<string, ConformanceCheckResult>();
	const unrecognized: string[] = [];

	for (const outcome of input.outcomes) {
		if (!CONVEX_CONFORMANCE_CHECK_IDS.includes(outcome.checkId)) {
			unrecognized.push(outcome.checkId);
			continue;
		}
		const previous = byId.get(outcome.checkId);
		// Worst result wins: a single fail is never averaged away.
		byId.set(outcome.checkId, worstResult(previous, outcome.result));
	}

	const passed: string[] = [];
	const failed: string[] = [];
	const unknown: string[] = [];
	const missing: string[] = [];

	for (const id of requiredIds) {
		const result = byId.get(id);
		if (result === undefined) {
			missing.push(id);
			continue;
		}
		if (result === "pass") passed.push(id);
		else if (result === "fail") failed.push(id);
		else unknown.push(id);
	}

	return Object.freeze({
		schema: CONFORMANCE_REPORT_SCHEMA,
		ok:
			failed.length === 0 &&
			unknown.length === 0 &&
			missing.length === 0 &&
			unrecognized.length === 0,
		profileId: CONVEX_CONFORMANCE_PROFILE.id,
		hostingFormId: input.hostingFormId,
		requiredCheckIds: Object.freeze(requiredIds),
		passedCheckIds: Object.freeze(passed),
		failedCheckIds: Object.freeze(failed),
		unknownCheckIds: Object.freeze(unknown),
		missingCheckIds: Object.freeze(missing),
		unrecognizedCheckIds: Object.freeze(unrecognized),
	});
}

function worstResult(
	previous: ConformanceCheckResult | undefined,
	incoming: ConformanceCheckResult,
): ConformanceCheckResult {
	const rank = {
		fail: 0,
		unknown: 1,
		pass: 2,
	} satisfies Record<ConformanceCheckResult, number>;
	if (previous === undefined) return incoming;
	return rank[incoming] < rank[previous] ? incoming : previous;
}
