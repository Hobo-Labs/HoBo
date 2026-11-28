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
	readonly kind: "kv" | "bucket" | "secret" | "queue" | "notify" | "crypto";
	readonly environment: string;
	readonly allow: readonly string[];
}
export interface AwsHttpGraph {
	readonly bindleName: string;
	readonly applicationName: string;
	readonly entrypoint: AwsHttpEntrypoint;
	readonly bindle: BindleForAlchemy<AwsHttpEntrypoint, undefined>;
	readonly bindings: readonly AwsHttpDependency[];
}
const arraySort = Array.prototype.sort;
const arrayPush = Array.prototype.push;
const arraySome = Array.prototype.some;
const arrayIncludes = Array.prototype.includes;
const descriptor = Object.getOwnPropertyDescriptor;
const descriptors = Object.getOwnPropertyDescriptors;
const symbols = Object.getOwnPropertySymbols;
const keys = Object.keys;
const freeze = Object.freeze;
const isArray = Array.isArray;
const text = String;
const trim = String.prototype.trim;
const regexExec = RegExp.prototype.exec;
const controlPattern = /[\p{Cc}]/u;
const apply = Reflect.apply;
const own = Object.hasOwn;
const isProxy = types.isProxy;
function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		apply(trim, value, []) === value &&
		apply(regexExec, controlPattern, [value]) === null
	);
}
function marker(
	declaration: PrimitiveDeclaration,
): "kv" | "bucket" | "secret" | "queue" | "notify" | "crypto" {
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
	const fields = descriptors(annotation.config);
	if (symbols(annotation.config).length !== 0)
		throw new Error("AWS application dependency is invalid");
	if (
		keys(fields).length === 3 &&
		declaration.kind === "kv" &&
		annotation.provider === "aws" &&
		annotation.option === "dynamodb-kv" &&
		fields.runtime?.value === "node-js" &&
		fields.consistency?.value === "strong" &&
		fields.maxValueBytes?.value === 262_144
	)
		return "kv";
	if (
		keys(fields).length === 3 &&
		declaration.kind === "bucket" &&
		annotation.provider === "aws" &&
		annotation.option === "bounded-s3" &&
		fields.runtime?.value === "node-js" &&
		fields.digest?.value === "sha256" &&
		fields.maxObjectBytes?.value === 1_048_576
	)
		return "bucket";
	if (
		keys(fields).length === 5 &&
		declaration.kind === "secret" &&
		annotation.provider === "aws" &&
		annotation.option === "versioned-secret" &&
		fields.runtime?.value === "node-js" &&
		fields.encoding?.value === "binary" &&
		fields.maxValueBytes?.value === 65_536 &&
		fields.maxVersions?.value === 100 &&
		fields.versionIdentity?.value === "persisted-uuid"
	)
		return "secret";
	if (
		keys(fields).length === 4 &&
		declaration.kind === "queue" &&
		annotation.provider === "aws" &&
		annotation.option === "dynamodb-durable-queue" &&
		fields.runtime?.value === "node-js" &&
		fields.consistency?.value === "strong" &&
		fields.maxLogEvents?.value === 512 &&
		fields.maxLogBytes?.value === 262_144
	)
		return "queue";
	if (
		keys(fields).length === 3 &&
		declaration.kind === "notify" &&
		annotation.provider === "aws" &&
		annotation.option === "sns-notification" &&
		fields.runtime?.value === "node-js" &&
		fields.maxBodyBytes?.value === 65_536 &&
		fields.retries?.value === "none"
	)
		return "notify";

	if (
		keys(fields).length === 4 &&
		declaration.kind === "crypto" &&
		annotation.provider === "aws" &&
		annotation.option === "kms-cryptography" &&
		fields.runtime?.value === "node-js" &&
		fields.maxPlaintextBytes?.value === 4096 &&
		fields.maxCiphertextBytes?.value === 6144 &&
		fields.retries?.value === "none"
	)
		return "crypto";

	throw new Error(
		"AWS application dependency requires an explicit runtime choice",
	);
}

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
		const field = descriptor(bindle, key);
		if (!field || !own(field, "value"))
			throw new Error("invalid AWS Bindle graph");
		return field.value;
	};
	const bindleName = data("name");
	const entrypointOf = data("entrypoint");
	const resources = snapshotData(data("resources"));
	const edges = snapshotData(data("edges"));
	const connectorsField = descriptor(bindle, "connectors");
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
		isArray(resources) ||
		!isArray(edges) ||
		edges.length > 1024 ||
		(connectors !== undefined &&
			(!connectors ||
				typeof connectors !== "object" ||
				isArray(connectors) ||
				keys(connectors).length !== 0))
	)
		throw new Error("unsupported AWS Bindle graph");
	if (keys(resources).length > 256)
		throw new Error("unsupported AWS Bindle graph");
	const rootField = descriptor(resources, applicationName);
	const declaration =
		rootField && own(rootField, "value") && rootField.enumerable
			? rootField.value
			: undefined;
	const entrypoint = apply(entrypointOf, bindle, [applicationName]);
	if (
		!declaration ||
		declaration.name !== applicationName ||
		!apply(
			arrayIncludes,
			["web", "api", "service", "ui"],
			[declaration.kind],
		) ||
		typeof entrypoint !== "function" ||
		isProxy(entrypoint)
	)
		throw new Error("unsupported AWS HTTP application");
	if (
		!isArray(declaration.annotations) ||
		declaration.annotations.length > 1 ||
		apply(arraySome, declaration.annotations, [
			(annotation: PrimitiveDeclaration["annotations"][number]) =>
				annotation.provider !== "hobo" ||
				annotation.option !== "session-replay" ||
				descriptor(annotation.config, "enabled")?.value !== false ||
				apply(arraySome, keys(annotation.config), [
					(key: string) =>
						!apply(
							arrayIncludes,
							["enabled", "defaultSupply", "sampleRate"],
							[key],
						),
				]),
		])
	)
		throw new Error("session replay and HTTP annotations are unsupported");
	const names: string[] = [];
	for (let index = 0; index < edges.length; index++) {
		const field = descriptor(edges, text(index));
		if (
			!field ||
			!own(field, "value") ||
			!field.enumerable ||
			!field.value ||
			typeof field.value !== "object" ||
			isProxy(field.value)
		)
			throw new Error("AWS Bindle edges are invalid");
		const from = descriptor(field.value, "from");
		const to = descriptor(field.value, "to");
		if (
			!from ||
			!to ||
			!own(from, "value") ||
			!own(to, "value") ||
			!name(from.value) ||
			!name(to.value)
		)
			throw new Error("AWS Bindle edges are invalid");
		if (!own(resources, from.value) || !own(resources, to.value))
			throw new Error("AWS Bindle edges reference missing resources");
		if (from.value === applicationName) apply(arrayPush, names, [to.value]);
	}
	apply(arraySort, names, []);
	if (names.length > 256)
		throw new Error("AWS application dependencies are incomplete");
	for (let index = 1; index < names.length; index++)
		if (names[index] === names[index - 1])
			throw new Error("AWS application dependencies are incomplete");
	const bindings: AwsHttpDependency[] = [];
	const kinds: string[] = [];
	for (let index = 0; index < names.length; index++) {
		const resourceName = names[index];
		if (resourceName === undefined)
			throw new Error("AWS application dependency is missing");
		const field = descriptor(resources, resourceName);
		const dependency =
			field && own(field, "value") && field.enumerable
				? field.value
				: undefined;
		if (
			!dependency ||
			dependency.name !== resourceName ||
			dependency.stableId !== `${dependency.kind}:${resourceName}` ||
			!isArray(dependency.declaredAllow) ||
			dependency.declaredAllow.length === 0 ||
			dependency.declaredAllow.length > 3
		)
			throw new Error("AWS application dependency is invalid");
		for (let left = 0; left < dependency.declaredAllow.length; left++)
			for (
				let right = left + 1;
				right < dependency.declaredAllow.length;
				right++
			)
				if (dependency.declaredAllow[left] === dependency.declaredAllow[right])
					throw new Error("AWS application dependency is invalid");
		const kind = marker(dependency);
		const allowed =
			kind === "kv"
				? ["get", "set", "delete"]
				: kind === "bucket"
					? ["read", "write", "delete"]
					: kind === "queue"
						? ["enqueue", "dequeue"]
						: kind === "notify"
							? ["send"]
							: kind === "crypto"
								? ["encrypt", "decrypt"]
								: ["put", "access"];
		if (
			apply(arraySome, dependency.declaredAllow, [
				(operation: string) => !apply(arrayIncludes, allowed, [operation]),
			])
		)
			throw new Error("AWS application operation is unsupported");
		const allow: string[] = [];
		for (
			let operation = 0;
			operation < dependency.declaredAllow.length;
			operation++
		)
			apply(arrayPush, allow, [dependency.declaredAllow[operation]]);
		apply(arrayPush, bindings, [
			freeze({
				name: resourceName,
				kind,
				environment: `HOBO_RESOURCE_${index}`,
				allow: freeze(allow),
			}),
		]);
		apply(arrayPush, kinds, [kind]);
	}
	if (!isArray(declaration.dependsOn) || declaration.dependsOn.length > 256)
		throw new Error("AWS dependency graph is incomplete");
	const declared: string[] = [];
	for (let index = 0; index < declaration.dependsOn.length; index++)
		apply(arrayPush, declared, [declaration.dependsOn[index]]);
	apply(arraySort, declared, []);
	apply(arraySort, kinds, []);
	if (
		kinds.length !== declared.length ||
		apply(arraySome, kinds, [
			(kind: string, index: number) => kind !== declared[index],
		])
	)
		throw new Error("AWS dependency graph is incomplete");
	const capturedBindle: BindleForAlchemy<AwsHttpEntrypoint, undefined> = freeze(
		{
			name: bindleName,
			// SAFETY: snapshotData recursively copies and freezes the checked resource data.
			resources: resources as Readonly<Record<string, PrimitiveDeclaration>>,
			// SAFETY: each frozen edge was checked above for valid from and to names.
			edges: edges as readonly { readonly from: string; readonly to: string }[],
			requirements: undefined,
			entrypoint: (requested: string) =>
				requested === applicationName ? entrypoint : undefined,
		},
	);
	return freeze({
		bindleName,
		applicationName,
		entrypoint,
		bindle: capturedBindle,
		bindings: freeze(bindings),
	});
}
