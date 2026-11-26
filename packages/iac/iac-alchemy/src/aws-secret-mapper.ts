import type { Providers } from "@alchemy.run/aws";
import { awsBindleMappers } from "./aws.js";
import { withAwsTargetSelection } from "./aws-target-selection.js";
import type { AlchemyPrimitiveMapper, BindleForAlchemy } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

/** Select bounded binary, versioned Node.js secret operations outside the Bindle. */
export function awsVersionedSecret() {
	return Object.freeze({
		provider: "aws",
		option: "versioned-secret",
		config: Object.freeze({
			runtime: "node-js",
			encoding: "binary",
			maxValueBytes: 65_536,
			maxVersions: 100,
			versionIdentity: "persisted-uuid",
		}),
	});
}
export function withAwsVersionedSecret<Entrypoint, Requirements>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	choices: Readonly<Record<string, true>>,
): BindleForAlchemy<Entrypoint, Requirements> {
	return withAwsTargetSelection(
		bindle,
		choices,
		"secret",
		"Secret",
		awsVersionedSecret(),
	);
}
export function awsVersionedSecretBindleMappers<Entrypoint, Requirements>(
	base = awsBindleMappers<Entrypoint, Requirements>(),
) {
	const secret: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers> = {
		...base.secret,
		operations: ["put", "access"],
		annotations: ["aws:versioned-secret"],
		limitations: [
			"Node.js binary secrets only, at most 100 versions; persist each UUID before writing and reconcile unknown writes with that same ID.",
			"Application and WASI bindings are not implemented; the host must authenticate grants, enforce IAM and fence in-flight work.",
		],
		validate(input) {
			base.secret.validate?.(input);
			const annotation = input.declaration.annotations[0];
			const fields =
				annotation === undefined
					? {}
					: Object.getOwnPropertyDescriptors(annotation.config);
			if (
				input.declaration.annotations.length !== 1 ||
				annotation?.provider !== "aws" ||
				annotation.option !== "versioned-secret" ||
				Object.keys(fields).length !== 5 ||
				fields.runtime?.value !== "node-js" ||
				fields.encoding?.value !== "binary" ||
				fields.maxValueBytes?.value !== 65_536 ||
				fields.maxVersions?.value !== 100 ||
				fields.versionIdentity?.value !== "persisted-uuid"
			)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"Secrets Manager requires the explicit bounded versioned runtime choice",
				);
		},
	};
	return Object.freeze({ ...base, secret });
}
