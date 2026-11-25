/** Derived from packages/core/data-models/capability_enforcement.proto + .cue */

import type { JsonObject } from "../json.js";

export type CapabilityDenialCode =
	| "capability.import-not-declared"
	| "capability.export-not-found"
	| "capability.no-inferred-grant"
	| "capability.operation-not-granted"
	| "capability.no-linked-route"
	| "capability.fabricated-handle"
	| "capability.operation-not-found"
	| "capability.component-not-registered"
	| "capability.provider-not-registered";

export type CapabilityDiagnosticCode =
	| CapabilityDenialCode
	| "capability.allow.narrow-below-usage"
	| "capability.usage.cannot-prove-operation";

export type DiagnosticSeverity = "error" | "warning" | "info";

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface CapabilityGrant {
	componentId: string;
	importInterface: string;
	resource: string;
	operations: readonly string[];
}

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface CapabilityUsage {
	inferred: readonly string[];
	source: "static-analysis";
}

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface CapabilityDiagnostic {
	code: CapabilityDiagnosticCode;
	severity: DiagnosticSeverity;
	resource: string;
	message: string;
	fileName: string;
	line: number;
	allowedOperations?: readonly string[];
	observedOperations?: readonly string[];
	operationPrefix?: string;
}

export interface InferredResourceUsage {
	resource: string;
	factory: string;
	port?: string;
	declaredAllow: readonly string[];
	operations: readonly string[];
}

export interface CapabilityUsageResult {
	ok: boolean;
	resources: readonly InferredResourceUsage[];
	diagnostics: readonly CapabilityDiagnostic[];
}

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface GrantEvaluation {
	schema: "hobo.capability-enforcement/v1";
	ok: boolean;
	canDeployDimension: "capabilityGrants";
	diagnostics: readonly CapabilityDiagnostic[];
	manifest: JsonObject;
	grants: readonly CapabilityGrant[];
}

export interface LinkEstablishedEvent {
	type: "link.Established";
	componentId: string;
	importInterface: string;
	providerId: string;
	exportInterface: string;
	transport: "in-process";
	grantSource: "usage-inferred";
}

export interface LinkCalledEvent {
	type: "link.Called";
	componentId: string;
	importInterface: string;
	providerId: string;
	exportInterface: string;
	operation: string;
	resource: string;
	grantSource: "usage-inferred";
	transport: "in-process";
}

export interface CapabilityGrantDeniedEvent {
	type: "capability.GrantDenied";
	reason: CapabilityDenialCode;
	componentId?: string;
	importInterface?: string;
	operation?: string;
	resource?: string;
	providerId?: string;
	exportInterface?: string;
}

export type CapabilityLinkTableEvent =
	| LinkEstablishedEvent
	| LinkCalledEvent
	| CapabilityGrantDeniedEvent;
