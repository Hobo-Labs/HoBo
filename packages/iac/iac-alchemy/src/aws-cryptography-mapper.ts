import type { Providers } from "@alchemy.run/aws";
import { Key } from "@alchemy.run/aws/KMS";
import * as Effect from "effect/Effect";
import { awsBindleMappers } from "./aws.js";
import {
	AWS_KMS_MAX_CIPHERTEXT_BYTES,
	AWS_KMS_MAX_PLAINTEXT_BYTES,
} from "./aws-cryptography.js";
import { withAwsTargetSelection } from "./aws-target-selection.js";
import type { AlchemyPrimitiveMapper, BindleForAlchemy } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

const keys = Object.keys;
const descriptors = Object.getOwnPropertyDescriptors;
const freeze = Object.freeze;

export function awsKmsCryptography() {
	return freeze({
		provider: "aws",
		option: "kms-cryptography",
		config: freeze({
			runtime: "node-js",
			maxPlaintextBytes: AWS_KMS_MAX_PLAINTEXT_BYTES,
			maxCiphertextBytes: AWS_KMS_MAX_CIPHERTEXT_BYTES,
			retries: "none",
		}),
	});
}
export function withAwsKmsCryptography<Entrypoint, Requirements>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	choices: Readonly<Record<string, true>>,
): BindleForAlchemy<Entrypoint, Requirements> {
	return withAwsTargetSelection(
		bindle,
		choices,
		"crypto",
		"Cryptography",
		awsKmsCryptography(),
	);
}
export function awsKmsCryptographyMappers<Entrypoint, Requirements>(
	base = awsBindleMappers<Entrypoint, Requirements>(),
) {
	const crypto: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers> = {
		resourceTypes: ["AWS.KMS.Key"],
		operations: ["encrypt", "decrypt"],
		annotations: ["aws:kms-cryptography"],
		bindsEntrypoint: false,
		limitations: [
			"Node.js symmetric KMS encryption only; signing and verification are not implemented.",
			"Application bindings require a verified exact key grant and an explicitly selected AWS HTTP source.",
			"The host must verify the exact key grant and reconcile unknown operations before retrying.",
			"Supplied pricing must cover key and operation charges; individual operations do not perform budget admission.",
		],
		validate(input) {
			if (keys(input.dependencyDeclarations).length !== 0)
				throw new AlchemyIacError(
					"BINDLE_GRAPH_UNSUPPORTED",
					"KMS cryptography dependencies are not bound",
				);
			const annotations = input.declaration.annotations;
			const annotation = annotations[0];
			const fields =
				annotation === undefined ? {} : descriptors(annotation.config);
			if (
				annotations.length !== 1 ||
				annotation?.provider !== "aws" ||
				annotation.option !== "kms-cryptography" ||
				keys(fields).length !== 4 ||
				fields.runtime?.value !== "node-js" ||
				fields.maxPlaintextBytes?.value !== AWS_KMS_MAX_PLAINTEXT_BYTES ||
				fields.maxCiphertextBytes?.value !== AWS_KMS_MAX_CIPHERTEXT_BYTES ||
				fields.retries?.value !== "none"
			)
				throw new AlchemyIacError(
					"PRIMITIVE_UNSUPPORTED",
					"KMS cryptography requires the explicit bounded runtime choice",
				);
		},
		build: (input) =>
			Effect.gen(function* () {
				const primary = yield* Key(input.declaration.name, {
					keyUsage: "ENCRYPT_DECRYPT",
					keySpec: "SYMMETRIC_DEFAULT",
				});
				return { primary, resources: [primary], boundDependencies: [] };
			}),
	};
	return freeze({ ...base, crypto });
}
