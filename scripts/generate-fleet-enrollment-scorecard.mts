#!/usr/bin/env node
/** Generates docs/design/fleet-enrollment-scorecard.md */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Status =
	| "pass"
	| "not-verified"
	| "blocked-on-credentials"
	| "not-implemented";
export type Row = {
	section: string;
	item: string;
	evidence: string;
	status: Status;
};

export const rows: Row[] = [];

function add(section: string, item: string, evidence: string, status: Status) {
	rows.push({ section, item, evidence, status });
}

const G9_CREDENTIALS =
	"Requires completed strict integrations and authorized staging: test GitHub App (App ID + Installation ID + PEM private key), test org/repos; staging transactional Postgres; stable HTTPS controller origin; Kubernetes/Station connection kubeconfig; operator Dagger engine; staging backup/restore access — see docs/design/fleet-enrollment-operator.md §G9";
const UNVERIFIED =
	"No requirement-specific verification result has been recorded; see docs/design/fleet-enrollment-design.md";

const sections = {
	"0": ["Continuous coordinated delivery directive acknowledged"],
	"1": [
		"Enroll trusted-local and isolated-container workers",
		"Join Kubernetes via Station/Yard Connections",
		"Multi-engine Offers without oversubscription",
		"Strict v2 at-most-once start authorization",
		"RunnerSlots separate from ExecutionClaims",
		"Official pre-job hook start fence",
		"Deterministic names + transactional outbox + fencing",
		"Preserve v1 policy/Offer/Lease semantics",
		"Dagger actor boundary preserved",
		"BuildKit/Jenkins boundary documented only",
	],
	"2.1": [
		"One CiDemand per job identity",
		"One ExecutionClaim per job identity",
		"At most one start_authorized transition",
		"Bijection runner slot ↔ claim when bound",
		"No automatic retry after ambiguity",
		"Manual rerun is new attempt",
		"Idempotent same-slot binding retry",
	],
	"2.2": ["External-assignment guarantee class"],
	"2.3": ["Residual limitations documented in operator guide"],
	"3": ["Existing HoBo contracts extended not replaced"],
	"4.1": ["Goals implemented in strict v2 modules"],
	"4.2": ["Non-goals not implemented"],
	"4.3": ["BuildKit/Jenkins adapter boundary only"],
	"5": ["Architecture ownership respected"],
	"6": ["User-facing semantics in operator doc + status contracts"],
	"7": ["Logical records in fleet_v2.proto + CUE"],
	"8": ["Transactional admission + effect delivery store"],
	"9": ["GitHub RunnerSlot + pre-job protocol"],
	"10": ["Kubernetes realization assets + tests"],
	"11": ["Dagger strict actor integration path"],
	"12": ["Security model controls"],
	"13": ["Recovery/restore/quarantine flows"],
	"14.1": ["@hobo/ci strict v2 implementation"],
	"14.2": ["@hobo/ci-gh-actions GitHub path"],
	"14.3": ["Worker enrollment shared protocol"],
	"14.4": ["Kubernetes adapter"],
	"14.5": ["@hobo/ci-dagger integration boundary"],
	"14.6": ["SDK/status/documentation extensions"],
	"15": ["Single-pass swarm plan artifacts"],
	"16.1": ["Contract + replay gates"],
	"17": ["Deployment/operational requirements"],
	"18": ["Production-readiness gates"],
	"20": ["Final handoff vertical slice"],
	"21": ["Primary references linked"],
} as const satisfies Record<string, readonly string[]>;

const notImplementedRows = new Map<string, string>([
	[
		"Strict v2 at-most-once start authorization",
		"Store, scoped GitHub lookup, and start handler exist, but the production controller does not connect them",
	],
	[
		"Official pre-job hook start fence",
		"Hook and optional start route exist, but the production controller does not install or configure them",
	],
	[
		"GitHub RunnerSlot + pre-job protocol",
		"The scoped lookup, hook, and optional start handler exist; live controller integration is not implemented",
	],
	[
		"Kubernetes realization assets + tests",
		"Pure planner functions + YAML assets only; no client execution path against a cluster",
	],
	[
		"Dagger strict actor integration path",
		"Boundary shapes only; no strict actor execution wired through Dagger",
	],
]);

for (const [section, items] of Object.entries(sections)) {
	for (const item of items) {
		const gap = notImplementedRows.get(item);
		const status: Status =
			gap !== undefined ? "not-implemented" : "not-verified";
		const evidence =
			gap ??
			(section === "20" && item === "Final handoff vertical slice"
				? G9_CREDENTIALS
				: UNVERIFIED);
		add(section, item, evidence, status);
	}
}

for (let i = 1; i <= 20; i++) {
	add(
		"19",
		`Guardrail ${i}`,
		"No guardrail-specific test or review evidence is recorded; see design section 19",
		"not-verified",
	);
}

