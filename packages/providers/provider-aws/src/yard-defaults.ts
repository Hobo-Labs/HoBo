/**
 * AWS provider-owned Yard runtime + primitive resolver defaults.
 * Generation requires Broker policy approval (default deny).
 */

// public-contract: the Yard runtime this provider registers under. Stations and
// the Broker match registrations by this exact string, so changing it silently
// unregisters every Yard already placed on it.
export const AWS_YARD_RUNTIME_ID = "aws.yard-runtime/v1" as const;
// public-contract: the connector id Broker policy is written against. Generation
// is default-deny, so a rename does not fail open — it stops matching the
// approval that let this provider generate Yards at all.
export const AWS_YARD_GENERATOR_CONNECTOR_ID =
	"connector:aws-yard-generator" as const;

export function awsYardRuntimeRegistration(options?: {
	readonly status?: "registered" | "approved" | "disabled";
	readonly priority?: number;
}): {
	readonly schemaVersion: "hobo.yard-runtime/v1";
	readonly runtimeId: typeof AWS_YARD_RUNTIME_ID;
	readonly providerId: "aws";
	readonly version: string;
	readonly supportedCatalog: {
		readonly regions: readonly string[];
		readonly capabilities: readonly string[];
		readonly requireProperties: readonly string[];
	};
	readonly resolverCatalogHash: `sha256:${string}`;
	readonly generatorConnectorId: typeof AWS_YARD_GENERATOR_CONNECTOR_ID;
	readonly generatorKind: "aws";
	readonly default: boolean;
	readonly priority: number;
	readonly requiredPermissions: readonly string[];
	readonly conformanceRef: string;
	readonly conformanceHash: `sha256:${string}`;
	readonly status: "registered" | "approved" | "disabled";
} {
	return Object.freeze({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: AWS_YARD_RUNTIME_ID,
		providerId: "aws",
		version: "1.0.0",
		supportedCatalog: Object.freeze({
			regions: Object.freeze(["us-east-1", "us-west-2", "eu-west-1"]),
			capabilities: Object.freeze([
				"managed-container-substrate",
				"private-network",
				"managed-http-runtime",
			]),
			requireProperties: Object.freeze(["aws.accountRef"]),
		}),
		resolverCatalogHash: "sha256:aws-resolvers-v1",
		generatorConnectorId: AWS_YARD_GENERATOR_CONNECTOR_ID,
		generatorKind: "aws",
		default: true,
		priority: options?.priority ?? 100,
		requiredPermissions: Object.freeze(["ecs:CreateCluster", "ec2:CreateVpc"]),
		conformanceRef: "hobo://conformance/aws-yard/v1",
		conformanceHash: "sha256:aws-yard-conformance-v1",
		status: options?.status ?? "approved",
	});
}

export function awsDefaultResolverPins(): readonly {
	readonly slot: string;
	readonly resolverId: string;
}[] {
	return Object.freeze([
		Object.freeze({ slot: "scope", resolverId: "aws.yard.scope/v1" }),
		Object.freeze({
			slot: "substrate",
			resolverId: "aws.camp.ecs-cluster/v1",
		}),
		Object.freeze({
			slot: "workload",
			resolverId: "aws.bindle.fargate/v1",
		}),
		Object.freeze({ slot: "network", resolverId: "aws.yard.vpc/v1" }),
		Object.freeze({
			slot: "event-store",
			resolverId: "aws.yard.event-store/v1",
		}),
	]);
}
