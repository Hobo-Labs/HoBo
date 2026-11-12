// Parse, don't validate: every FreightSourceRecord the service stores came
// through `parseFreightSource`, which returns a normalized record (defaults
// applied, schema stamped) or a typed refusal listing every problem. Defaults
// are the conservative ones: SemVer without prereleases, INDEPENDENT
// assembly, the frozen poll interval and discovery limit.
import { clone } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	AssemblyRule,
	type FreightSourceRecord,
	FreightSourceRecordSchema,
	type ReasonRecord,
	SelectionStrategy,
	SubscriptionKind,
	type SubscriptionRecord,
	SubscriptionRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, SOURCE_SCHEMA } from "../events.js";
import type { Outcome } from "../ports.js";
import { gitSelectionAllowed } from "./drivers/git.js";
import { safeHttpsUrl } from "./drivers/http-index.js";
import { parseOciLocator } from "./drivers/oci.js";
import { parsePackageLocator } from "./drivers/packages.js";
import { reason, SOURCE_REASON } from "./reasons.js";
import { compilePattern, parseSemverRange } from "./selection.js";

export const SOURCE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BINDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const MAX_SUBSCRIPTIONS = 16;
export const MAX_DISCOVERY_LIMIT = 100;
const MAX_TEXT = 1024;

// Credential shapes that must never enter a record (I9): refused, not redacted.
const SECRET_PATTERNS: readonly RegExp[] = [
	/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

const DEFAULT_SELECTION: Readonly<Record<SubscriptionKind, SelectionStrategy>> = {
	[SubscriptionKind.UNSPECIFIED]: SelectionStrategy.UNSPECIFIED,
	[SubscriptionKind.OCI_REPOSITORY]: SelectionStrategy.SEMVER,
	[SubscriptionKind.GIT_REPOSITORY]: SelectionStrategy.SEMVER,
	[SubscriptionKind.PACKAGE_REGISTRY]: SelectionStrategy.SEMVER,
	[SubscriptionKind.HTTP_INDEX]: SelectionStrategy.SEMVER,
	[SubscriptionKind.HOBO_CI]: SelectionStrategy.NEWEST_BUILD,
	[SubscriptionKind.HOBO_RAIL]: SelectionStrategy.LEXICAL,
};

/** Kinds whose driver can fetch attestations for `require_provenance`. */
export const PROVENANCE_KINDS: ReadonlySet<SubscriptionKind> = new Set([SubscriptionKind.OCI_REPOSITORY]);

function invalid(subject: string, message: string, remediation: string): ReasonRecord {
	return reason(SOURCE_REASON.invalid, message, remediation, subject);
}

function checkText(subject: string, value: string, reasons: ReasonRecord[]): void {
	if (value.length > MAX_TEXT) reasons.push(invalid(subject, `${subject} exceeds ${MAX_TEXT} characters`, "shorten it"));
	else if (/\p{Cc}/u.test(value)) reasons.push(invalid(subject, `${subject} contains control characters`, "remove them"));
	else if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
		reasons.push(
			invalid(
				subject,
				`${subject} carries credential material; source records are secret-free`,
				"move the credential behind a credentialRef resolved where discovery runs, rotate it, and resubmit",
			),
		);
	}
}

function checkSelection(at: string, item: SubscriptionRecord, reasons: ReasonRecord[]): void {
	const selection = item.selection;
	const unsupported = () =>
		reasons.push(
			invalid(`${at}.selection`, `selection ${SelectionStrategy[selection]} is not supported for ${SubscriptionKind[item.kind]}`, "choose SEMVER or LEXICAL for versioned sources, NEWEST_COMMIT for a Git branch, NEWEST_BUILD for HOBO_CI, OCI or HTTP_INDEX"),
		);
	switch (item.kind) {
		case SubscriptionKind.GIT_REPOSITORY:
			if (!gitSelectionAllowed(item)) unsupported();
			break;
		case SubscriptionKind.PACKAGE_REGISTRY:
			if (selection === SelectionStrategy.NEWEST_BUILD || selection === SelectionStrategy.NEWEST_COMMIT) unsupported();
			break;
		case SubscriptionKind.OCI_REPOSITORY:
		case SubscriptionKind.HTTP_INDEX:
			if (selection === SelectionStrategy.NEWEST_COMMIT) unsupported();
			break;
		case SubscriptionKind.HOBO_CI:
			if (selection !== SelectionStrategy.NEWEST_BUILD) unsupported();
			break;
		default:
			break;
	}
}

function checkLocator(at: string, item: SubscriptionRecord, reasons: ReasonRecord[]): void {
	switch (item.kind) {
		case SubscriptionKind.OCI_REPOSITORY: {
			const parsed = parseOciLocator(item.locator);
			if (!parsed.ok) reasons.push(...parsed.reasons.map((r) => ({ ...r, subject: `${at}.locator` })));
			break;
		}
		case SubscriptionKind.PACKAGE_REGISTRY: {
			const parsed = parsePackageLocator(item);
			if (!parsed.ok) reasons.push(...parsed.reasons);
			break;
		}
		case SubscriptionKind.GIT_REPOSITORY:
		case SubscriptionKind.HTTP_INDEX:
			if (!safeHttpsUrl(item.locator)) {
				reasons.push(invalid(`${at}.locator`, "locator must be an https URL without credentials", "use https://host/path and put credentials behind credentialRef"));
			}
			break;
		case SubscriptionKind.HOBO_CI:
		case SubscriptionKind.HOBO_RAIL:
			if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(item.locator)) {
				reasons.push(invalid(`${at}.locator`, "locator must name a pipeline id, repository or Rail id", "set the locator"));
			}
			break;
		default:
			break;
	}
}

