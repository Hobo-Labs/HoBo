// AWS equivalence classes: the cross-cloud equivalence-table row for AWS
// (control-plane.md §Cross-cloud equivalence classes) shipped as this
// provider's default Resource Definitions (HOBO-93 model / ADR-0090).
export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "aws:fargate-service",
		providerService: "Fargate",
		features: ["container", "http", "autoscaling", "managed"],
	},
	kv: {
		port: "kv",
		resourceClass: "aws:dynamodb-table",
		providerService: "DynamoDB",
		features: ["key-value", "durable", "serverless"],
	},
	objectStore: {
		port: "objectStore",
		resourceClass: "aws:s3-bucket",
		providerService: "S3",
		features: ["durable", "s3-compatible", "versioned"],
	},
	"database/postgres": {
		port: "database",
		resourceClass: "aws:rds-postgres",
		providerService: "RDS PostgreSQL",
		features: ["postgres", "relational", "managed"],
	},
	queue: {
		port: "queue",
		resourceClass: "aws:sqs-queue",
		providerService: "SQS",
		features: ["queue", "at-least-once", "managed"],
	},
	cache: {
		port: "cache",
		resourceClass: "aws:elasticache-redis",
		providerService: "ElastiCache",
		features: ["cache", "redis", "in-memory"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"kv",
	"objectStore",
	"database/postgres",
	"queue",
	"cache",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}
