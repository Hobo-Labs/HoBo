/**
 * The pure rules of many-active work (design §6.9, §6.11, §6.13): the work
 * digest, the trust class a device derives for itself, the sandbox tier that
 * class needs, what fleet policy allows, residency and the agent version
 * floor. Private to L04; the entry points in `index.ts` wrap them.
 */
import { createHash } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import {
	evaluateResidency,
	parseDataClassification,
	parseJurisdictionId,
} from "@hobo/core";
import {
	DeviceClass,
	type FleetPolicy,
	type MemberRecord,
	type ResidencyRule,
	SandboxTier,
	TrustClass,
	type WorkOffer,
	WorkOrigin,
	type WorkSubmission,
	WorkSubmissionSchema,
} from "../_generated/fleet_pb.js";
import { parseWorkDigest, type WorkDigest } from "../ids.js";

/** First 32 hex of `sha256(kind ‖ 0x00 ‖ work_key)` (§7.1 `WorkOffer.work_digest`). */
export function digestOf(kind: string, workKey: string): WorkDigest {
	const hex = createHash("sha256")
		.update(kind)
		.update(new Uint8Array([0]))
		.update(workKey)
		.digest("hex");
	return parseWorkDigest(hex.slice(0, 32));
}

/** The authority-signed submission an offer carries, decoded (not verified; `checkOrder` verifies). */
export function submissionOf(offer: WorkOffer): WorkSubmission | undefined {
	if (offer.submission === undefined) return undefined;
	try {
		return fromBinary(WorkSubmissionSchema, offer.submission.payload);
	} catch {
		return undefined;
	}
}

/**
 * §6.11: `UNTRUSTED` if the offer says so or its origin is not `INTERNAL`;
 * otherwise `OWN` if the author is one of the owner's linked identities in
 * this device's own record; otherwise `ORG`. A dispatcher's `OWN` is ignored:
 * the offer's class is only ever a ceiling. For submitted work the author is
 * the one inside the authority's submission.
 */
export function trustClassOf(offer: WorkOffer, self: MemberRecord): TrustClass {
	if (offer.trustClass === TrustClass.UNTRUSTED) return TrustClass.UNTRUSTED;
	if (offer.origin !== WorkOrigin.INTERNAL) return TrustClass.UNTRUSTED;
	let author = offer.author;
	if (offer.submission !== undefined) {
		const submission = submissionOf(offer);
		if (submission === undefined) return TrustClass.UNTRUSTED;
		author = submission.author;
	}
	const linked = [self.owner, ...self.ownerAliases].filter(
		(identity) => identity.length > 0,
	);
	if (author.length > 0 && linked.includes(author)) return TrustClass.OWN;
	return TrustClass.ORG;
}

/** Whether the fleet's policy names `repository` in its repository rules. */
function namesRepository(policy: FleetPolicy, repository: string): boolean {
	return (
		repository.length > 0 &&
		policy.repositories.some((rule) => rule.repository === repository)
	);
}

/**
 * The table of §6.11. Device class `UNSPECIFIED` (a sponsored member, or a
 * record without a class) is treated as `PERSONAL`, the strictest column.
 */
export function sandboxFor(
	trust: TrustClass,
	deviceClass: DeviceClass,
	policy: FleetPolicy,
	repository: string,
): SandboxTier | "never" {
	if (trust === TrustClass.OWN) return SandboxTier.S1_CONTAINER;
	if (trust === TrustClass.ORG) {
		if (deviceClass === DeviceClass.EPHEMERAL) return SandboxTier.S1_CONTAINER;
		if (
			deviceClass === DeviceClass.DEDICATED &&
			policy.orgMinSandbox !== SandboxTier.UNSPECIFIED &&
			policy.orgMinSandbox < SandboxTier.S3_MICROVM &&
			namesRepository(policy, repository)
		)
			return policy.orgMinSandbox;
		return SandboxTier.S3_MICROVM;
	}
	// UNTRUSTED, or a class nobody derived: only an ephemeral micro-VM.
	return deviceClass === DeviceClass.EPHEMERAL
		? SandboxTier.S3_MICROVM
		: "never";
}

