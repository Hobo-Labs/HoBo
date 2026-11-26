import { types } from "node:util";
import type { BindleForAlchemy, PrimitiveDeclaration } from "./bindle.js";
import { AlchemyIacError } from "./plan.js";

export function withAwsTargetSelection<Entrypoint, Requirements>(
	bindle: BindleForAlchemy<Entrypoint, Requirements>,
	choices: Readonly<Record<string, true>>,
	kind: string,
	label: string,
	annotation: PrimitiveDeclaration["annotations"][number],
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
			`${label} choices must be a bounded record`,
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
			`${label} choices must contain own true values`,
		);
	const resources: Record<string, PrimitiveDeclaration> = Object.create(null);
	for (const [name, declaration] of Object.entries(bindle.resources)) {
		if (!Object.hasOwn(fields, name)) {
			resources[name] = declaration;
			continue;
		}
		if (declaration.kind !== kind || declaration.annotations.length !== 0)
			throw new AlchemyIacError(
				"BINDLE_INVALID",
				`${label} choice must name an unannotated ${kind} resource`,
			);
		resources[name] = Object.freeze({
			...declaration,
			annotations: Object.freeze([annotation]),
		});
	}
	if (names.some((name) => !Object.hasOwn(resources, name)))
		throw new AlchemyIacError(
			"BINDLE_INVALID",
			`${label} choice names an unknown resource`,
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
