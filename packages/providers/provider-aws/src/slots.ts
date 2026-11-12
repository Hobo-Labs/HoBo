/**
 * Typed AWS offering factories for Yard slot bindings.
 *
 * Why this module exists: authoring a slot binding by hand means typing a
 * capability-profile string, a product id, and an untyped property bag — three
 * independent chances to make a typo that only surfaces at resolution time.
 * Each factory here owns exactly one `(slot, profile, productId)` triple and
 * takes a per-product options interface, so the profile string is never typed
 * by an operator and a misspelled option name is a compile error.
 *
 * Every factory returns `slotBinding()` from `@hobo/core`; none of them build a
 * binding record by hand. The core parse boundary — credential screening,
 * JSON-safety, freezing, key ordering — therefore applies to every binding
 * produced here, and this module adds no parse rules of its own.
 *
 * No defaults are invented. A default replica count or instance class quietly
 * deployed on the caller's behalf would misreport what they asked for, so an
 * omitted option is simply absent from `properties` and the Resource
 * Definition decides.
 *
 * HONEST SCOPE: the `productId` values below are the ids these factories
 * *emit*. Whether a matching Resource Definition is registered in the catalog
 * is checked at resolution time (`YARD_BINDING_PRODUCT_UNKNOWN`), not here — a
 * successful call is not evidence that the product exists in the catalog
 * today, and several of these products are not registered yet.
 */
import { capability, type SlotBinding, slotBinding } from "@hobo/core";

/**
 * Forwards the caller's option bag to the parse boundary, dropping only keys
 * whose value is `undefined` (an omitted option must be absent, not an
 * explicit `undefined`, under `exactOptionalPropertyTypes` and JSON-safety).
 *
 * Every remaining key is passed through — including one the option types do
 * not declare — so a key smuggled past the types reaches `slotBinding()` and
 * is screened there. Cherry-picking the known keys instead would silently
 * swallow it, which is exactly the kind of quiet drop this repo refuses.
 */
function present(options: AnySlotOptions) {
	const out = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) Object.assign(out, { [key]: value });
	}
	return out;
}

/** Amazon S3 storage classes this factory can request. */
export const S3_STORAGE_CLASSES = Object.freeze([
	"standard",
	"intelligent-tiering",
	"glacier-ir",
] as const);

export type S3StorageClass = (typeof S3_STORAGE_CLASSES)[number];

export interface S3Options {
	readonly versioning?: boolean;
	readonly publicAccessBlocked?: boolean;
	readonly storageClass?: S3StorageClass;
}

/** Amazon S3 bucket — slot `bucket`, profile `bucket.s3-compatible/v1`. */
export function s3(options?: S3Options): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.s3Compatible,
		productId: "aws.s3/v1",
		properties: present(options ?? {}),
	});
}

export interface RdsPostgresOptions {
	readonly instanceClass?: string;
	readonly multiAz?: boolean;
	readonly storageGb?: number;
	readonly engineVersion?: string;
}

/** Amazon RDS for PostgreSQL — slot `data`, profile `data.postgres/v1`. */
function rdsPostgres(options?: RdsPostgresOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.postgres,
		productId: "aws.rds-postgres/v1",
		properties: present(options ?? {}),
	});
}

export interface RdsMysqlOptions {
	readonly instanceClass?: string;
	readonly multiAz?: boolean;
	readonly storageGb?: number;
	readonly engineVersion?: string;
}

/** Amazon RDS for MySQL — slot `data`, profile `data.mysql/v1`. */
function rdsMysql(options?: RdsMysqlOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.mysql,
		productId: "aws.rds-mysql/v1",
		properties: present(options ?? {}),
	});
}

/** RDS engine namespace, so the call site reads `rds.postgres({ … })`. */
export const rds = Object.freeze({ postgres: rdsPostgres, mysql: rdsMysql });

export interface AuroraServerlessOptions {
	readonly minCapacity?: number;
	readonly maxCapacity?: number;
	readonly engineVersion?: string;
}

/**
 * Aurora Serverless v2 (PostgreSQL-compatible) — slot `data`, profile
 * `data.postgres/v1`. It satisfies the same profile as RDS PostgreSQL and sits
 * beside it in the catalog rather than replacing it: which one a workload gets
 * is a selection decision, not a catalog one.
 */
export function auroraServerlessPostgres(
	options?: AuroraServerlessOptions,
): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.postgres,
		productId: "aws.aurora-serverless-postgres/v1",
		properties: present(options ?? {}),
	});
}

