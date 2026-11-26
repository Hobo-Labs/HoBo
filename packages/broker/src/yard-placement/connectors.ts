/**
 * Connector-backed Yard generation implementations (Azure / AWS / GCP / local).
 * Each connector emits structured progress suitable for provider fold resolvers.
 * No ambient credentials; no account farming.
 */

import type { JsonObject } from "../json.js";
import type { YardGenerationConnector } from "./generation.js";
import type {
	YardGenerationPlan,
	YardGenerationResult,
	YardLayout,
	YardRuntimeRegistration,
} from "./types.js";
import { contentHashOf, YARD_GENERATION_PLAN_SCHEMA } from "./types.js";

function basePlan(input: {
	readonly requestedLayout: YardLayout;
	readonly runtime: YardRuntimeRegistration;
	readonly ownerTenantId: string;
	readonly attemptId: string;
	readonly connectorId: string;
}): YardGenerationPlan {
	const layoutHash = contentHashOf(input.requestedLayout);
	const idempotencyKey = contentHashOf({
		ownerTenantId: input.ownerTenantId,
		layoutHash,
		runtimeId: input.runtime.runtimeId,
		runtimeVersion: input.runtime.version,
	});
	const expectedYardId = `yard:gen-${String(idempotencyKey).slice(7, 23)}`;
	const body = {
		schemaVersion: YARD_GENERATION_PLAN_SCHEMA,
		attemptId: input.attemptId,
		idempotencyKey,
		requestedLayout: input.requestedLayout,
		requestedLayoutHash: layoutHash,
		runtimeId: input.runtime.runtimeId,
		providerId: input.runtime.providerId,
		generatorConnectorId: input.connectorId,
		expectedYardId,
		requiredPermissions: input.runtime.requiredPermissions,
		credentialScopeRef: `scope://${input.connectorId}/${input.runtime.providerId}`,
		inputs: Object.freeze({
			ownerTenantId: input.ownerTenantId,
			providerId: input.runtime.providerId,
			runtimeId: input.runtime.runtimeId,
		}),
	};
	return Object.freeze({
		...body,
		planHash: contentHashOf(body),
	});
}

type AttemptState = {
	plan: YardGenerationPlan;
	result: YardGenerationResult;
	signals: Array<{ kind: string; payload: JsonObject }>;
};

/**
 * In-memory connector that simulates provider control-plane progression and
 * records signals for the provider event-store fold resolver.
 */
function createSimulatedConnector(options: {
	readonly id: string;
	readonly kind: string;
	readonly providerId: string;
	readonly progressKinds: readonly string[];
	readonly readyKind: string;
	readonly externalRefKeys: readonly string[];
}): YardGenerationConnector & {
	readonly signalsFor: (
		attemptId: string,
	) => readonly { kind: string; payload: JsonObject }[];
} {
	const attempts = new Map<string, AttemptState>();

	return {
		id: options.id,
		kind: options.kind,
		plan(input) {
			return basePlan({
				...input,
				connectorId: options.id,
			});
		},
		async provision(plan) {
			const signals: AttemptState["signals"] = [];
			for (const kind of options.progressKinds) {
				signals.push({
					kind,
					payload: {
						attemptId: plan.attemptId,
						idempotencyKey: plan.idempotencyKey,
						yardId: plan.expectedYardId,
						runtimeId: plan.runtimeId,
						...Object.fromEntries(
							options.externalRefKeys.map((k) => [
								k,
								`ref://${options.providerId}/${k}/${plan.attemptId.slice(0, 8)}`,
							]),
						),
					},
				});
			}
			signals.push({
				kind: options.readyKind,
				payload: {
					attemptId: plan.attemptId,
					idempotencyKey: plan.idempotencyKey,
					yardId: plan.expectedYardId,
					runtimeId: plan.runtimeId,
					ownerTenantId: String(plan.inputs.ownerTenantId ?? "local"),
					...Object.fromEntries(
						options.externalRefKeys.map((k) => [
							k,
							`ref://${options.providerId}/${k}/${plan.attemptId.slice(0, 8)}`,
						]),
					),
				},
			});

			const externalRefs = Object.fromEntries(
				options.externalRefKeys.map((k) => [
					k,
					`ref://${options.providerId}/${k}/${plan.attemptId.slice(0, 8)}`,
				]),
			);

			const result: YardGenerationResult = Object.freeze({
				attemptId: plan.attemptId,
				status: "ready",
				yardId: plan.expectedYardId,
				externalRefs: Object.freeze(externalRefs),
				outputHash: contentHashOf({
					attemptId: plan.attemptId,
					yardId: plan.expectedYardId,
					status: "ready",
				}),
			});
			attempts.set(plan.attemptId, { plan, result, signals });
			return result;
		},
		async inspect(attemptId) {
			const existing = attempts.get(attemptId);
			if (!existing) {
				return Object.freeze({
					attemptId,
					status: "failed",
					externalRefs: Object.freeze({}),
					outputHash: contentHashOf({ attemptId, missing: true }),
					failure: Object.freeze({
						code: "attempt-unknown",
						message: `no generation attempt ${attemptId}`,
						retryable: false,
					}),
				});
			}
			return existing.result;
		},
		async compensate(plan) {
			const result: YardGenerationResult = Object.freeze({
				attemptId: plan.attemptId,
				status: "failed",
				externalRefs: Object.freeze({}),
				outputHash: contentHashOf({
					attemptId: plan.attemptId,
					compensated: true,
				}),
				failure: Object.freeze({
					code: "compensated",
					message: "generation compensated",
					retryable: false,
				}),
			});
			const prior = attempts.get(plan.attemptId);
			attempts.set(plan.attemptId, {
				plan,
				result,
				signals: prior?.signals ?? [],
			});
			return result;
		},
		signalsFor(attemptId) {
			return Object.freeze([...(attempts.get(attemptId)?.signals ?? [])]);
		},
	};
}