const matrix162 = [
	"Two admissions race for one capacity unit",
	"Duplicate intake across webhook/pull/repair",
	"Two workers race for one effect",
	"Stale worker renews or acknowledges",
	"Worker observation sequence regresses",
	"Capacity sequence changes before commit",
	"Policy changes during admission",
	"Completion delivered twice",
];
const verified162 = new Map<string, string>([
	[
		"Two admissions race for one capacity unit",
		"allows exactly one admission to race for one capacity unit",
	],
	[
		"Duplicate intake across webhook/pull/repair",
		"deduplicates intake across webhook, pull, and repair",
	],
	[
		"Two workers race for one effect",
		"allows one active delivery and fence when workers race",
	],
	[
		"Stale worker renews or acknowledges",
		"rejects stale delivery tokens across generated lease histories",
	],
	[
		"Worker observation sequence regresses",
		"rejects observation sequence regression without state change",
	],
	[
		"Capacity sequence changes before commit",
		"rejects a stale revision even when capacity remains",
	],
	[
		"Completion delivered twice",
		"settles duplicate completion and releases capacity once",
	],
]);
for (const item of matrix162) {
	const testCase = verified162.get(item);
	if (testCase === undefined)
		add(
			"16.2",
			item,
			"A stale policy snapshot is tested, but a concurrent policy change during the transaction has no recorded result",
			"not-verified",
		);
	else
		add(
			"16.2",
			item,
			`SQLite and PostgreSQL case "${testCase}" in packages/ci/test/fleet-v2-store-conformance.test.ts, verified at 1fcfc3bdcc0701b69c5f22a91db0053b4f9fbded; this is scoped store evidence`,
			"pass",
		);
}

const matrix163 = [
	"Two slots same actual job",
	"Same slot idempotent retry",
	"Same slot two jobs rejected",
	"Forged job identity rejected",
	"Revoked slot rejected",
	"Assignment churn handled",
	"Incompatible profile rejected",
	"Controller unavailable fail-closed",
	"GitHub verification unavailable fail-closed",
	"Lost hook response idempotent",
	"Deterministic name adoption verified",
	"Foreign runner quarantine",
];
const notImplemented163 = new Map<string, string>([
	[
		"Assignment churn handled",
		"No live reassignment handling: the authorizer only confirms the assignment GitHub reports at hook time",
	],
	[
		"Controller unavailable fail-closed",
		"Hook template exits nonzero on curl failure, but the template is not installed by any controller",
	],
	[
		"Deterministic name adoption verified",
		"Deterministic names are generated; inspecting and adopting an already-registered runner is not implemented",
	],
	[
		"Foreign runner quarantine",
		"Foreign-runner detection/quarantine has no implementation",
	],
]);
for (const item of matrix163) {
	const gap = notImplemented163.get(item);
	add(
		"16.3",
		item,
		gap ??
			"Store or authorizer tests do not establish the unwired end-to-end GitHub start fence",
		gap === undefined ? "not-verified" : "not-implemented",
	);
}

for (let cut = 1; cut <= 15; cut++) {
	add(
		"16.6",
		`Crash cut ${cut}`,
		"No crash-cut-specific fault-injection evidence is recorded; see design section 16.6",
		"not-verified",
	);
}

const g9LiveEvidence = [
	"Trusted-local job on enrolled worker (private test repo)",
	"Isolated-required job on isolated worker",
	"Queued jobs with assignment churn; unique execution markers at most once",
	"Duplicate webhook deliveries without duplicate execution",
	"Controller kill before start: no steps; manual rerun succeeds at most once",
	"Worker kill after JIT: reconcile without second runner for same slot",
	"Worker revocation blocks subsequent starts",
	"Kubernetes strict runner-Pod job on real cluster",
	"Operator Dagger engine strict portable-pipeline path",
	"Staging backup/restore and rollback drills without duplicate execution",
];
for (const item of g9LiveEvidence) {
	add("18.9", `G9 live: ${item}`, G9_CREDENTIALS, "not-verified");
}

for (const gate of [
	"G0",
	"G1",
	"G2",
	"G3",
	"G4",
	"G5",
	"G6",
	"G7",
	"G8",
	"G9",
	"G10",
]) {
	const evidence = gate === "G9" ? G9_CREDENTIALS : UNVERIFIED;
	add("18", `${gate} production gate`, evidence, "not-verified");
}

const passCount = rows.filter((row) => row.status === "pass").length;
const blockedCount = rows.filter(
	(row) => row.status === "blocked-on-credentials",
).length;
const notImplementedCount = rows.filter(
	(row) => row.status === "not-implemented",
).length;
const notVerifiedCount = rows.filter(
	(row) => row.status === "not-verified",
).length;

const lines = [
	"---",
	"type: Verification scorecard",
	'title: "Fleet enrollment scorecard"',
	'description: "Evidence and open verification work for CI fleet enrollment."',
	"tags: [ci, fleet, verification]",
	"---",
	"",
	"# Fleet enrollment scorecard",
	"",
	"Ratings for [`fleet-enrollment-design.md`](./fleet-enrollment-design.md). A `pass` names scoped evidence and its verified commit; it does not establish current production readiness. Refresh it when covered behavior changes. `not-verified` means no requirement-specific result is recorded, and `not-implemented` identifies a known implementation gap. The CI evaluation checks the status vocabulary and prevents unsupported blanket passes.",
	"",
	"| Section | Requirement | Status | Evidence |",
	"| --- | --- | --- | --- |",
	...rows.map(
		(row) =>
			`| ${row.section} | ${row.item} | ${row.status} | ${row.evidence} |`,
	),
	"",
	`Total rows: ${rows.length}. Pass: ${passCount}. Not verified: ${notVerifiedCount}. Blocked on credentials (G9 live staging): ${blockedCount}. Not implemented: ${notImplementedCount}.`,
	"",
];

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const out = join(process.cwd(), "docs/design/fleet-enrollment-scorecard.md");
	writeFileSync(out, lines.join("\n"));
	console.log(
		`wrote ${out} (${rows.length} rows, ${passCount} pass, ${notVerifiedCount} not-verified, ${blockedCount} blocked-on-credentials, ${notImplementedCount} not-implemented)`,
	);
}
