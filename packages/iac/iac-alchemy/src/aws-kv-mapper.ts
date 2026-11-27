import { types } from "node:util";
import type { Providers } from "@alchemy.run/aws";
import { awsBindleMappers } from "./aws.js";
import type {
	AlchemyPrimitiveMapper,
	BindleForAlchemy,
	PrimitiveDeclaration,
} from "./bindle.js";
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
	if (
		!choices ||
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: provider choices cross an external boundary.
		typeof choices !== "object" ||
		types.isProxy(choices) ||
		Array.isArray(choices) ||
		Object.getOwnPropertySymbols(choices).length !== 0
	)
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"KV choices must be a bounded record",
		);
	const fields = Object.getOwnPropertyDescriptors(choices);
	const names = Object.keys(fields);
	if (
		names.length === 0 ||
		names.length > 256 ||
		names.some(
			(name) =>
				fields[name]?.value !== true || fields[name]?.enumerable !== true,
		)
	)
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"KV choices must contain own true values",
		);
	const resources: Record<string, PrimitiveDeclaration> = Object.create(null);
	for (const [name, declaration] of Object.entries(bindle.resources)) {
		if (!Object.hasOwn(fields, name)) {
			resources[name] = declaration;
			continue;
		}
		if (declaration.kind !== "kv" || declaration.annotations.length !== 0)
			throw new AlchemyIacError(
				"BINDLE_INVALID",
				"KV choice must name an unannotated KV resource",
			);
		resources[name] = Object.freeze({
			...declaration,
			annotations: Object.freeze([awsDynamoKv()]),
		});
	}
	if (names.some((name) => !Object.hasOwn(resources, name)))
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			"KV choice names an unknown resource",
		);
	const result = {
		name: bindle.name,
		resources: Object.freeze(resources),
		edges: bindle.edges,
		requirements: bindle.requirements,
		entrypoint: (name: string) => bindle.entrypoint(name),
	};
	return bindle.connectors === undefined
		? Object.freeze(result)
		: Object.freeze({ ...result, connectors: bindle.connectors });
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