/**
 * Amazon DynamoDB as a document store — slot `data`, profile
 * `data.document/v1`. Same product as the `kv` entry below, reached through a
 * different capability profile; rows key on `(profile, productId)`, so both
 * coexist without colliding.
 */
export function dynamodbDocument(options?: DynamodbOptions): SlotBinding {
	return slotBinding({
		slot: "data",
		profile: capability.data.document,
		productId: "aws.dynamodb/v1",
		properties: present(options ?? {}),
	});
}

/** ElastiCache engines this factory can request. */
export const ELASTICACHE_ENGINES = Object.freeze(["redis", "valkey"] as const);

export type ElasticacheEngine = (typeof ELASTICACHE_ENGINES)[number];

export interface ElasticacheRedisOptions {
	readonly nodeType?: string;
	readonly engine?: ElasticacheEngine;
	readonly replicas?: number;
}

/**
 * Amazon ElastiCache (Redis/Valkey) — slot `kv`, profile
 * `kv.redis-compatible/v1`.
 */
export function elasticacheRedis(
	options?: ElasticacheRedisOptions,
): SlotBinding {
	return slotBinding({
		slot: "kv",
		profile: capability.kv.redisCompatible,
		productId: "aws.elasticache-redis/v1",
		properties: present(options ?? {}),
	});
}

/** DynamoDB billing modes this factory can request. */
export const DYNAMODB_BILLING_MODES = Object.freeze([
	"on-demand",
	"provisioned",
] as const);

export type DynamodbBillingMode = (typeof DYNAMODB_BILLING_MODES)[number];

export interface DynamodbOptions {
	readonly billingMode?: DynamodbBillingMode;
	readonly readCapacity?: number;
	readonly writeCapacity?: number;
}

/** Amazon DynamoDB table — slot `kv`, profile `kv.key-value/v1`. */
export function dynamodb(options?: DynamodbOptions): SlotBinding {
	return slotBinding({
		slot: "kv",
		profile: capability.kv.keyValue,
		productId: "aws.dynamodb/v1",
		properties: present(options ?? {}),
	});
}

export interface SqsOptions {
	readonly fifo?: boolean;
	readonly visibilityTimeoutSeconds?: number;
	readonly maxReceiveCount?: number;
}

/** Amazon SQS queue — slot `queue`, profile `queue.at-least-once/v1`. */
export function sqs(options?: SqsOptions): SlotBinding {
	return slotBinding({
		slot: "queue",
		profile: capability.queue.atLeastOnce,
		productId: "aws.sqs/v1",
		properties: present(options ?? {}),
	});
}

/** Kubernetes service types an EKS deployment can front itself with. */
export const EKS_SERVICE_TYPES = Object.freeze([
	"ClusterIP",
	"LoadBalancer",
	"NodePort",
] as const);

export type EksServiceType = (typeof EKS_SERVICE_TYPES)[number];

/** Container compute quantities, kept as authored strings (`"500m"`, `"1Gi"`). */
export interface EksResourceQuantities {
	readonly cpu?: string;
	readonly memory?: string;
}

export interface EksDeploymentOptions {
	readonly replicas?: number;
	readonly service?: EksServiceType;
	readonly limits?: EksResourceQuantities;
	readonly requests?: EksResourceQuantities;
	readonly image?: string;
}

/** EKS Deployment + Service — slot `web`, profile `web.hosted/v1`. */
function eksDeployment(options?: EksDeploymentOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "aws.eks-deployment/v1",
		properties: present(options ?? {}),
	});
}

/** EKS workload namespace, so the call site reads `eks.deployment({ … })`. */
export const eks = Object.freeze({ deployment: eksDeployment });

/** Lambda instruction set architectures this factory can request. */
export const LAMBDA_ARCHITECTURES = Object.freeze(["x86_64", "arm64"] as const);

export type LambdaArchitecture = (typeof LAMBDA_ARCHITECTURES)[number];

export interface LambdaOptions {
	readonly ownershipRef?: string;
	readonly artifactDigest?: string;
	/** Immutable ECR container image URI, including its sha256 digest. */
	readonly image?: string;
	/** Existing execution role; credentials and implicit IAM creation are forbidden. */
	readonly executionRoleArn?: string;
	readonly memoryMb?: number;
	readonly timeoutSeconds?: number;
	readonly reservedConcurrency?: number;
	readonly architecture?: LambdaArchitecture;
}

/** AWS Lambda function — slot `service`, profile `service.worker/v1`. */
export function lambda(options?: LambdaOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "aws.lambda/v1",
		properties: present(options ?? {}),
	});
}

