import type {
	BindlePrimitive,
	CapabilityRequirement,
} from "@hobo/capability-profiles";

import type { RecipeSemantics } from "./recipe.js";

export type BindleCapabilityRequest = {
	readonly capabilityRef: string;
	readonly primitive: BindlePrimitive;
	readonly requirement: CapabilityRequirement;
};

export type CapabilityDependency = {
	readonly fromCapabilityRef: string;
	readonly toCapabilityRef: string;
};

export type DeploymentRequestInput = {
	readonly deploymentRef: string;
	readonly capabilities: readonly BindleCapabilityRequest[];
	readonly dependencies?: readonly CapabilityDependency[];
	readonly requestedSemantics: RecipeSemantics;
};

const deploymentRequestBrand: unique symbol = Symbol("DeploymentRequest");

export type DeploymentRequest = {
	readonly deploymentRef: string;
	readonly capabilities: readonly BindleCapabilityRequest[];
	readonly dependencies: readonly CapabilityDependency[];
	readonly requestedSemantics: RecipeSemantics;
	readonly [deploymentRequestBrand]: "DeploymentRequest";
};

export class DeploymentRequestError extends Error {
	readonly code = "INVALID_DEPLOYMENT_REQUEST" as const;

	constructor(message: string) {
		super(message);
		this.name = "DeploymentRequestError";
	}
}

const PROVIDER_PIN_PATTERN = /(provider|vendor|account|tenant)/iu;

export function parseDeploymentRequest(
	input: DeploymentRequestInput,
): DeploymentRequest {
	if (
		Object.prototype.toString.call(input.deploymentRef) !== "[object String]" ||
		input.deploymentRef.trim().length === 0
	) {
		throw new DeploymentRequestError(
			"deploymentRef must be a non-empty string",
		);
	}
	if (input.capabilities.length === 0) {
		throw new DeploymentRequestError(
			"a deployment request must ask for a capability",
		);
	}

	const byRef = new Map<string, BindleCapabilityRequest>();
	for (const capability of input.capabilities) {
		if (
			Object.prototype.toString.call(capability.capabilityRef) !==
				"[object String]" ||
			capability.capabilityRef.trim().length === 0
		) {
			throw new DeploymentRequestError(
				"capabilityRef must be a non-empty string",
			);
		}
		if (PROVIDER_PIN_PATTERN.test(capability.capabilityRef)) {
			throw new DeploymentRequestError(
				`capability ${capability.capabilityRef} names a provider; bindle capabilities stay provider-neutral`,
			);
		}
		if (byRef.has(capability.capabilityRef)) {
			throw new DeploymentRequestError(
				`capability ${capability.capabilityRef} is declared more than once`,
			);
		}
		byRef.set(capability.capabilityRef, capability);
	}

	const dependencies = new Map<string, CapabilityDependency>();
	for (const dependency of input.dependencies ?? []) {
		for (const end of [
			dependency.fromCapabilityRef,
			dependency.toCapabilityRef,
		]) {
			if (!byRef.has(end)) {
				throw new DeploymentRequestError(
					`dependency references unknown capability ${end}`,
				);
			}
		}
		if (dependency.fromCapabilityRef === dependency.toCapabilityRef) {
			throw new DeploymentRequestError(
				`capability ${dependency.fromCapabilityRef} cannot depend on itself`,
			);
		}
		dependencies.set(
			`${dependency.fromCapabilityRef}\u0000${dependency.toCapabilityRef}`,
			dependency,
		);
	}

	return {
		deploymentRef: input.deploymentRef,
		capabilities: [...byRef.values()].sort((a, b) =>
			a.capabilityRef.localeCompare(b.capabilityRef),
		),
		dependencies: [...dependencies.values()].sort(
			(a, b) =>
				a.fromCapabilityRef.localeCompare(b.fromCapabilityRef) ||
				a.toCapabilityRef.localeCompare(b.toCapabilityRef),
		),
		requestedSemantics: { ...input.requestedSemantics },
		[deploymentRequestBrand]: "DeploymentRequest",
	};
}
