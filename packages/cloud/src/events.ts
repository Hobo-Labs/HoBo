// Past-tense control-plane facts the Yard kernel appends (control-plane.md
// "Command / event API surface": commands are validated and authorized and the
// only side effect is appending events). The event *type* obeys core's
// `family.PastTenseFact` envelope pattern (no colon), so the per-resource subject
// (`match.Decided:<resource>` in the reference architecture) is carried in the
// fact body's `resource`/`deploymentId` fields, never in the type string.

import type { EventInput } from "@hobo/core";

import type {
	DeploymentPlan,
	MatchDecided,
	PlanRemediation,
} from "./plan-types.js";
import { isJsonString, type JsonValue, type JsonObject } from "./json.js";


export const CLOUD_EVENT_SCHEMA_VERSION = "hobo.cloud-events/v1";

// Control-plane event catalog (control-plane.md + the epic reference
// architecture). These are the only fact types the S2-01/S2-02 vertical emits.
export const CLOUD_EVENTS = Object.freeze({
	DeploymentRequested: "deployment.Requested",
	MatchDecided: "match.Decided",
	DeploymentPlanned: "deployment.Planned",
	DeploymentPlanRejected: "deployment.PlanRejected",
	ProviderRegistered: "provider.Registered",
	// Operator approval of a registered provider. Only approved providers are
	// matchable by the Planner (walkthrough Part 0/2: a cloud's "default
	// providers approved" is a durable fact, not config).
	ProviderApproved: "provider.Approved",
	ResourcePlanning: "resource.Planning",
	ResourceProvisioning: "resource.Provisioning",
	ResourceProvisioned: "resource.Provisioned",
	ResourceFailed: "resource.Failed",
	ResourceDestroying: "resource.Destroying",
	ResourceDestroyed: "resource.Destroyed",
	ExecDiff: "exec.Diff",
	ExecSucceeded: "exec.Succeeded",
	DeploymentDeployed: "deployment.Deployed",
	DeploymentRolledBack: "deployment.RolledBack",
	// Ownership rebind: an anonymous `npx hobo up` deployment is bound to an
	// account, preserving all provisioned state (resources, outputs, URL).
	DeploymentClaimed: "deployment.Claimed",
	// Crypto-shred erasure REQUEST for a data subject (HOBO-295). Append-only —
	// historical events are never rewritten; projections redact the subject on
	// rebuild.
	SubjectErasureRequested: "subject.ErasureRequested",
	// Adopt an existing estate in place: bring resources that ALREADY exist under
	// HoBo management by recording them as a deployment, without provisioning.
	DeploymentImported: "deployment.Imported",
	// Derived-HoBo (fork) upgrade ceremony (ADR-0057): check the derivative.json
	// descriptor, run pinned upcasters, rerun seam conformance.
	DerivativeUpgradeStarted: "derivative.UpgradeStarted",
	DerivativeUpgradeSucceeded: "derivative.UpgradeSucceeded",
	DerivativeUpgradeFailed: "derivative.UpgradeFailed",
	// Credential-audit facts (NFR-018): the per-resource scoped-credential
	// lifecycle the Orchestrator brokers around each apply. Folded by
	// `credentialAuditProjection` into a grant -> use -> revoke trail.
	TokenGranted: "token.Granted",
	TokenUsed: "token.Used",
	TokenRevoked: "token.Revoked",
} as const);

// The audited (port, resource, action) scope of a brokered credential.
export interface CredentialGrantScope {
	port: string;
	resource: string;
	action: string;
}

export interface DeploymentOwner {
	kind: string;
	id: string;
}

export function deploymentClaimed(data: {
	deploymentId: string;
	previousOwner?: DeploymentOwner;
	newOwner: DeploymentOwner;
}): EventInput {
	return { type: CLOUD_EVENTS.DeploymentClaimed, data };
}

export function subjectErasureRequested(data: {
	subject: string;
	reason?: string;
}): EventInput {
	return { type: CLOUD_EVENTS.SubjectErasureRequested, data };
}

export function deploymentImported(data: {
	deploymentId: string;
	bindleHash: string;
	resources: string[];
}): EventInput {
	return { type: CLOUD_EVENTS.DeploymentImported, data };
}

export function derivativeUpgradeStarted(data: {
	name: string;
	fromVersion: string;
	toVersion: string;
	upcasters: string[];
}): EventInput {
	return { type: CLOUD_EVENTS.DerivativeUpgradeStarted, data };
}

export function derivativeUpgradeSucceeded(data: {
	name: string;
	toVersion: string;
	upcastersRun: string[];
}): EventInput {
	return { type: CLOUD_EVENTS.DerivativeUpgradeSucceeded, data };
}

export function derivativeUpgradeFailed(data: {
	name: string;
	reason: string;
}): EventInput {
	return { type: CLOUD_EVENTS.DerivativeUpgradeFailed, data };
}

