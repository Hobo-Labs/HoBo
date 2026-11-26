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
	type EbsVolumeOptions,
	ECS_LAUNCH_TYPES,
	type Ec2InstanceOptions,
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
	ebsVolume,
	ec2Instance,
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

// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(aws, …).
export const PROVIDER_ID = "aws";

export const DEFAULT_AWS_YARD_NAME = "aws";

export interface AwsYardOptions
	extends ComposedYardOptions,
		AwsYardSpecOptions {}

export function Yard(options: AwsYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_AWS_YARD_NAME,
		awsYardSpec(regionOption(options.regions)),
		options,
	);
}
