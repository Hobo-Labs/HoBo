// Past-tense control-plane facts the Yard kernel appends (control-plane.md
// "Command / event API surface": commands are validated and authorized and the
// only side effect is appending events). The event *type* obeys core's
// `family.PastTenseFact` envelope pattern (no colon), so the per-resource subject
// (`match.Decided:<resource>` in the reference architecture) is carried in the
// fact body's `resource`/`deploymentId` fields, never in the type string.

import type { EventInput } from "@hobo/core";
import { isJsonString, type JsonObject, type JsonValue } from "./json.js";
import type {
	DeploymentPlan,
	MatchDecided,
	PlanRemediation,
} from "./plan-types.js";

export const CLOUD_EVENT_SCHEMA_VERSION = "hobo.cloud-events/v1";

export const CLOUD_EVENTS = Object.freeze({
	DeploymentRequested: "deployment.Requested",
	MatchDecided: "match.Decided",
	DeploymentPlanned: "deployment.Planned",
	DeploymentPlanRejected: "deployment.PlanRejected",
	ProviderRegistered: "provider.Registered",
	ProviderApproved: "provider.Approved",
	ResourcePlanning: "resource.Planning",
	ResourceProvisioning: "resource.Provisioning",
	ResourceProvisioned: "resource.Provisioned",
	ResourceFailed: "resource.Failed",
	ResourceReconciled: "resource.Reconciled",
	ResourceDestroying: "resource.Destroying",
	ResourceDestroyed: "resource.Destroyed",
	ExecDiff: "exec.Diff",
	ExecSucceeded: "exec.Succeeded",
	DeploymentDeployed: "deployment.Deployed",
	DeploymentRolledBack: "deployment.RolledBack",
	DeploymentTransitionStarted: "deployment.TransitionStarted",
	DeploymentTransitionCompleted: "deployment.TransitionCompleted",
	DeploymentReopened: "deployment.Reopened",
	DeploymentClaimed: "deployment.Claimed",
	// Crypto-shred erasure REQUEST for a data subject (HOBO-295). Append-only —
	// historical events are never rewritten; projections redact the subject on
	// rebuild.
	SubjectErasureRequested: "subject.ErasureRequested",
	DeploymentImported: "deployment.Imported",
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

export interface ResourceProvisioningData {
	deploymentId: string;
	resourceId: string;
	execId: string;
	programHash: string;
	specHash?: string;
	providerId?: string;
	operationGeneration?: string;
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
	specHash?: string;
}

export function resourceProvisioned(data: ResourceProvisionedData): EventInput {
	return { type: CLOUD_EVENTS.ResourceProvisioned, data };
}

interface ResourceFailedBase {
	deploymentId: string;
	resourceId: string;
	reason: string;
}

export type ResourceFailedData = ResourceFailedBase &
	(
		| {
				classification: "retryable" | "fatal";
				crossedNoGoThreshold: boolean;
				requiresReconciliation?: false;
				reservationId?: never;
				reconciliationOperation?: never;
		  }
		| {
				classification: "fatal";
				crossedNoGoThreshold: false;
				requiresReconciliation: true;
				reservationId?: string;
				reconciliationOperation: "apply" | "destroy";
		  }
	);

export function resourceFailed(data: ResourceFailedData): EventInput {
	return { type: CLOUD_EVENTS.ResourceFailed, data };
}

export interface ResourceReconciledData {
	deploymentId: string;
	resourceId: string;
	failureEventId: string;
	operation: "apply" | "destroy";
	outcome: "applied" | "destroyed" | "no-effect";
	evidenceRef: string;
	financialEvidenceRef: string;
	financialDisposition: "none" | "held" | "settled" | "released";
	reservationId?: string;
	claimDigest: string;
	outputs?: Record<string, string>;
	execId?: string;
	specHash?: string;
	finalStateHash?: string;
	restoredState?: "provisioned" | "destroyed" | "failed";
}

export function resourceReconciled(data: ResourceReconciledData): EventInput {
	return { type: CLOUD_EVENTS.ResourceReconciled, data };
}

export interface ResourceDestroyingData {
	deploymentId: string;
	resourceId: string;
	reason: string;
	operationGeneration?: string;
	programHash?: string;
	specHash?: string;
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

export interface DeploymentTransitionData {
	deploymentId: string;
	transitionId: string;
	kind: "rollback" | "prune";
	planHash: string;
	resourceIds: string[];
	triggerResource?: string;
	reason?: string;
}

export function deploymentTransitionStarted(
	data: DeploymentTransitionData,
): EventInput {
	return { type: CLOUD_EVENTS.DeploymentTransitionStarted, data };
}

export function deploymentTransitionCompleted(
	data: DeploymentTransitionData,
): EventInput {
	return { type: CLOUD_EVENTS.DeploymentTransitionCompleted, data };
}

export function deploymentReopened(data: {
	deploymentId: string;
	rollbackEventId: string;
	planHash: string;
	resources: { resourceId: string; specHash: string }[];
}): EventInput {
	return { type: CLOUD_EVENTS.DeploymentReopened, data };
}
