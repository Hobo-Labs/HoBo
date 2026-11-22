import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertTlcExited,
	runBoundedTlc,
} from "../../../../scripts/lib/bounded-tlc.ts";

const configuredJar = process.env.HOBO_TLA_TOOLS;
if (!configuredJar) throw new Error("Set HOBO_TLA_TOOLS to tla2tools 1.7.4");
const jar = resolve(configuredJar);
const expected =
	"936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
if (createHash("sha256").update(readFileSync(jar)).digest("hex") !== expected)
	throw new Error("TLA+ tool digest does not match the pinned release");
const model = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(model, "RivetHttpKv.tla"), "utf8");
const config = readFileSync(join(model, "RivetHttpKv.cfg"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hobo-http-kv-model-"));

function replaceOnce(text: string, before: string, after: string): string {
	if (text.split(before).length !== 2)
		throw new Error("HTTP/KV model mutation target changed");
	return text.replace(before, after);
}

function check(
	label: string,
	modelSource: string,
	modelConfig: string,
	expectedViolation?: string,
): void {
	const path = join(scratch, label);
	writeFileSync(`${path}.tla`, modelSource.replaceAll("RivetHttpKv", label));
	writeFileSync(`${path}.cfg`, modelConfig);
	const result = runBoundedTlc(
		jar,
		[
			"-workers",
			"1",
			"-metadir",
			`${path}-states`,
			"-config",
			`${path}.cfg`,
			`${path}.tla`,
		],
		scratch,
	);
	assertTlcExited(result);
	const output = `${result.stdout}\n${result.stderr}`;
	if (expectedViolation === undefined) {
		if (result.status !== 0 || !output.includes("No error has been found"))
			throw new Error(`${label} failed:\n${output}`);
		const count = output.match(
			/\d+ states generated, \d+ distinct states found/u,
		);
		process.stdout.write(`${label}: ${count?.[0] ?? "checked"}\n`);
		return;
	}
	if (
		result.status === 0 ||
		!output.includes(`Invariant ${expectedViolation} is violated`)
	)
		throw new Error(
			`${label} did not violate ${expectedViolation}:\n${output}`,
		);
	process.stdout.write(`${label}: ${expectedViolation} counterexample found\n`);
}

try {
	check("HttpKv", source, config);
	check(
		"PreAuthorizationWithoutStart",
		replaceOnce(
			source,
			'PreAuthorize ==\n  /\\ phase = "idle" /\\ preDecision = "pending" /\\ httpAuthorityPending',
			'PreAuthorize ==\n  /\\ phase = "idle"',
		),
		config,
		"PreAuthorizationRequiresStarted",
	);
	check(
		"PreAuthorizationWithoutApproval",
		replaceOnce(
			source,
			'preDecision\' = IF ~scope THEN "unavailable" ELSE IF ~principal THEN "denied" ELSE "allowed"',
			'preDecision\' = IF ~scope THEN "unavailable" ELSE IF ~principal THEN "denied" ELSE "denied"',
		),
		config,
		"PreAuthorizationRequiresStarted",
	);
	check(
		"PreApprovalWithoutCompletion",
		replaceOnce(
			source,
			"preauthorized' = (scope /\\ principal) /\\ httpAuthorityPending' = FALSE",
			"preauthorized' = (scope /\\ principal) /\\ httpAuthorityPending' = TRUE",
		),
		config,
		"PreAuthorizationRequiresStarted",
	);
	check(
		"PostAuthorizationWithoutStart",
		replaceOnce(
			source,
			'PostAuthorize ==\n  /\\ phase = "result" /\\ postDecision = "pending" /\\ httpAuthorityPending',
			'PostAuthorize ==\n  /\\ phase = "result"',
		),
		config,
		"PostApprovalRequiresCompleted",
	);
	check(
		"PostApprovalWithoutCompletion",
		replaceOnce(
			source,
			"postDecision' = \"allowed\" /\\ httpAuthorityPending' = FALSE",
			"postDecision' = \"allowed\" /\\ httpAuthorityPending' = TRUE",
		),
		config,
		"PostApprovalRequiresCompleted",
	);
	check(
		"DisclosureWithoutApproval",
		replaceOnce(
			source,
			'response\' = IF postDecision = "allowed" /\\ scope /\\ principal /\\ postCheckAvailable THEN "disclosed"',
			'response\' = IF scope /\\ principal /\\ postCheckAvailable THEN "disclosed"',
		),
		config,
		"DisclosureRequiresAuthorization",
	);
	check(
		"MissingJournal",
		replaceOnce(
			source,
			"/\\ journal /\\ dispatchGrant /\\ verifierPending",
			"/\\ dispatchGrant /\\ verifierPending",
		),
		config,
		"DispatchedUnknownHasJournal",
	);
	check(
		"MissingDispatchGrant",
		replaceOnce(
			source,
			"/\\ journal /\\ dispatchGrant /\\ verifierPending",
			"/\\ journal /\\ verifierPending",
		),
		config,
		"DispatchRequiresGrant",
	);
	check(
		"MissingReference",
		replaceOnce(
			source,
			"phase' = \"running\" /\\ reference' = TRUE",
			"phase' = \"running\" /\\ reference' = FALSE",
		),
		config,
		"UnknownHasReference",
	);
	check(
		"MissingDeliveryAuthorization",
		replaceOnce(
			source,
			'/\\ deliveryCheck = "allowed"\n  /\\ outcome\' = "ok"',
			'/\\ outcome\' = "ok"',
		),
		config,
		"OkHasDeliveryAuthorization",
	);
	check(
		"DisguisedDeliveryDenial",
		replaceOnce(
			source,
			'/\\ deliveryCheck\' = "denied" /\\ deliveryPending\' = FALSE\n  /\\ outcome\' = "unknown"',
			'/\\ deliveryCheck\' = "denied" /\\ deliveryPending\' = FALSE\n  /\\ outcome\' = "denied"',
		),
		config,
		"RejectedDeliveryIsUnknown",
	);
	check(
		"UnverifiedSuccess",
		replaceOnce(
			replaceOnce(
				replaceOnce(
					source,
					'StartDelivery ==\n  /\\ phase = "running" /\\ sent = 1 /\\ effect /\\ outcome = "none"',
					'StartDelivery ==\n  /\\ phase = "running" /\\ sent = 1 /\\ outcome = "none"',
				),
				'AuthorizeDelivery ==\n  /\\ phase = "running" /\\ sent = 1 /\\ effect /\\ outcome = "none"',
				'AuthorizeDelivery ==\n  /\\ phase = "running" /\\ sent = 1 /\\ outcome = "none"',
			),
			'AuthenticatedReceipt ==\n  /\\ phase = "running" /\\ sent = 1 /\\ effect /\\ outcome = "none"',
			'AuthenticatedReceipt ==\n  /\\ phase = "running" /\\ sent = 1 /\\ outcome = "none"',
		),
		config,
		"OkHasEffect",
	);
	check(
		"UnretiredDenial",
		replaceOnce(
			source,
			'/\\ phase = "running" /\\ sent = 1 /\\ writePending /\\ ~effect /\\ outcome = "none"\n  /\\ outcome\' = "denied" /\\ phase\' = "result" /\\ writePending\' = FALSE',
			'/\\ phase = "running" /\\ sent = 1 /\\ writePending /\\ ~effect /\\ outcome = "none"\n  /\\ outcome\' = "denied" /\\ phase\' = "result" /\\ writePending\' = TRUE',
		),
		config,
		"KvDenialHasNoEffect",
	);
	check(
		"MissingPostCheck",
		replaceOnce(
			source,
			'response\' = IF postDecision = "allowed" /\\ scope /\\ principal /\\ postCheckAvailable THEN "disclosed"',
			'response\' = IF postDecision = "allowed" THEN "disclosed"',
		),
		config,
		"DisclosureRequiresAuthorization",
	);
	check(
		"AutomaticRetry",
		replaceOnce(
			source,
			"\\/ Disclose \\/ MarkUnknownRetirementReady",
			"\\/ Disclose \\/ MarkUnknownRetirementReady \\/ RetryUnknown",
		),
		config,
		"AtMostOneDispatch",
	);
	check(
		"MissingFence",
		replaceOnce(
			source,
			"/\\ sent = 1 /\\ writePending /\\ ~fenced /\\ ~scopeFenced /\\ ~effect",
			"/\\ sent = 1 /\\ writePending /\\ ~effect",
		),
		config,
		"NoEffectAfterFence",
	);
	check(
		"HttpAuthorityAfterFence",
		replaceOnce(
			source,
			'StartPostAuthorization ==\n  /\\ phase = "result" /\\ response = "none" /\\ postDecision = "not-started" /\\ ~httpAuthorityPending\n  /\\ scope /\\ principal /\\ postCheckAvailable /\\ ~fenced /\\ ~scopeFenced',
			'StartPostAuthorization ==\n  /\\ phase = "result" /\\ response = "none" /\\ postDecision = "not-started" /\\ ~httpAuthorityPending\n  /\\ scope /\\ principal /\\ postCheckAvailable',
		),
		config,
		"NoHttpAuthorityAfterFence",
	);
	check(
		"UnfencedRetirement",
		replaceOnce(
			source,
			"/\\ ~writePending /\\ ~verifierPending /\\ ~deliveryPending /\\ ~actorPending /\\ ~httpAuthorityPending\n  /\\ (scopeFenced \\/ (mappingAuthenticated /\\ fenced))",
			"/\\ TRUE",
		),
		config,
		"UnknownRetirementRequiresFenceAndDrain",
	);
	check(
		"UnretiredDelivery",
		replaceOnce(
			source,
			"/\\ ~writePending /\\ ~verifierPending /\\ ~deliveryPending /\\ ~actorPending /\\ ~httpAuthorityPending\n  /\\ (scopeFenced \\/ (mappingAuthenticated /\\ fenced))",
			"/\\ ~writePending /\\ ~verifierPending /\\ ~actorPending /\\ ~httpAuthorityPending\n  /\\ (scopeFenced \\/ (mappingAuthenticated /\\ fenced))",
		),
		config,
		"UnknownRetirementRequiresFenceAndDrain",
	);
	check(
		"UnretiredActor",
		replaceOnce(
			source,
			"/\\ ~writePending /\\ ~verifierPending /\\ ~deliveryPending /\\ ~actorPending /\\ ~httpAuthorityPending\n  /\\ (scopeFenced \\/ (mappingAuthenticated /\\ fenced))",
			"/\\ ~writePending /\\ ~verifierPending /\\ ~deliveryPending /\\ ~httpAuthorityPending\n  /\\ (scopeFenced \\/ (mappingAuthenticated /\\ fenced))",
		),
		config,
		"UnknownRetirementRequiresFenceAndDrain",
	);
	check(
		"ReconcileWithPendingHttpAuthority",
		replaceOnce(
			source,
			"/\\ ~writePending /\\ ~verifierPending /\\ ~actorPending /\\ ~deliveryPending /\\ ~httpAuthorityPending\n  /\\ suppressedReconciled' = TRUE",
			"/\\ ~writePending /\\ ~verifierPending /\\ ~actorPending /\\ ~deliveryPending\n  /\\ suppressedReconciled' = TRUE",
		),
		config,
		"SuppressedReconciliationRequiresDrain",
	);
	check(
		"StaleMapping",
		replaceOnce(
			source,
			'/\\ (scopeFenced \\/ (mappingAuthenticated /\\ fenced))\n  /\\ phase\' = "retirement-ready"',
			'/\\ (scopeFenced \\/ ((mappingAuthenticated \\/ mappingWasRevoked) /\\ fenced))\n  /\\ phase\' = "retirement-ready"',
		),
		config,
		"UnknownRetirementRequiresFenceAndDrain",
	);
	check(
		"UnretiredDeniedActor",
		replaceOnce(
			source,
			'/\\ ~writePending /\\ ~verifierPending /\\ ~actorPending /\\ ~httpAuthorityPending /\\ (~journal \\/ journalHandled)\n  /\\ phase\' = "retirement-ready-denied"',
			'/\\ ~writePending /\\ ~verifierPending /\\ ~httpAuthorityPending /\\ (~journal \\/ journalHandled)\n  /\\ phase\' = "retirement-ready-denied"',
		),
		config,
		"DeniedRetirementRequiresCleanup",
	);
	check(
		"UnreconciledDeniedJournal",
		replaceOnce(
			source,
			'/\\ ~writePending /\\ ~verifierPending /\\ ~actorPending /\\ ~httpAuthorityPending /\\ (~journal \\/ journalHandled)\n  /\\ phase\' = "retirement-ready-denied"',
			'/\\ ~writePending /\\ ~verifierPending /\\ ~actorPending /\\ ~httpAuthorityPending\n  /\\ phase\' = "retirement-ready-denied"',
		),
		config,
		"DeniedRetirementRequiresCleanup",
	);
	check(
		"UnreconciledSuppressedOk",
		replaceOnce(
			source,
			'/\\ phase = "done" /\\ response = "suppressed" /\\ outcome = "ok"\n  /\\ suppressedReconciled /\\ scopeFenced',
			'/\\ phase = "done" /\\ response = "suppressed" /\\ outcome = "ok"\n  /\\ scopeFenced',
		),
		config,
		"SuppressedOkRetirementRequiresReconciliation",
	);
	check(
		"UnreconciledSuppressedUnknown",
		replaceOnce(
			source,
			'MarkUnknownRetirementReady ==\n  /\\ phase = "done" /\\ outcome = "unknown"\n  /\\ (response # "suppressed" \\/ suppressedReconciled)',
			'MarkUnknownRetirementReady ==\n  /\\ phase = "done" /\\ outcome = "unknown"',
		),
		config,
		"UnknownRetirementRequiresFenceAndDrain",
	);
	check(
		"UnreconciledSuppressedDenial",
		replaceOnce(
			source,
			'MarkDeniedRetirementReady ==\n  /\\ phase = "done" /\\ outcome = "denied"\n  /\\ (response # "suppressed" \\/ (suppressedReconciled /\\ scopeFenced))',
			'MarkDeniedRetirementReady ==\n  /\\ phase = "done" /\\ outcome = "denied"',
		),
		config,
		"DeniedRetirementRequiresCleanup",
	);
	check(
		"SuppressedDenialWithoutScopeFence",
		replaceOnce(
			replaceOnce(
				source,
				'/\\ IF outcome = "unknown" THEN (scopeFenced \\/ (mappingAuthenticated /\\ fenced)) ELSE scopeFenced',
				"/\\ TRUE",
			),
			'MarkDeniedRetirementReady ==\n  /\\ phase = "done" /\\ outcome = "denied"\n  /\\ (response # "suppressed" \\/ (suppressedReconciled /\\ scopeFenced))',
			'MarkDeniedRetirementReady ==\n  /\\ phase = "done" /\\ outcome = "denied"\n  /\\ (response # "suppressed" \\/ suppressedReconciled)',
		),
		config,
		"DeniedRetirementRequiresCleanup",
	);
	check(
		"UnretiredPreflightAuthority",
		replaceOnce(
			source,
			'/\\ ~writePending /\\ ~verifierPending /\\ ~actorPending /\\ ~deliveryPending /\\ ~httpAuthorityPending\n  /\\ phase\' = "retirement-ready-preflight"',
			'/\\ ~writePending /\\ ~verifierPending /\\ ~actorPending /\\ ~deliveryPending\n  /\\ phase\' = "retirement-ready-preflight"',
		),
		config,
		"PreflightRetirementRequiresCleanup",
	);
	for (const invariant of [
		"NoDelayedEffect",
		"NeverSuccessful",
		"NeverRejectedDelivery",
		"NeverPreUnavailableBeforeStart",
		"NeverSuppressedOkReadyAfterDrain",
		"NeverSuppressedDeniedReadyAfterDrain",
		"NeverPreDenied",
		"NeverPostDenied",
		"NeverPostApprovedDisclosure",
		"NeverPendingPreflightAuthority",
		"NeverPendingSuppressedAuthority",
		"NeverDrainedPreflightAuthority",
		"NeverDeniedActorPending",
		"NeverUnknownActorPending",
		"NeverDeliveryTimeoutPending",
		"NeverLateDeliverySettlement",
		"NeverDrainedDelivery",
		"NeverSuppressedAfterEffect",
		"NeverUnknownWithoutJournal",
		"NeverEnrolledWithoutDispatch",
		"NeverActorDenial",
		"NeverUnknownReadyWithoutJournal",
		"NeverLateEnrollmentAfterDenial",
		"NeverLateEnrollmentAfterUnknown",
		"NeverScopeReadyWithJournal",
		"NeverScopeFallbackForAuthenticated",
		"NeverScopeFallbackAfterMappingRevoked",
		"NeverDeniedReadyAfterLateEnrollment",
		"NeverCommitAfterGrantRevoked",
		"NeverUnavailableAfterEffect",
	])
		check(
			`Witness${invariant}`,
			source,
			`${config}\nINVARIANT ${invariant}\n`,
			invariant,
		);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
