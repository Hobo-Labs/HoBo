/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-apply -- SAFETY: the Bindle graph crosses the provider boundary and is checked before it is copied. */
import { types } from "node:util";
import type { AwsHttpEntrypoint } from "./aws-http-runtime.js";
import {
	type BindleForAlchemy,
	type PrimitiveDeclaration,
	snapshotData,
} from "./bindle.js";

export interface AwsHttpDependency {
	readonly name: string;
	readonly kind: "kv" | "bucket";
	readonly environment: string;
	readonly allow: readonly string[];
}
export interface AwsHttpGraph {
	readonly bindleName: string;
	readonly applicationName: string;
	readonly entrypoint: AwsHttpEntrypoint;
	readonly bindings: readonly AwsHttpDependency[];
}
const arraySort = Array.prototype.sort;
const apply = Reflect.apply;
const own = Object.hasOwn;
const isProxy = types.isProxy;
function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}
function marker(declaration: PrimitiveDeclaration): "kv" | "bucket" {
	if (declaration.annotations.length !== 1)
		throw new Error(
			"AWS application dependency requires an explicit runtime choice",
		);
	const annotation = declaration.annotations[0];
	if (
		!annotation ||
		typeof annotation.config !== "object" ||
		annotation.config === null ||
		isProxy(annotation.config)
	)
		throw new Error("AWS application dependency is invalid");
	const fields = Object.getOwnPropertyDescriptors(annotation.config);
	if (
		Object.keys(fields).length !== 3 ||
		Object.getOwnPropertySymbols(annotation.config).length !== 0
	)
		throw new Error("AWS application dependency is invalid");
	if (
		declaration.kind === "kv" &&
		annotation.provider === "aws" &&
		annotation.option === "dynamodb-kv" &&
		fields.runtime?.value === "node-js" &&
		fields.consistency?.value === "strong" &&
		fields.maxValueBytes?.value === 262_144
	)
		return "kv";
	if (
		declaration.kind === "bucket" &&
		annotation.provider === "aws" &&
		annotation.option === "bounded-s3" &&
		fields.runtime?.value === "node-js" &&
		fields.digest?.value === "sha256" &&
		fields.maxObjectBytes?.value === 1_048_576
	)
		return "bucket";
	throw new Error(
		"AWS application dependency requires an explicit runtime choice",
	);
}