/** How an App Runner service accepts traffic. */
export const APP_RUNNER_EGRESS = Object.freeze(["default", "vpc"] as const);

export type AppRunnerEgress = (typeof APP_RUNNER_EGRESS)[number];

export interface AppRunnerOptions {
	readonly cpu?: string;
	readonly memory?: string;
	readonly egress?: AppRunnerEgress;
	readonly image?: string;
}

/** AWS App Runner service — slot `web`, profile `web.hosted/v1`. */
export function appRunner(options?: AppRunnerOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "aws.app-runner/v1",
		properties: present(options ?? {}),
	});
}

/** ECS launch types this factory can request. */
export const ECS_LAUNCH_TYPES = Object.freeze(["fargate", "ec2"] as const);

export type EcsLaunchType = (typeof ECS_LAUNCH_TYPES)[number];

export interface EcsServiceOptions {
	readonly launchType?: EcsLaunchType;
	readonly desiredCount?: number;
	readonly cpu?: string;
	readonly memory?: string;
	readonly image?: string;
}

/** Amazon ECS service — slot `web`, profile `web.hosted/v1`. */
function ecsService(options?: EcsServiceOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "aws.ecs-service/v1",
		properties: present(options ?? {}),
	});
}

export interface EcsTaskOptions {
	readonly launchType?: EcsLaunchType;
	readonly cpu?: string;
	readonly memory?: string;
	readonly image?: string;
}

/** Amazon ECS one-shot task — slot `service`, profile `service.batch/v1`. */
function ecsTask(options?: EcsTaskOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.batch,
		productId: "aws.ecs-task/v1",
		properties: present(options ?? {}),
	});
}

/** ECS workload namespace, so the call site reads `ecs.service({ … })`. */
export const ecs = Object.freeze({ service: ecsService, task: ecsTask });

export interface AmplifyHostingOptions {
	readonly branch?: string;
	readonly framework?: string;
}

/** AWS Amplify Hosting — slot `web`, profile `web.hosted/v1`. */
export function amplifyHosting(options?: AmplifyHostingOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.hosted,
		productId: "aws.amplify-hosting/v1",
		properties: present(options ?? {}),
	});
}

/** CloudFront price classes this factory can request. */
export const CLOUDFRONT_PRICE_CLASSES = Object.freeze([
	"all",
	"200",
	"100",
] as const);

export type CloudfrontPriceClass = (typeof CLOUDFRONT_PRICE_CLASSES)[number];

export interface CloudfrontSiteOptions {
	readonly priceClass?: CloudfrontPriceClass;
	readonly defaultRootObject?: string;
	readonly compress?: boolean;
}

/**
 * S3 origin behind CloudFront — slot `web`, profile `web.static/v1`. A static
 * site is a narrower profile than `web.hosted/v1`, so this sits beside the
 * hosted options rather than competing with them.
 */
export function cloudfrontSite(options?: CloudfrontSiteOptions): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: capability.web.static,
		productId: "aws.cloudfront-site/v1",
		properties: present(options ?? {}),
	});
}

/** API Gateway protocols this factory can request. */
export const API_GATEWAY_PROTOCOLS = Object.freeze(["http", "rest"] as const);

export type ApiGatewayProtocol = (typeof API_GATEWAY_PROTOCOLS)[number];

export interface ApiGatewayOptions {
	readonly protocol?: ApiGatewayProtocol;
	readonly stage?: string;
	readonly throttleBurst?: number;
	readonly throttleRate?: number;
}

/** Amazon API Gateway — slot `api`, profile `api.http/v1`. */
export function apiGateway(options?: ApiGatewayOptions): SlotBinding {
	return slotBinding({
		slot: "api",
		profile: capability.api.http,
		productId: "aws.api-gateway/v1",
		properties: present(options ?? {}),
	});
}

/**
 * Amazon SQS FIFO queue — slot `queue`, profile `queue.fifo/v1`. Ordered
 * delivery is a different capability profile from `sqs()`'s at-least-once, so
 * it is its own catalog row rather than an option on that one.
 */
export function sqsFifo(options?: SqsOptions): SlotBinding {
	return slotBinding({
		slot: "queue",
		profile: capability.queue.fifo,
		productId: "aws.sqs-fifo/v1",
		properties: present(options ?? {}),
	});
}

export interface SnsOptions {
	readonly fifo?: boolean;
	readonly contentBasedDeduplication?: boolean;
}

/** Amazon SNS topic — slot `topic`, profile `topic.pubsub/v1`. */
export function sns(options?: SnsOptions): SlotBinding {
	return slotBinding({
		slot: "topic",
		profile: capability.topic.pubsub,
		productId: "aws.sns/v1",
		properties: present(options ?? {}),
	});
}

