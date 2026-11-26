import type { Providers } from "@alchemy.run/aws";
import { awsBindleMappers } from "./aws.js";
import { withAwsTargetSelection } from "./aws-target-selection.js";
import type { AlchemyPrimitiveMapper, BindleForAlchemy } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

export function awsBoundedS3() {
	return Object.freeze({
		provider: "aws",
		option: "bounded-s3",
		config: Object.freeze({
			runtime: "node-js",
			digest: "sha256",
			maxObjectBytes: 1_048_576,
		}),
	});
}
export function withAwsS3<Entrypoint, Requirements>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	choices: Readonly<Record<string, true>>,
): BindleForAlchemy<Entrypoint, Requirements> {
	return withAwsTargetSelection(
		bindle,
		choices,
		"bucket",
		"S3",
		awsBoundedS3(),
	);
}
/** Supply an existing AWS mapper set to compose S3 with other runtime subsets. */
export function awsS3BindleMappers<Entrypoint, Requirements>(
	base = awsBindleMappers<Entrypoint, Requirements>(),
) {
	const bucket: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers> = {
		...base.bucket,
		operations: ["read", "write", "delete"],
		annotations: ["aws:bounded-s3"],
		limitations: [
			"Node.js bounded objects only; no application, WASI, blob events or version binding. The host must enforce IAM and reconcile uncertain mutations.",
		],
		validate(input) {
			base.bucket.validate?.(input);
			const annotations = input.declaration.annotations;
			const annotation = annotations[0];
			const fields =
				annotation === undefined
					? {}
					: Object.getOwnPropertyDescriptors(annotation.config);
			if (
				annotations.length !== 1 ||
				annotation?.provider !== "aws" ||
				annotation.option !== "bounded-s3" ||
				Object.keys(fields).length !== 3 ||
				fields.runtime?.value !== "node-js" ||
				fields.digest?.value !== "sha256" ||
				fields.maxObjectBytes?.value !== 1_048_576
			)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"S3 objects require the explicit bounded Node.js runtime choice",
				);
		},
	};
	return Object.freeze({ ...base, bucket });
}