function normalizeSubscription(
	source: FreightSourceRecord,
	input: SubscriptionRecord,
	index: number,
	reasons: ReasonRecord[],
): SubscriptionRecord {
	const item = clone(SubscriptionRecordSchema, input);
	const at = `subscriptions[${index}]`;
	if (!SOURCE_NAME_PATTERN.test(item.name)) {
		reasons.push(invalid(`${at}.name`, "subscription name must be a lowercase slug (1-63 of [a-z0-9-])", "rename the subscription"));
	}
	if (item.kind === SubscriptionKind.UNSPECIFIED || SubscriptionKind[item.kind] === undefined) {
		reasons.push(invalid(`${at}.kind`, "subscription kind must be specified", "set kind (OCI_REPOSITORY, GIT_REPOSITORY, ...)"));
		return item;
	}
	if (item.kind === SubscriptionKind.HOBO_RAIL && item.locator === "") item.locator = source.bindle;
	if (item.selection === SelectionStrategy.UNSPECIFIED) {
		item.selection =
			item.kind === SubscriptionKind.GIT_REPOSITORY && item.branch !== ""
				? SelectionStrategy.NEWEST_COMMIT
				: DEFAULT_SELECTION[item.kind];
	}
	if (item.discoveryLimit === 0) item.discoveryLimit = CD_DEFAULTS.sourceDiscoveryLimit;
	if (item.discoveryLimit > MAX_DISCOVERY_LIMIT) {
		reasons.push(invalid(`${at}.discoveryLimit`, `discoveryLimit exceeds ${MAX_DISCOVERY_LIMIT}`, `use at most ${MAX_DISCOVERY_LIMIT}`));
	}
	checkText(`${at}.locator`, item.locator, reasons);
	checkText(`${at}.artifactName`, item.artifactName, reasons);
	checkLocator(at, item, reasons);
	checkSelection(at, item, reasons);
	if (item.branch !== "" && item.kind !== SubscriptionKind.GIT_REPOSITORY) {
		reasons.push(invalid(`${at}.branch`, "branch applies only to GIT_REPOSITORY", "remove branch"));
	}
	if (item.allowPattern !== "") {
		const compiled = compilePattern(item.allowPattern, `${at}.allowPattern`);
		if (!compiled.ok) reasons.push(...compiled.reasons);
	}
	for (const [patternIndex, pattern] of item.ignorePatterns.entries()) {
		const compiled = compilePattern(pattern, `${at}.ignorePatterns[${patternIndex}]`);
		if (!compiled.ok) reasons.push(...compiled.reasons);
	}
	if (item.semverRange !== "") {
		if (item.selection !== SelectionStrategy.SEMVER) {
			reasons.push(invalid(`${at}.semverRange`, "semverRange needs SEMVER selection", "set selection SEMVER or remove semverRange"));
		} else {
			const range = parseSemverRange(item.semverRange);
			if (!range.ok) reasons.push(...range.reasons.map((r) => ({ ...r, subject: `${at}.semverRange` })));
		}
	}
	for (const [pathIndex, path] of [...item.includePaths, ...item.excludePaths].entries()) {
		if (path === "" || path.includes("..") || path.startsWith("/") || path.length > 512) {
			reasons.push(invalid(`${at}.paths[${pathIndex}]`, `path ${JSON.stringify(path)} is not a repository-relative path`, "use paths like deploy or services/web"));
		}
	}
	if ((item.includePaths.length > 0 || item.excludePaths.length > 0) && item.kind !== SubscriptionKind.GIT_REPOSITORY && item.kind !== SubscriptionKind.HOBO_CI) {
		reasons.push(invalid(`${at}.includePaths`, "path filters apply to GIT_REPOSITORY and HOBO_CI", "remove includePaths/excludePaths"));
	}
	if (item.credentialRef !== "" && !CREDENTIAL_REF.test(item.credentialRef)) {
		reasons.push(invalid(`${at}.credentialRef`, "credentialRef must be a reference name, not a credential", "name the credential (e.g. registry/ghcr-ro)"));
	}
	const pinned = item.trustedBuilderIds.length > 0 || item.trustedSignerIdentities.length > 0;
	if (pinned && !item.requireProvenance) {
		reasons.push(invalid(`${at}.requireProvenance`, "builder/signer pins without requireProvenance would never be enforced", "set requireProvenance, or remove the pins"));
	}
	if (item.requireProvenance && !PROVENANCE_KINDS.has(item.kind)) {
		reasons.push(
			reason(
				SOURCE_REASON.provenanceUnsupported,
				`requireProvenance is not available for ${SubscriptionKind[item.kind]}: its driver cannot fetch attestations`,
				"use an OCI subscription with referrer attestations, or ingest signed attestations through FreightIngest.attestation",
				`${at}.requireProvenance`,
			),
		);
	}
	if (item.kind === SubscriptionKind.HTTP_INDEX && item.artifactKind === ArtifactKind.UNSPECIFIED) {
		reasons.push(invalid(`${at}.artifactKind`, "HTTP_INDEX needs an artifactKind", "set artifactKind (e.g. STATIC_ASSETS)"));
	}
	if (item.kind === SubscriptionKind.HOBO_CI && (item.artifactKind === ArtifactKind.UNSPECIFIED || item.artifactName === "")) {
		reasons.push(invalid(`${at}.artifactName`, "HOBO_CI needs artifactName (the CI output path) and artifactKind", "set artifactName and artifactKind"));
	}
	if (item.kind === SubscriptionKind.HOBO_RAIL && item.locator !== source.bindle) {
		reasons.push(invalid(`${at}.locator`, "a HOBO_RAIL subscription's locator must equal the source bindle (the Rail id)", "set bindle to the Rail id"));
	}
	return item;
}