export interface SecretsManagerOptions {
	readonly rotationDays?: number;
	readonly kmsKeyRef?: string;
	/**
	 * Restore the secret if it is scheduled for deletion. Without it, apply
	 * refuses a secret that is scheduled for deletion and says so. A directive,
	 * not state: it changes what apply does, never what the secret is, so
	 * preview and drift do not compare it (ADR-0175).
	 */
	readonly restoreScheduled?: boolean;
	/**
	 * Delete without a recovery window (`ForceDeleteWithoutRecovery`), also for
	 * a secret already scheduled for deletion. The secret and its versions are
	 * gone at once and cannot be restored. Without it, delete schedules the
	 * deletion with AWS's default 30-day recovery window. A directive, not
	 * state: it changes only what delete does (ADR-0175).
	 */
	readonly forceDelete?: boolean;
}

/**
 * AWS Secrets Manager — slot `secretRef`, profile `secret-ref.locator/v1`.
 * The row names where secrets live; it never carries material, and a
 * credential-shaped option is refused at the core parse boundary.
 */
export function secretsManager(options?: SecretsManagerOptions): SlotBinding {
	return slotBinding({
		slot: "secretRef",
		profile: capability.secretRef.locator,
		productId: "aws.secrets-manager/v1",
		properties: present(options ?? {}),
	});
}

/** SSM parameter tiers this factory can request. */
export const SSM_PARAMETER_TIERS = Object.freeze([
	"standard",
	"advanced",
] as const);

export type SsmParameterTier = (typeof SSM_PARAMETER_TIERS)[number];

export interface SsmParameterStoreOptions {
	readonly tier?: SsmParameterTier;
	readonly kmsKeyRef?: string;
}

/**
 * AWS Systems Manager Parameter Store — slot `secretRef`, profile
 * `secret-ref.locator/v1`. A cheaper locator than Secrets Manager for the same
 * capability, so both are declared and selection picks.
 */
export function ssmParameterStore(
	options?: SsmParameterStoreOptions,
): SlotBinding {
	return slotBinding({
		slot: "secretRef",
		profile: capability.secretRef.locator,
		productId: "aws.ssm-parameter-store/v1",
		properties: present(options ?? {}),
	});
}

type AnySlotOptions =
	| Ec2InstanceOptions
	| EbsVolumeOptions
	| S3Options
	| RdsPostgresOptions
	| RdsMysqlOptions
	| AuroraServerlessOptions
	| DynamodbOptions
	| ElasticacheRedisOptions
	| SqsOptions
	| EksDeploymentOptions
	| EksResourceQuantities
	| LambdaOptions
	| AppRunnerOptions
	| EcsServiceOptions
	| EcsTaskOptions
	| AmplifyHostingOptions
	| CloudfrontSiteOptions
	| ApiGatewayOptions
	| SnsOptions
	| SecretsManagerOptions
	| SsmParameterStoreOptions;

export interface Ec2InstanceOptions {
	/** An instance type such as `t4g.small`. */
	readonly instanceType?: string;
	readonly architecture?: "x86_64" | "arm64";
	readonly imageId?: string;
	readonly subnet?: string;
}

/**
 * Amazon EC2 instance — slot `service`, profile `service.worker/v1`: a long-running
 * virtual machine. Catalog only: this package ships no resolver for it. It is
 * deliberately not also listed under `web.hosted/v1`; a VM can host a web
 * origin, but that row is left for the change that models its public address.
 */
export function ec2Instance(options?: Ec2InstanceOptions): SlotBinding {
	return slotBinding({
		slot: "service",
		profile: capability.service.worker,
		productId: "aws.ec2-instance/v1",
		properties: present(options ?? {}),
	});
}

export interface EbsVolumeOptions {
	readonly sizeGb?: number;
	/** A volume type such as `gp3`. */
	readonly volumeType?: string;
	readonly iops?: number;
	readonly encrypted?: boolean;
}

/**
 * Amazon EBS volume — slot `bucket`, profile `bucket.filesystem/v1`. A block
 * device formatted and attached to one virtual machine has hierarchical path
 * semantics, which is `bucket.filesystem/v1`. Catalog only: this package ships
 * no resolver for it.
 */
export function ebsVolume(options?: EbsVolumeOptions): SlotBinding {
	return slotBinding({
		slot: "bucket",
		profile: capability.bucket.filesystem,
		productId: "aws.ebs-volume/v1",
		properties: present(options ?? {}),
	});
}
