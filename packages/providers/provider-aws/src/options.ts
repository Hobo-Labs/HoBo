import type { JsonObject } from "./json.js";

export const AWS_PROVIDER_TARGET = "aws";

export type TypedOptionBlock = {
	providerId: string;
	port: string;
	optionName: string;
	negotiation: "prefer" | "require";
	options: JsonObject;
};

export const aws = {
	with: {
		fargate(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"compute",
				"fargate",
				{ cpu: 256, memoryMiB: 512, spot: false },
				options,
			);
		},
		rds(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"database",
				"rds",
				{ engineVersion: "16", instanceClass: "db.t4g.micro", multiAz: false },
				options,
			);
		},
		s3(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"objectStore",
				"s3",
				{ versioning: true, publicAccess: false, storageClass: "STANDARD" },
				options,
			);
		},
		dynamodb(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"kv",
				"dynamodb",
				{ billingMode: "PAY_PER_REQUEST", ttlAttribute: null },
				options,
			);
		},
		sqs(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"queue",
				"sqs",
				{ fifo: false, visibilityTimeoutSeconds: 30 },
				options,
			);
		},
		elasticache(options: JsonObject = {}): TypedOptionBlock {
			return optionBlock(
				"cache",
				"elasticache",
				{ nodeType: "cache.t4g.micro", replicas: 0 },
				options,
			);
		},
	},
};

function optionBlock(
	port: string,
	optionName: string,
	defaults: JsonObject,
	options: JsonObject,
): TypedOptionBlock {
	return {
		providerId: AWS_PROVIDER_TARGET,
		port,
		optionName,
		negotiation: "prefer",
		options: { ...defaults, ...options },
	};
}
