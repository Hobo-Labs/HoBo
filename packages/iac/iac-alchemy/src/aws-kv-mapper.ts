import type { Providers } from "@alchemy.run/aws";
import { awsBindleMappers } from "./aws.js";
import { withAwsTargetSelection } from "./aws-target-selection.js";
import type { AlchemyPrimitiveMapper, BindleForAlchemy } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

export function awsDynamoKv() {
	return Object.freeze({
		provider: "aws",
		option: "dynamodb-kv",
		config: Object.freeze({
			runtime: "node-js",
			consistency: "strong",
			maxValueBytes: 262_144,
		}),
	});
}

export function withAwsDynamoKv<Entrypoint, Requirements>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	choices: Readonly<Record<string, true>>,
): BindleForAlchemy<Entrypoint, Requirements> {
	return withAwsTargetSelection(bindle, choices, "kv", "KV", awsDynamoKv());
}

export function awsDynamoKvBindleMappers<Entrypoint, Requirements>() {
	const base = awsBindleMappers<Entrypoint, Requirements>();
	const kv: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers> = {
		...base.kv,
		operations: ["get", "set", "delete"],
		annotations: ["aws:dynamodb-kv"],
		limitations: [
			"Node.js bounded KV only; no application or WASI binding. The host must authorize the table and grant, enforce IAM, and reconcile uncertain mutations.",
		],
		validate(input) {
			base.kv.validate?.(input);
			const annotations = input.declaration.annotations;
			const annotation = annotations[0];
			const fields =
				annotation === undefined
					? {}
					: Object.getOwnPropertyDescriptors(annotation.config);
			if (
				annotations.length !== 1 ||
				annotation?.provider !== "aws" ||
				annotation.option !== "dynamodb-kv" ||
				Object.keys(fields).length !== 3 ||
				fields.runtime?.value !== "node-js" ||
				fields.consistency?.value !== "strong" ||
				fields.maxValueBytes?.value !== 262_144
			)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"DynamoDB KV requires the explicit bounded Node.js runtime choice",
				);
		},
	};
	return Object.freeze({ ...base, kv });
}
