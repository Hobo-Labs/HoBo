import type { Providers } from "@alchemy.run/aws";
import { UserPool } from "@alchemy.run/aws/Cognito";
import { Table } from "@alchemy.run/aws/DynamoDB";
import { Bucket } from "@alchemy.run/aws/S3";
import { Secret } from "@alchemy.run/aws/SecretsManager";
import { Topic } from "@alchemy.run/aws/SNS";
import { Queue } from "@alchemy.run/aws/SQS";
import * as Effect from "effect/Effect";
import {
	type AlchemyPrimitiveInput,
	type AlchemyPrimitiveMapper,
	describeAlchemyPrimitiveSupport,
} from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

export function describeAwsPrimitiveSupport(
	catalog: readonly {
		readonly factory: string;
		readonly allowVerbs: readonly string[];
	}[],
) {
	return describeAlchemyPrimitiveSupport(catalog, awsBindleMappers());
}

export function awsBindleMappers<Entrypoint, Requirements>() {
	type Mapper = AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers>;
	const noDependencies = (
		input: AlchemyPrimitiveInput<Entrypoint, Requirements>,
	) => {
		if (Object.keys(input.dependencyDeclarations).length !== 0)
			throw new AlchemyIacError(
				"BINDLE_GRAPH_UNSUPPORTED",
				`${input.declaration.kind} dependencies are not bound`,
			);
	};
	const kv: Mapper = {
		resourceTypes: ["AWS.DynamoDB.Table"],
		operations: [],
		annotations: [],
		bindsEntrypoint: false,
		limitations: [
			"DynamoDB table infrastructure only; HoBo key-value operations, key and value bounds, and application bindings are not implemented.",
		],
		validate: noDependencies,
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Table(input.declaration.name, {
					partitionKey: "pk",
					attributes: { pk: "S" },
					billingMode: "PAY_PER_REQUEST",
				});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	const bucket: Mapper = {
		resourceTypes: ["AWS.S3.Bucket"],
		operations: [],
		annotations: [],
		bindsEntrypoint: false,
		limitations: [
			"S3 bucket infrastructure only; HoBo blob operations and application bindings are not implemented.",
		],
		validate: noDependencies,
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Bucket(input.declaration.name, {});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	const queue: Mapper = {
		resourceTypes: ["AWS.SQS.Queue"],
		operations: [],
		annotations: [],
		bindsEntrypoint: false,
		limitations: [
			"SQS infrastructure only; HoBo queue idempotency, leases and application bindings are not implemented.",
		],
		validate: noDependencies,
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Queue(input.declaration.name, {});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	const topic: Mapper = {
		resourceTypes: ["AWS.SNS.Topic"],
		operations: [],
		annotations: [],
		bindsEntrypoint: false,
		limitations: [
			"SNS topic infrastructure only; HoBo durable topic journals, subscriptions and application bindings are not implemented.",
		],
		validate: noDependencies,
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Topic(input.declaration.name, {});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	const secret: Mapper = {
		resourceTypes: ["AWS.SecretsManager.Secret"],
		operations: [],
		annotations: [],
		bindsEntrypoint: false,
		limitations: [
			"Secrets Manager infrastructure only; versioned secret operations, values and application bindings are not implemented.",
		],
		validate: noDependencies,
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Secret(input.declaration.name, {
					recoveryWindowInDays: 30,
				});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	const auth: Mapper = {
		resourceTypes: ["AWS.Cognito.UserPool"],
		operations: [],
		annotations: [],
		bindsEntrypoint: false,
		limitations: [
			"Cognito user pool infrastructure only; token verification, sessions, client configuration and application bindings are not implemented.",
		],
		validate: noDependencies,
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* UserPool(input.declaration.name, {});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	const notify: Mapper = {
		...topic,
		limitations: [
			"SNS topic infrastructure only; notification delivery, subscriptions, recipients and application bindings are not implemented.",
		],
	};
	return Object.freeze({ kv, bucket, queue, topic, secret, auth, notify });
}