export function createAzureYardGenerationConnector(): YardGenerationConnector & {
	readonly signalsFor: (
		attemptId: string,
	) => readonly { kind: string; payload: JsonObject }[];
} {
	return createSimulatedConnector({
		id: "connector:azure-yard-generator",
		kind: "azure",
		providerId: "azure",
		progressKinds: ["resourceGroup.created", "managedEnvironment.created"],
		readyKind: "managedEnvironment.ready",
		externalRefKeys: [
			"resourceGroup",
			"managedEnvironmentId",
			"subscriptionRef",
			"tenantRef",
		],
	});
}

export function createAwsYardGenerationConnector(): YardGenerationConnector & {
	readonly signalsFor: (
		attemptId: string,
	) => readonly { kind: string; payload: JsonObject }[];
} {
	return createSimulatedConnector({
		id: "connector:aws-yard-generator",
		kind: "aws",
		providerId: "aws",
		progressKinds: ["vpc.created", "ecs.cluster.created"],
		readyKind: "ecs.cluster.ready",
		externalRefKeys: ["vpcId", "clusterArn", "accountRef"],
	});
}

export function createGcpYardGenerationConnector(): YardGenerationConnector & {
	readonly signalsFor: (
		attemptId: string,
	) => readonly { kind: string; payload: JsonObject }[];
} {
	return createSimulatedConnector({
		id: "connector:gcp-yard-generator",
		kind: "gcp",
		providerId: "gcp",
		progressKinds: ["network.created", "cloudRun.service.created"],
		readyKind: "cloudRun.ready",
		externalRefKeys: ["network", "serviceName", "projectRef"],
	});
}

export function createLocalYardGenerationConnector(): YardGenerationConnector & {
	readonly signalsFor: (
		attemptId: string,
	) => readonly { kind: string; payload: JsonObject }[];
} {
	return createSimulatedConnector({
		id: "connector:local-yard-generator",
		kind: "local",
		providerId: "local",
		progressKinds: ["generation.started"],
		readyKind: "componentHost.ready",
		externalRefKeys: ["dataDir"],
	});
}

export function defaultYardGenerationConnectors(): Map<
	string,
	YardGenerationConnector
> {
	const azure = createAzureYardGenerationConnector();
	const aws = createAwsYardGenerationConnector();
	const gcp = createGcpYardGenerationConnector();
	const local = createLocalYardGenerationConnector();
	return new Map([
		[azure.id, azure],
		[aws.id, aws],
		[gcp.id, gcp],
		[local.id, local],
	]);
}
