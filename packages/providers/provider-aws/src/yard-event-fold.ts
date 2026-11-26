/**
 * AWS event-store fold resolver for Yard placement / generation.
 * Normalizes ECS/VPC/control-plane signals into yard.* facts.
 */

import { isJsonArray, type JsonObject } from "./json.js";

// public-contract: the event-store fold this provider is addressed by. Stored
// events name the resolver that produced them, so a rename orphans every fact
// already written under the old id.
export const AWS_EVENT_STORE_RESOLVER_ID = "aws.yard.event-store/v1" as const;

export interface AwsProviderNativeSignal {
	readonly providerId: "aws";
	readonly kind: string;
	readonly payload: JsonObject;
	readonly observedAt?: string;
}

export interface AwsYardEvent {
	readonly type: string;
	readonly data: JsonObject;
	readonly occurredAt?: string;
}

export function normalizeAwsYardSignal(
	signal: AwsProviderNativeSignal,
): readonly AwsYardEvent[] {
	const at = signal.observedAt ?? new Date().toISOString();
	const p = signal.payload;
	switch (signal.kind) {
		case "vpc.created":
		case "ec2:CreateVpc":
			return [
				{
					type: "yard.GenerationProgressed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "aws",
						status: "started",
						externalRefs: {
							vpcId: String(p.vpcId ?? p.id ?? ""),
							accountRef: String(p.accountRef ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "ecs.cluster.created":
		case "ecs:CreateCluster":
			return [
				{
					type: "yard.GenerationProvisioned",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "aws",
						yardId: String(p.yardId ?? p.clusterArn ?? ""),
						externalRefs: {
							clusterArn: String(p.clusterArn ?? p.id ?? ""),
							vpcId: String(p.vpcId ?? ""),
						},
					},
					occurredAt: at,
				},
			];
		case "ecs.cluster.ready":
			return [
				{
					type: "yard.Registered",
					data: { yard: awsYardFromPayload(p) },
					occurredAt: at,
				},
				{
					type: "yard.AttestationStarted",
					data: { yardId: String(p.yardId ?? p.clusterArn ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Attested",
					data: { yardId: String(p.yardId ?? p.clusterArn ?? "") },
					occurredAt: at,
				},
				{
					type: "yard.Ready",
					data: {
						yardId: String(p.yardId ?? p.clusterArn ?? ""),
						attemptId: String(p.attemptId ?? ""),
					},
					occurredAt: at,
				},
			];
		case "generation.failed":
			return [
				{
					type: "yard.GenerationFailed",
					data: {
						attemptId: String(p.attemptId ?? ""),
						idempotencyKey: String(p.idempotencyKey ?? ""),
						providerId: "aws",
						failure: {
							code: String(p.code ?? "aws-generation-failed"),
							message: String(p.message ?? "AWS yard generation failed"),
							retryable: p.retryable === true,
						},
					},
					occurredAt: at,
				},
			];
		default:
			return [
				{
					type: "yard.ProviderSignalNormalized",
					data: {
						providerId: "aws",
						kind: signal.kind,
						payload: p,
					},
					occurredAt: at,
				},
			];
	}
}

export function awsEventStoreFoldDescriptor() {
	return Object.freeze({
		schemaVersion: "hobo.primitive-resolver/v1" as const,
		id: AWS_EVENT_STORE_RESOLVER_ID,
		version: "1",
		providerId: "aws" as const,
		primitiveKind: "yard" as const,
		slot: "event-store" as const,
		additive: false,
		source: "provider-default" as const,
		default: true,
		priority: 200,
		requiresCapabilities: Object.freeze(["event-store"]),
		providesCapabilities: Object.freeze([
			"event-store",
			"yard-inventory-fold",
			"yard-generation-fold",
			"aws.control-plane-signal-normalize",
		]),
		implementationRef: "aws/resolvers/event-store-fold",
		remediation:
			"Register aws.yard.event-store/v1 for Yard event-store folds on AWS Yards",
	});
}

function awsYardFromPayload(p: JsonObject) {
	const yardId = String(p.yardId ?? p.clusterArn ?? "yard:aws");
	const now = new Date().toISOString();
	return {
		schemaVersion: "hobo.yard-instance/v1",
		yardId,
		ownerTenantId: String(p.ownerTenantId ?? "local"),
		providerId: "aws",
		runtimeId: String(p.runtimeId ?? "aws.yard-runtime/v1"),
		layout: {
			providerId: "aws",
			regions: isJsonArray(p.regions) ? p.regions.map(String) : ["us-east-1"],
			require: ["managed-container-substrate", "private-network"],
			prefer: [],
			residency: [],
			isolation: [],
			network: ["private"],
			componentHosts: [],
			labels: {},
			properties: {
				...(p.accountRef ? { "aws.accountRef": p.accountRef } : undefined),
				...(p.vpcId ? { "aws.vpcId": p.vpcId } : undefined),
			},
			camps: [],
		},
		capabilities: [
			"managed-container-substrate",
			"private-network",
			"managed-http-runtime",
		],
		status: "registering",
		health: { observedAt: now, generation: 1, signals: ["registered"] },
		capacity: { classes: { default: 100 }, reservations: {} },
		registryCatalogHash: "sha256:aws-registry",
		resolverCatalogHash: "sha256:aws-resolvers-v1",
		conformanceHash: "sha256:aws-yard-conformance-v1",
		labels: {},
		registrationSeq: 1,
	};
}
