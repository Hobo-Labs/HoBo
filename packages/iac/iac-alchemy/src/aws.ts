import type { Providers } from "@alchemy.run/aws";
import { Api } from "@alchemy.run/aws/ApiGatewayV2";
import { UserPool } from "@alchemy.run/aws/Cognito";
import { Table } from "@alchemy.run/aws/DynamoDB";
import { Key } from "@alchemy.run/aws/KMS";
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
	const crypto: Mapper = {
		resourceTypes: ["AWS.KMS.Key"],
		operations: [],
		annotations: [],
		bindsEntrypoint: false,
		limitations: [
			"KMS symmetric key infrastructure only; encryption, decryption, signing, verification and application bindings are not implemented.",
			"The host must reconcile an unknown key creation before retrying, and control key policy and deletion.",
		],
		validate: noDependencies,
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Key(input.declaration.name, {
					keyUsage: "ENCRYPT_DECRYPT",
					keySpec: "SYMMETRIC_DEFAULT",
				});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	const websocket: Mapper = {
		resourceTypes: ["AWS.ApiGatewayV2.Api"],
		operations: [],
		annotations: ["hobo:session-replay"],
		bindsEntrypoint: false,
		limitations: [
			"WebSocket API infrastructure only; replay must be disabled. Routes, integrations, connections, messaging and application bindings are not implemented.",
		],
		validate: (input) => {
			noDependencies(input);
			const annotations = input.declaration.annotations;
			const replay = annotations[0];
			const config = replay && Object.getOwnPropertyDescriptors(replay.config);
			if (
				annotations.length !== 1 ||
				replay?.provider !== "hobo" ||
				replay.option !== "session-replay" ||
				config?.enabled?.value !== false ||
				config.defaultSupply?.value !== "kit-local-on" ||
				Object.keys(config).length !== 2
			)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"WebSocket infrastructure requires session replay to be disabled",
				);
		},
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Api(input.declaration.name, {
					protocolType: "WEBSOCKET",
				});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	return Object.freeze({
		kv,
		bucket,
		queue,
		topic,
		secret,
		auth,
		notify,
		crypto,
		websocket,
	});
}
