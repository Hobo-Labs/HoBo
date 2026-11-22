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

export function digestOf(kind: string, workKey: string): WorkDigest {
	const hex = createHash("sha256")
		.update(kind)
		.update(new Uint8Array([0]))
		.update(workKey)
		.digest("hex");
	return parseWorkDigest(hex.slice(0, 32));
}

export function submissionOf(offer: WorkOffer): WorkSubmission | undefined {
	if (offer.submission === undefined) return undefined;
	try {
		return fromBinary(WorkSubmissionSchema, offer.submission.payload);
	} catch {
		return undefined;
	}
}

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

function namesRepository(policy: FleetPolicy, repository: string): boolean {
	return (
		repository.length > 0 &&
		policy.repositories.some((rule) => rule.repository === repository)
	);
}

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
	return deviceClass === DeviceClass.EPHEMERAL
		? SandboxTier.S3_MICROVM
		: "never";
}

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
