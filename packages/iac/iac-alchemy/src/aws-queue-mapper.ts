import type { Providers } from "@alchemy.run/aws";
import { Table } from "@alchemy.run/aws/DynamoDB";
import * as Effect from "effect/Effect";
import { awsBindleMappers } from "./aws.js";
import { withAwsTargetSelection } from "./aws-target-selection.js";
import type { AlchemyPrimitiveMapper, BindleForAlchemy } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

const keys = Object.keys;
const descriptors = Object.getOwnPropertyDescriptors;
const freeze = Object.freeze;

export function awsDynamoDurableQueue() {
	return freeze({
		provider: "aws",
		option: "dynamodb-durable-queue",
		config: freeze({
			runtime: "node-js",
			consistency: "strong",
			maxLogEvents: 512,
			maxLogBytes: 262_144,
		}),
	});
}
export function withAwsDynamoDurableQueue<Entrypoint, Requirements>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	choices: Readonly<Record<string, true>>,
): BindleForAlchemy<Entrypoint, Requirements> {
	return withAwsTargetSelection(
		bindle,
		choices,
		"queue",
		"Queue",
		awsDynamoDurableQueue(),
	);
}
export function awsDynamoDurableQueueMappers<Entrypoint, Requirements>(
	base = awsBindleMappers<Entrypoint, Requirements>(),
) {
	const queue: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers> = {
		resourceTypes: ["AWS.DynamoDB.Table"],
		operations: ["enqueue", "dequeue"],
		annotations: ["aws:dynamodb-durable-queue"],
		bindsEntrypoint: false,
		limitations: [
			"Node.js queue: 512-event segment, 256-KiB record; host compaction required. No automatic dead-letter export or native SQS queue. HTTP binding requires a configured source.",
			"The host must fence the dedicated table, authorize the queue and reconcile unknown operations.",
			"Supplied pricing must cover queue storage and requests; individual queue calls do not perform budget admission.",
		],
		validate(input) {
			if (keys(input.dependencyDeclarations).length !== 0)
				throw new AlchemyIacError(
					"BINDLE_GRAPH_UNSUPPORTED",
					"DynamoDB queue dependencies are not bound",
				);
			const annotations = input.declaration.annotations;
			const annotation = annotations[0];
			const fields =
				annotation === undefined ? {} : descriptors(annotation.config);
			if (
				annotations.length !== 1 ||
				annotation?.provider !== "aws" ||
				annotation.option !== "dynamodb-durable-queue" ||
				keys(fields).length !== 4 ||
				fields.runtime?.value !== "node-js" ||
				fields.consistency?.value !== "strong" ||
				fields.maxLogEvents?.value !== 512 ||
				fields.maxLogBytes?.value !== 262_144
			)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"DynamoDB queue requires the explicit bounded runtime choice",
				);
		},
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
	return freeze({ ...base, queue });
}
