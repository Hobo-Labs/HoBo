import type { Providers } from "@alchemy.run/aws";
import { Table } from "@alchemy.run/aws/DynamoDB";
import * as Effect from "effect/Effect";
import { awsBindleMappers } from "./aws.js";
import { withAwsTargetSelection } from "./aws-target-selection.js";
import type { AlchemyPrimitiveMapper, BindleForAlchemy } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

export function awsDynamoDurableQueue() {
	return Object.freeze({
		provider: "aws",
		option: "dynamodb-durable-queue",
		config: Object.freeze({
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
			"Node.js atomic queue has a 512-event, 256-KiB lifetime log, with no compaction, dead-lettering, SQS or automatic application binding.",
			"The host must fence the dedicated table, authorize the queue and reconcile unknown operations.",
		],
		validate(input) {
			if (Object.keys(input.dependencyDeclarations).length !== 0)
				throw new AlchemyIacError(
					"BINDLE_GRAPH_UNSUPPORTED",
					"DynamoDB queue dependencies are not bound",
				);
			const annotations = input.declaration.annotations;
			const annotation = annotations[0];
			const fields =
				annotation === undefined
					? {}
					: Object.getOwnPropertyDescriptors(annotation.config);
			if (
				annotations.length !== 1 ||
				annotation?.provider !== "aws" ||
				annotation.option !== "dynamodb-durable-queue" ||
				Object.keys(fields).length !== 4 ||
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
	return Object.freeze({ ...base, queue });
}