// Fold the erased-subject set from a stream's events. Append-only crypto-shred:
// the events stay, but any subject named by a `subject.ErasureRequested` fact is
// redacted from rebuilt projections (HOBO-295).
export function foldErasedSubjects(
	events: Iterable<{ type: string; data?: unknown }>,
): Set<string> {
	const erased = new Set<string>();
	for (const event of events) {
		if (event.type === CLOUD_EVENTS.SubjectErasureRequested) {
			// SAFETY: `const subject = (event.data as { subject?: unknown } | undefined)` is required at this I/O or test boundary.
			const subject = (event.data as { subject?: unknown } | undefined)
				?.subject;
			if (isJsonString(subject) && subject.length > 0) {
				erased.add(subject);
			}
		}
	}
	return erased;
}

export function tokenGranted(data: {
	grantId: string;
	svidSubject?: string;
	tokenRef?: string;
	scope?: CredentialGrantScope;
}): EventInput {
	return { type: CLOUD_EVENTS.TokenGranted, data };
}

export function tokenUsed(data: { grantId: string }): EventInput {
	return { type: CLOUD_EVENTS.TokenUsed, data };
}

export function tokenRevoked(data: {
	grantId: string;
	reason?: string;
}): EventInput {
	return { type: CLOUD_EVENTS.TokenRevoked, data };
}

export interface DeploymentRequestedData {
	deploymentId: string;
	bindleHash: string;
	tenant: string;
	config: JsonObject;
}

export function deploymentRequested(data: DeploymentRequestedData): EventInput {
	return { type: CLOUD_EVENTS.DeploymentRequested, data };
}

export function matchDecided(data: MatchDecided): EventInput {
	return { type: CLOUD_EVENTS.MatchDecided, data };
}

export function deploymentPlanned(data: {
	deploymentId: string;
	planHash: string;
	plan: DeploymentPlan;
}): EventInput {
	return { type: CLOUD_EVENTS.DeploymentPlanned, data };
}

export function deploymentPlanRejected(data: {
	deploymentId: string;
	reason: string;
	remediations: PlanRemediation[];
}): EventInput {
	return { type: CLOUD_EVENTS.DeploymentPlanRejected, data };
}

export function providerRegistered(data: {
	providerId: string;
	definitions: JsonValue[];
	manifestIndexDigest: string;
}): EventInput {
	return { type: CLOUD_EVENTS.ProviderRegistered, data };
}

export function providerApproved(data: {
	providerId: string;
	approvedBy?: string;
}): EventInput {
	return { type: CLOUD_EVENTS.ProviderApproved, data };
}

// ---- S2-03a/b: Orchestrator + ResourceActor FSM + Executor facts ----
// Past-tense facts the provisioning path appends. The per-resource subject rides
// the fact body's `resourceId`/`deploymentId` fields, never the type string.

export interface ResourceProvisioningData {
	deploymentId: string;
	resourceId: string;
	execId: string;
	programHash: string;
}

export function resourceProvisioning(
	data: ResourceProvisioningData,
): EventInput {
	return { type: CLOUD_EVENTS.ResourceProvisioning, data };
}

export interface ResourceProvisionedData {
	deploymentId: string;
	resourceId: string;
	outputs: Record<string, string>;
	execId: string;
}

export function resourceProvisioned(data: ResourceProvisionedData): EventInput {
	return { type: CLOUD_EVENTS.ResourceProvisioned, data };
}

export interface ResourceFailedData {
	deploymentId: string;
	resourceId: string;
	reason: string;
	classification: "retryable" | "fatal";
	crossedNoGoThreshold: boolean;
}

export function resourceFailed(data: ResourceFailedData): EventInput {
	return { type: CLOUD_EVENTS.ResourceFailed, data };
}

export interface ResourceDestroyingData {
	deploymentId: string;
	resourceId: string;
	reason: string;
}

export function resourceDestroying(data: ResourceDestroyingData): EventInput {
	return { type: CLOUD_EVENTS.ResourceDestroying, data };
}

export interface ResourceDestroyedData {
	deploymentId: string;
	resourceId: string;
	finalStateHash: string;
}

export function resourceDestroyed(data: ResourceDestroyedData): EventInput {
	return { type: CLOUD_EVENTS.ResourceDestroyed, data };
}

export interface ExecDiffData {
	execId: string;
	summary: string;
	changes: number;
}

export function execDiff(data: ExecDiffData): EventInput {
	return { type: CLOUD_EVENTS.ExecDiff, data };
}

export interface ExecSucceededData {
	execId: string;
	outputsHash: string;
	outputs: Record<string, string>;
}

export function execSucceeded(data: ExecSucceededData): EventInput {
	return { type: CLOUD_EVENTS.ExecSucceeded, data };
}

export interface DeploymentDeployedData {
	deploymentId: string;
	setId: string;
	resourceIds: string[];
}

export function deploymentDeployed(data: DeploymentDeployedData): EventInput {
	return { type: CLOUD_EVENTS.DeploymentDeployed, data };
}

export interface DeploymentRolledBackData {
	deploymentId: string;
	targetSetId: string;
	reason: string;
}

export function deploymentRolledBack(
	data: DeploymentRolledBackData,
): EventInput {
	return { type: CLOUD_EVENTS.DeploymentRolledBack, data };
}