/** Normalize and check a FreightSourceRecord; `definedBy` is the principal id. */
export function parseFreightSource(input: FreightSourceRecord, definedBy: string): Outcome<FreightSourceRecord> {
	const reasons: ReasonRecord[] = [];
	const source = clone(FreightSourceRecordSchema, input);
	source.schemaVersion = SOURCE_SCHEMA;
	source.definedBy = definedBy;
	if (!SOURCE_NAME_PATTERN.test(source.name)) {
		reasons.push(invalid("name", "source name must be a lowercase slug (1-63 of [a-z0-9-])", "rename the source"));
	}
	if (!BINDLE_PATTERN.test(source.bindle)) {
		reasons.push(invalid("bindle", "bindle must be 1-128 characters of [A-Za-z0-9._:@/-]", "set the Bindle id (or the Rail id for HOBO_RAIL)"));
	}
	if (source.subscriptions.length === 0 || source.subscriptions.length > MAX_SUBSCRIPTIONS) {
		reasons.push(invalid("subscriptions", `a source needs 1-${MAX_SUBSCRIPTIONS} subscriptions`, "add a subscription"));
	}
	source.subscriptions = source.subscriptions.map((item, index) => normalizeSubscription(source, item, index, reasons));
	const names = source.subscriptions.map((item) => item.name);
	if (new Set(names).size !== names.length) {
		reasons.push(invalid("subscriptions", "subscription names must be unique within a source", "rename the duplicates"));
	}
	const declarations = source.subscriptions.filter(
		(item) => (item.artifactKind || (item.kind === SubscriptionKind.GIT_REPOSITORY ? ArtifactKind.SOURCE_TREE : 0)) === ArtifactKind.SOURCE_TREE,
	);
	if (declarations.length > 1) {
		reasons.push(invalid("subscriptions", "at most one subscription may supply the declaration (SOURCE_TREE)", "keep one Git/declaration subscription per source"));
	}
	const rail = source.subscriptions.some((item) => item.kind === SubscriptionKind.HOBO_RAIL);
	if (rail && source.subscriptions.length !== 1) {
		reasons.push(invalid("subscriptions", "a HOBO_RAIL source has exactly one subscription", "define Rail sources on their own"));
	}
	if (source.assembly === AssemblyRule.UNSPECIFIED) source.assembly = AssemblyRule.INDEPENDENT;
	if (AssemblyRule[source.assembly] === undefined) reasons.push(invalid("assembly", "unknown assembly rule", "use INDEPENDENT, SAME_VERSION or SAME_COMMIT"));
	if (source.assembly !== AssemblyRule.INDEPENDENT && source.subscriptions.length < 2) {
		reasons.push(invalid("assembly", `${AssemblyRule[source.assembly]} pairs subscriptions and needs at least two`, "use INDEPENDENT for a single subscription"));
	}
	if (rail && source.assembly !== AssemblyRule.INDEPENDENT) {
		reasons.push(invalid("assembly", "a HOBO_RAIL source assembles INDEPENDENT", "remove the assembly rule"));
	}
	if (source.pollIntervalMs === 0n) source.pollIntervalMs = BigInt(CD_DEFAULTS.sourcePollIntervalMs);
	if (source.pollIntervalMs < BigInt(CD_DEFAULTS.sourcePollIntervalMinMs)) {
		reasons.push(
			invalid("pollIntervalMs", `pollIntervalMs is below the ${CD_DEFAULTS.sourcePollIntervalMinMs} ms minimum`, `use at least ${CD_DEFAULTS.sourcePollIntervalMinMs} ms; webhooks nudge sooner polls`),
		);
	}
	if (source.pollIntervalMs > 86_400_000n) {
		reasons.push(invalid("pollIntervalMs", "pollIntervalMs exceeds one day", "poll at least daily"));
	}
	return reasons.length > 0 ? { ok: false, reasons } : { ok: true, value: source };
}