/** Capture the exact bounded graph used by both AWS source registration and runtime binding. */
export function captureAwsHttpGraph<Requirements>(
	bindle: BindleForAlchemy<AwsHttpEntrypoint, Requirements>,
	applicationName: string,
): AwsHttpGraph {
	if (
		!bindle ||
		typeof bindle !== "object" ||
		isProxy(bindle) ||
		!name(applicationName)
	)
		throw new Error("invalid AWS Bindle graph");
	const data = (key: string): unknown => {
		const field = Object.getOwnPropertyDescriptor(bindle, key);
		if (!field || !own(field, "value"))
			throw new Error("invalid AWS Bindle graph");
		return field.value;
	};
	const bindleName = data("name");
	const entrypointOf = data("entrypoint");
	const resources = snapshotData(data("resources"));
	const edges = snapshotData(data("edges"));
	const connectorsField = Object.getOwnPropertyDescriptor(bindle, "connectors");
	if (connectorsField && !own(connectorsField, "value"))
		throw new Error("invalid AWS Bindle graph");
	const connectors =
		connectorsField?.value === undefined
			? undefined
			: snapshotData(connectorsField.value);
	if (
		!name(bindleName) ||
		typeof entrypointOf !== "function" ||
		isProxy(entrypointOf) ||
		!resources ||
		typeof resources !== "object" ||
		Array.isArray(resources) ||
		!Array.isArray(edges) ||
		edges.length > 1024 ||
		(connectors !== undefined &&
			(!connectors ||
				typeof connectors !== "object" ||
				Array.isArray(connectors) ||
				Object.keys(connectors).length !== 0))
	)
		throw new Error("unsupported AWS Bindle graph");
	if (Object.keys(resources).length > 256)
		throw new Error("unsupported AWS Bindle graph");
	const rootField = Object.getOwnPropertyDescriptor(resources, applicationName);
	const declaration =
		rootField && own(rootField, "value") && rootField.enumerable
			? rootField.value
			: undefined;
	const entrypoint = apply(entrypointOf, bindle, [applicationName]);
	if (
		!declaration ||
		declaration.name !== applicationName ||
		!["web", "api", "service"].includes(declaration.kind) ||
		typeof entrypoint !== "function" ||
		isProxy(entrypoint)
	)
		throw new Error("unsupported AWS HTTP application");
	if (
		!Array.isArray(declaration.annotations) ||
		declaration.annotations.length > 1 ||
		declaration.annotations.some(
			(annotation: PrimitiveDeclaration["annotations"][number]) =>
				annotation.provider !== "hobo" ||
				annotation.option !== "session-replay" ||
				Object.getOwnPropertyDescriptor(annotation.config, "enabled")?.value !==
					false ||
				Object.keys(annotation.config).some(
					(key) => !["enabled", "defaultSupply", "sampleRate"].includes(key),
				),
		)
	)
		throw new Error("session replay and HTTP annotations are unsupported");
	const names: string[] = [];
	for (let index = 0; index < edges.length; index++) {
		const field = Object.getOwnPropertyDescriptor(edges, String(index));
		if (
			!field ||
			!own(field, "value") ||
			!field.enumerable ||
			!field.value ||
			typeof field.value !== "object" ||
			isProxy(field.value)
		)
			throw new Error("AWS Bindle edges are invalid");
		const from = Object.getOwnPropertyDescriptor(field.value, "from");
		const to = Object.getOwnPropertyDescriptor(field.value, "to");
		if (
			!from ||
			!to ||
			!own(from, "value") ||
			!own(to, "value") ||
			!name(from.value) ||
			!name(to.value)
		)
			throw new Error("AWS Bindle edges are invalid");
		if (
			!Object.hasOwn(resources, from.value) ||
			!Object.hasOwn(resources, to.value)
		)
			throw new Error("AWS Bindle edges reference missing resources");
		if (from.value === applicationName) names.push(to.value);
	}
	apply(arraySort, names, []);
	if (names.length > 256 || new Set(names).size !== names.length)
		throw new Error("AWS application dependencies are incomplete");
	const bindings: AwsHttpDependency[] = [];
	const kinds: string[] = [];
	for (let index = 0; index < names.length; index++) {
		const resourceName = names[index];
		if (resourceName === undefined)
			throw new Error("AWS application dependency is missing");
		const field = Object.getOwnPropertyDescriptor(resources, resourceName);
		const dependency =
			field && own(field, "value") && field.enumerable
				? field.value
				: undefined;
		if (
			!dependency ||
			dependency.name !== resourceName ||
			dependency.stableId !== `${dependency.kind}:${resourceName}` ||
			!Array.isArray(dependency.declaredAllow) ||
			dependency.declaredAllow.length === 0 ||
			dependency.declaredAllow.length > 3 ||
			new Set(dependency.declaredAllow).size !== dependency.declaredAllow.length
		)
			throw new Error("AWS application dependency is invalid");
		const kind = marker(dependency);
		const allowed =
			kind === "kv" ? ["get", "set", "delete"] : ["read", "write", "delete"];
		if (
			dependency.declaredAllow.some(
				(operation: string) => !allowed.includes(operation),
			)
		)
			throw new Error("AWS application operation is unsupported");
		bindings.push(
			Object.freeze({
				name: resourceName,
				kind,
				environment: `HOBO_RESOURCE_${index}`,
				allow: Object.freeze([...dependency.declaredAllow]),
			}),
		);
		kinds.push(kind);
	}
	const declared = [...declaration.dependsOn];
	apply(arraySort, declared, []);
	apply(arraySort, kinds, []);
	if (
		kinds.length !== declared.length ||
		kinds.some((kind, index) => kind !== declared[index])
	)
		throw new Error("AWS dependency graph is incomplete");
	return Object.freeze({
		bindleName,
		applicationName,
		entrypoint,
		bindings: Object.freeze(bindings),
	});
}
