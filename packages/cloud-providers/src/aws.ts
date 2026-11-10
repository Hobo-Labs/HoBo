/**
 * AWS: the default Yard, plus the slot factories for authoring your own.
 *
 * `Yard()` returns everything AWS *can* allocate — a catalog, not a selection.
 * Which offering a given resource gets is decided later, by ADR-0151 selection,
 * against the requirements the app actually states.
 *
 * HONEST SCOPE: `@hobo/provider-aws` ships resolvers for part of this
 * catalog (`AWS_RESOLVED_PRODUCT_IDS`; the rest, with reasons, in
 * `AWS_UNRESOLVED_PRODUCT_IDS`), proven only against an injected fake
 * transport. The current count is `providerParity()` in `./parity.js`, derived from
 * those constants rather than restated here, because a restated count drifts.
 * No Resource Definitions are registered for the `aws.*` product ids, so a
 * deploy against this Yard still fails closed at resolution.
 */
import { type AwsYardSpecOptions, awsYardSpec } from "@hobo/provider-aws";
import type { Yard as ParsedYard } from "@hobo/yards";

import {
	type ComposedYardOptions,
	composeYard,
	regionOption,
} from "./compose.js";

export {
	type AmplifyHostingOptions,
	API_GATEWAY_PROTOCOLS,
	APP_RUNNER_EGRESS,
	type ApiGatewayOptions,
	type ApiGatewayProtocol,
	type AppRunnerEgress,
	type AppRunnerOptions,
	type AuroraServerlessOptions,
	amplifyHosting,
	apiGateway,
	appRunner,
	auroraServerlessPostgres,
	CLOUDFRONT_PRICE_CLASSES,
	type CloudfrontPriceClass,
	type CloudfrontSiteOptions,
	cloudfrontSite,
	DYNAMODB_BILLING_MODES,
	type DynamodbBillingMode,
	type DynamodbOptions,
	dynamodb,
	dynamodbDocument,
	ECS_LAUNCH_TYPES,
	type EcsLaunchType,
	type EcsServiceOptions,
	type EcsTaskOptions,
	EKS_SERVICE_TYPES,
	type EksDeploymentOptions,
	type EksResourceQuantities,
	type EksServiceType,
	ELASTICACHE_ENGINES,
	type ElasticacheEngine,
	type ElasticacheRedisOptions,
	ecs,
	eks,
	elasticacheRedis,
	LAMBDA_ARCHITECTURES,
	type LambdaArchitecture,
	type LambdaOptions,
	lambda,
	type RdsMysqlOptions,
	type RdsPostgresOptions,
	rds,
	S3_STORAGE_CLASSES,
	type S3Options,
	type S3StorageClass,
	type SecretsManagerOptions,
	type SnsOptions,
	type SqsOptions,
	SSM_PARAMETER_TIERS,
	type SsmParameterStoreOptions,
	type SsmParameterTier,
	s3,
	secretsManager,
	sns,
	sqs,
	sqsFifo,
	ssmParameterStore,
} from "@hobo/provider-aws";

/**
 * This namespace's provider id, read when it is passed to `yard(aws, …)`.
 *
 * A provider is stated, never inferred: without this the builder would have
 * to guess one from a Yard name or a product-id prefix, which is exactly the
 * load-bearing naming convention ADR-0144 forbids.
 */
// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(aws, …).
export const PROVIDER_ID = "aws";

/** Yard name used when the caller does not supply one. */
// public-contract: the name every default AWS Yard is registered under; changing it renames them all.
export const DEFAULT_AWS_YARD_NAME = "aws";

export interface AwsYardOptions
	extends ComposedYardOptions,
		AwsYardSpecOptions {}

/** The default AWS Yard: the full allocatable catalog, parsed and canonical. */
export function Yard(options: AwsYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_AWS_YARD_NAME,
		awsYardSpec(regionOption(options.regions)),
		options,
	);
}
