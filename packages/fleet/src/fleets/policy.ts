/**
 * Fleet record and policy validation (L32, private): the `FleetRecord` and
 * `FleetPolicy` rows of §7.2, plus the shapes the work and session rules read
 * later (repository, OIDC and label rules). A record that passes is returned
 * with the tenant filled in; one that fails is refused with `invalid-request`
 * and `detail.rule` naming the rule, except `ONE_ACTIVE` in authority mode,
 * which is `fleet-policy` with rule `one-active-authority` (D39).
 */
import { create } from "@bufbuild/protobuf";
import type { TenantId } from "@hobo/core";
import {
	ApprovalMode,
	CoordinationMode,
	DeviceClass,
	type FleetPolicy,
	type FleetRecord,
	FleetRecordSchema,
	MemberKind,
	SandboxTier,
	SessionPurpose,
} from "../_generated/fleet_pb.js";
import { type FleetId, parseFleetId } from "../ids.js";
import type { Outcome } from "../ports.js";
import { ok, refuse } from "./support.js";

/** A lower-case DNS name, no wildcard (§7.2 `egress_allow`). */
const DNS_NAME =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_KEY_BUNDLE_HOURS = 720;
const MAX_LABEL_LENGTH = 80;

export function isDnsName(value: string): boolean {
	return DNS_NAME.test(value);
}

export function isSha256(value: string): boolean {
	return SHA256.test(value);
}

function compiles(pattern: string): boolean {
	try {
		return new RegExp(pattern, "u").source.length > 0;
	} catch {
		return false;
	}
}

function invalid<T>(rule: string, message: string): Outcome<T> {
	return refuse("invalid-request", message, { rule });
}

function known(value: number, max: number): boolean {
	return Number.isInteger(value) && value >= 1 && value <= max;
}

/** The fleet id of a request, or `invalid-request`. */
export function fleetIdOf(value: string, field = "fleet_id"): Outcome<FleetId> {
	try {
		return ok(parseFleetId(value, field));
	} catch {
		return invalid("fleet-id", `${field} must be a short lower-case token`);
	}
}

export function validateFleet(
	request: FleetRecord,
	tenant: TenantId,
	mode: "authority" | "local",
): Outcome<FleetRecord> {
	const id = fleetIdOf(request.fleetId);
	if (!id.ok) return id;
	if (request.tenant !== "" && request.tenant !== tenant)
		return invalid("tenant", "the record names another tenant");
	if (!known(request.coordination, CoordinationMode.ONE_ACTIVE))
		return invalid("coordination", "coordination must be set");
	const policy = request.policy;
	if (policy === undefined)
		return invalid("policy", "a fleet record carries its policy");
	const oneActive = request.coordination === CoordinationMode.ONE_ACTIVE;
	if (oneActive && mode === "authority")
		return refuse(
			"fleet-policy",
			"one-active fleets run in local mode only (D39)",
			{ rule: "one-active-authority" },
		);
	const checked = validatePolicy(policy, oneActive);
	if (!checked.ok) return checked;
	return ok(create(FleetRecordSchema, { ...request, tenant }));
}

function validatePolicy(
	policy: FleetPolicy,
	oneActive: boolean,
): Outcome<true> {
	if (!known(policy.approval, ApprovalMode.DUAL))
		return invalid("approval", "approval must be set");
	if (policy.allowedKinds.some((kind) => !known(kind, MemberKind.TARGET)))
		return invalid("allowed-kinds", "allowed_kinds names an unknown kind");
	if (oneActive) {
		if (!policy.allowedKinds.includes(MemberKind.BACKEND))
			return invalid(
				"one-active-kinds",
				"a one-active fleet must allow BACKEND members",
			);
		if (policy.failoverAfterMs === 0)
			return invalid(
				"failover-after",
				"a one-active fleet needs failover_after_ms",
			);
	} else {
		if (policy.membershipEpochs)
			return invalid(
				"membership-epochs",
				"membership_epochs applies to one-active fleets only",
			);
		if (policy.recoveryPointMs !== undefined)
			return invalid(
				"recovery-point",
				"recovery_point_ms applies to one-active fleets only",
			);
	}
	if (
		policy.allowHostDocker &&
		!(
			policy.allowedClasses.length === 1 &&
			policy.allowedClasses[0] === DeviceClass.DEDICATED
		)
	)
		return invalid(
			"host-docker",
			"allow_host_docker needs allowed_classes to be exactly DEDICATED",
		);
	if (
		policy.orgMinSandbox !== SandboxTier.UNSPECIFIED &&
		!known(policy.orgMinSandbox, SandboxTier.S3_MICROVM)
	)
		return invalid("org-min-sandbox", "org_min_sandbox is not a tier");
	if (
		policy.orgMinSandbox !== SandboxTier.UNSPECIFIED &&
		policy.orgMinSandbox < SandboxTier.S3_MICROVM &&
		policy.repositories.length === 0
	)
		return invalid(
			"org-min-sandbox",
			"org_min_sandbox below S3 needs repository rules",
		);
	for (const host of policy.egressAllow)
		if (!isDnsName(host))
			return invalid(
				"egress",
				`egress_allow entry ${host} is not a lower-case DNS name`,
			);
	if (policy.keyBundleHours > MAX_KEY_BUNDLE_HOURS)
		return invalid("key-bundle-hours", "key_bundle_hours is at most 720");
	for (const rule of policy.repositories) {
		if (!REPOSITORY.test(rule.repository))
			return invalid(
				"repository",
				`repository ${rule.repository} is not owner/name`,
			);
		if (rule.workflowDigests.some((digest) => !isSha256(digest)))
			return invalid("workflow-digest", "workflow digests are sha256:<64 hex>");
	}
	for (const rule of policy.oidcTrust) {
		if (!rule.issuer.startsWith("https://"))
			return invalid("oidc-trust", "an OIDC trust rule names an https issuer");
		if (!compiles(rule.subjectPattern))
			return invalid(
				"oidc-trust",
				"an OIDC trust rule's subject pattern does not compile",
			);
	}
	if (
		policy.sessionPurposes.some(
			(purpose) => !known(purpose, SessionPurpose.BLOB),
		)
	)
		return invalid("session-purposes", "session_purposes names no purpose");
	if (
		policy.labels.some(
			(label) => label.length === 0 || label.length > MAX_LABEL_LENGTH,
		)
	)
		return invalid("labels", "labels are 1 to 80 characters");
	if (policy.workKinds.some((kind) => kind.length === 0))
		return invalid("work-kinds", "work_kinds entries are non-empty");
	return ok(true);
}
