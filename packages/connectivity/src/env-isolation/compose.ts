import type { TenantId } from "@hobo/core";

import type { TenantIsolationRegistry } from "../tenancy/isolation.js";
import type { EnvNetworkIsolationRegistry } from "./registry.js";
import type { IsolationClass } from "./types.js";

export type ComposedIsolationVerdict = Readonly<{
	isolated: boolean;
	reason: string;
	axis?: "tenant" | "environment" | "both";
}>;

export function assertComposedIsolation(input: {
	readonly tenants: TenantIsolationRegistry;
	readonly envs: EnvNetworkIsolationRegistry;
	readonly tenantA: TenantId | string;
	readonly tenantB: TenantId | string;
	readonly envA: IsolationClass;
	readonly envB: IsolationClass;
}): ComposedIsolationVerdict {
	const tenant = input.tenants.assertNetworkIsolation(
		input.tenantA,
		input.tenantB,
	);
	const env = input.envs.assertEnvironmentIsolation(input.envA, input.envB);

	if (tenant.isolated && env.isolated) {
		return {
			isolated: true,
			reason: `tenant: ${tenant.reason}; env: ${env.reason}`,
			axis: "both",
		};
	}
	if (tenant.isolated) {
		return {
			isolated: true,
			reason: tenant.reason,
			axis: "tenant",
		};
	}
	if (env.isolated) {
		return {
			isolated: true,
			reason: env.reason,
			axis: "environment",
		};
	}
	return {
		isolated: false,
		reason: "no hard isolation; PolicyEngine soft floor applies",
	};
}