/** The tier a device needs for this offer: the §6.11 minimum, raised to the work's own minimum. */
export function neededTier(
	offer: WorkOffer,
	self: MemberRecord,
	policy: FleetPolicy,
) {
	const trust = trustClassOf(offer, self);
	const tier = sandboxFor(trust, self.deviceClass, policy, offer.repository);
	const floor = offer.needs?.minSandbox ?? SandboxTier.UNSPECIFIED;
	const needed: SandboxTier | "never" =
		tier === "never" ? tier : floor > tier ? floor : tier;
	return { trust, tier: needed };
}

/** A ref glob of `RepositoryRule.refs`: `*` is anything but `/`, `**` is anything. */
export function refMatches(glob: string, ref: string): boolean {
	let pattern = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index] ?? "";
		if (char === "*") {
			if (glob[index + 1] === "*") {
				pattern += ".*";
				index += 1;
			} else pattern += "[^/]*";
		} else pattern += char.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
	}
	return new RegExp(`^${pattern}$`, "u").test(ref);
}

export type PolicyRefusal = "kind" | "repository" | "ref" | "workflow";

/**
 * §6.9 step 6, the policy part: the kind is allowed (an empty `work_kinds`
 * places no restriction, as for the other lists of a fresh policy), and work
 * that names a repository needs a rule for it, a ref one of the rule's globs
 * matches (empty `refs` means none), and a workflow digest the rule lists
 * (empty means any). Work without a repository (submitted work) skips those.
 */
export function policyRefusal(
	policy: FleetPolicy,
	work: Readonly<{
		kind: string;
		repository: string;
		ref: string;
		workflowDigest: string;
	}>,
): PolicyRefusal | undefined {
	if (policy.workKinds.length > 0 && !policy.workKinds.includes(work.kind))
		return "kind";
	if (work.repository.length === 0) return undefined;
	const rule = policy.repositories.find(
		(candidate) => candidate.repository === work.repository,
	);
	if (rule === undefined) return "repository";
	if (!rule.refs.some((glob) => refMatches(glob, work.ref))) return "ref";
	if (
		rule.workflowDigests.length > 0 &&
		!rule.workflowDigests.includes(work.workflowDigest)
	)
		return "workflow";
	return undefined;
}

function hasRule(rule: ResidencyRule | undefined): rule is ResidencyRule {
	return (
		rule !== undefined &&
		(rule.allowedJurisdictions.length > 0 ||
			rule.deniedJurisdictions.length > 0 ||
			rule.classifications.length > 0)
	);
}

/**
 * §6.13: where the fleet or the offer carries a residency rule, the member's
 * region must evaluate `ok` under each (ADR-0146, fail closed). An undeclared
 * or unmapped region, or a rule that does not parse, excludes.
 */
export function residencyAllows(
	region: string,
	rules: readonly (ResidencyRule | undefined)[],
): boolean {
	for (const rule of rules) {
		if (!hasRule(rule)) continue;
		if (region.trim().length === 0) return false;
		try {
			const result = evaluateResidency({
				constraint: {
					classifications: rule.classifications.map((value) =>
						parseDataClassification(value),
					),
					allowedJurisdictions: rule.allowedJurisdictions.map((value) =>
						parseJurisdictionId(value),
					),
					deniedJurisdictions: rule.deniedJurisdictions.map((value) =>
						parseJurisdictionId(value),
					),
				},
				region,
			});
			if (!result.ok) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function versionParts(version: string): number[] | undefined {
	const core = version.trim().replace(/^v/u, "").split(/[-+]/u)[0] ?? "";
	const numbers = core.split(".").map((part) => Number(part));
	return numbers.every((part) => Number.isSafeInteger(part) && part >= 0)
		? numbers
		: undefined;
}

/** Dotted numeric versions; a missing part is 0; an unreadable floor places none; an unreadable version fails. */
export function versionAtLeast(version: string, floor: string): boolean {
	if (floor.trim().length === 0) return true;
	const need = versionParts(floor);
	if (need === undefined) return true;
	const have = versionParts(version);
	if (have === undefined) return false;
	for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
		const a = have[index] ?? 0;
		const b = need[index] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}
