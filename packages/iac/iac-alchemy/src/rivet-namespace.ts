import { createHash } from "node:crypto";
import { types } from "node:util";
import { Namespace, type Providers } from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type {
	AlchemyPrimitiveInput,
	AlchemyPrimitiveMapper,
} from "./bindle.js";
import { AlchemyIacError } from "./plan.js";
import { isAlchemyRedacted } from "./secret-fingerprint.js";

export interface RivetNamespaceDefinition {
	readonly bindleName: string;
	readonly resourceName: string;
	readonly endpoint: string;
	readonly namespaceName: string;
	readonly token: Redacted.Redacted<string>;
}

const ownKeys = Reflect.ownKeys;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const define = Object.defineProperty;
const freeze = Object.freeze;
const create = Object.create;
const hasOwn = Object.hasOwn;
const isArray = Array.isArray;
const isProxy = types.isProxy;
const arrayPrototype = Array.prototype;
const objectPrototype = Object.prototype;
const objectKeys = Object.keys;
const apply = Reflect.apply;
const trim = String.prototype.trim;
const test = RegExp.prototype.test;
const stringify = JSON.stringify;
const NamespaceUrl = URL;
const urlProtocol = ownDescriptor(NamespaceUrl.prototype, "protocol")?.get;
const urlHref = ownDescriptor(NamespaceUrl.prototype, "href")?.get;
const urlUsername = ownDescriptor(NamespaceUrl.prototype, "username")?.get;
const urlPassword = ownDescriptor(NamespaceUrl.prototype, "password")?.get;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: provider configuration is bounded external data inspected using captured intrinsics. */
function validIdentity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		apply(trim, value, []) === value &&
		!apply(test, /[\p{Cc}\uD800-\uDFFF]/u, [value]) &&
		Buffer.byteLength(value, "utf8") <= 200
	);
}

export function rivetNamespaceResourceId(
	bindleName: string,
	resourceName: string,
): string {
	if (!validIdentity(bindleName) || !validIdentity(resourceName))
		throw new AlchemyIacError(
			"RIVET_NAMESPACE_CONFIG_INVALID",
			"bounded project identities are required",
		);
	const digest = createHash("sha256")
		.update(stringify([bindleName, resourceName]))
		.digest("hex");
	return `hobo-project-${digest}`;
}

function captureDefinitions(
	input: readonly RivetNamespaceDefinition[],
): readonly RivetNamespaceDefinition[] {
	try {
		if (
			isProxy(input) ||
			!isArray(input) ||
			prototypeOf(input) !== arrayPrototype ||
			input.length > 256 ||
			ownKeys(input).length !== input.length + 1
		)
			throw new Error("invalid array");
		const result: RivetNamespaceDefinition[] = [];
		for (let index = 0; index < input.length; index++) {
			const element = ownDescriptor(input, String(index));
			if (!element || !hasOwn(element, "value") || !element.enumerable)
				throw new Error("invalid element");
			const entry = element.value;
			if (
				typeof entry !== "object" ||
				entry === null ||
				isProxy(entry) ||
				isArray(entry)
			)
				throw new Error("invalid record");
			const prototype = prototypeOf(entry);
			if (prototype !== objectPrototype && prototype !== null)
				throw new Error("invalid prototype");
			const keys = ownKeys(entry);
			if (keys.length !== 5) throw new Error("invalid fields");
			for (let position = 0; position < keys.length; position++) {
				const key = keys[position];
				if (
					key !== "bindleName" &&
					key !== "resourceName" &&
					key !== "endpoint" &&
					key !== "namespaceName" &&
					key !== "token"
				)
					throw new Error("invalid fields");
			}
			const field = (name: string) => {
				const descriptor = ownDescriptor(entry, name);
				if (
					!descriptor ||
					!hasOwn(descriptor, "value") ||
					!descriptor.enumerable
				)
					throw new Error("invalid field");
				return descriptor.value;
			};
			const bindleName = field("bindleName");
			const resourceName = field("resourceName");
			const endpoint = field("endpoint");
			const namespaceName = field("namespaceName");
			const redacted = field("token");
			if (
				!validIdentity(bindleName) ||
				!validIdentity(resourceName) ||
				typeof endpoint !== "string" ||
				endpoint.length === 0 ||
				endpoint.length > 2048 ||
				apply(trim, endpoint, []) !== endpoint ||
				apply(test, /[\p{Cc}\uD800-\uDFFF]/u, [endpoint]) ||
				apply(test, /[?#]/u, [endpoint]) ||
				typeof namespaceName !== "string" ||
				!apply(test, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, [
					namespaceName,
				]) ||
				typeof redacted !== "object" ||
				redacted === null ||
				!isAlchemyRedacted(redacted)
			)
				throw new Error("invalid definition");
			if (!urlProtocol || !urlHref || !urlUsername || !urlPassword)
				throw new Error("URL inspection unavailable");
			const url = new NamespaceUrl(endpoint);
			const protocol = apply(urlProtocol, url, []);
			const href = apply(urlHref, url, []);
			const username = apply(urlUsername, url, []);
			const password = apply(urlPassword, url, []);
			if (
				(protocol !== "https:" && protocol !== "http:") ||
				typeof href !== "string" ||
				href.length > 2048 ||
				username !== "" ||
				password !== ""
			)
				throw new Error("invalid endpoint");
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Effect's private Redacted registry and exact prototype were checked above.
			const token = Redacted.value(redacted as Redacted.Redacted<unknown>);
			if (
				typeof token !== "string" ||
				token.length === 0 ||
				token.length > 4096 ||
				apply(test, /[\p{Cc}\uD800-\uDFFF]/u, [token]) ||
				Buffer.byteLength(token, "utf8") > 4096
			)
				throw new Error("invalid token");
			for (let priorIndex = 0; priorIndex < result.length; priorIndex++) {
				const prior = result[priorIndex];
				if (
					prior === undefined ||
					(prior.bindleName === bindleName &&
						prior.resourceName === resourceName) ||
					(prior.endpoint === href && prior.namespaceName === namespaceName)
				)
					throw new Error("duplicate namespace");
			}
			const descriptor: PropertyDescriptor = create(null);
			descriptor.value = freeze({
				bindleName,
				resourceName,
				endpoint: href,
				namespaceName,
				token: Redacted.make(token),
			});
			descriptor.enumerable = true;
			descriptor.configurable = true;
			descriptor.writable = true;
			define(result, String(result.length), freeze(descriptor));
		}
		return freeze(result);
	} catch {
		throw new AlchemyIacError(
			"RIVET_NAMESPACE_CONFIG_INVALID",
			"namespace definitions must be bounded, unique own data with a redacted token",
		);
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply */

export function rivetNamespaceBindleMappers<Entrypoint, Requirements>(
	definitions: readonly RivetNamespaceDefinition[],
): Readonly<{
	project: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers>;
}> {
	const captured = captureDefinitions(definitions);
	const definitionFor = (
		input: AlchemyPrimitiveInput<Entrypoint, Requirements>,
	): RivetNamespaceDefinition => {
		for (let index = 0; index < captured.length; index++) {
			const definition = captured[index];
			if (
				definition?.bindleName === input.bindleName &&
				definition.resourceName === input.declaration.name
			)
				return definition;
		}
		throw new AlchemyIacError(
			"RIVET_NAMESPACE_CONFIG_REQUIRED",
			"an explicit Rivet namespace definition is required for the project",
		);
	};
	const validate = (input: AlchemyPrimitiveInput<Entrypoint, Requirements>) => {
		if (
			input.declaration.dependsOn.length !== 0 ||
			objectKeys(input.dependencyDeclarations).length !== 0
		)
			throw new AlchemyIacError(
				"RIVET_DEPENDENCY_UNSUPPORTED",
				"the namespace mapper does not bind project dependencies",
			);
		definitionFor(input);
	};
	const project: AlchemyPrimitiveMapper<Entrypoint, Requirements, Providers> = {
		resourceTypes: freeze(["Rivet.Namespace"]),
		operations: freeze<string[]>([]),
		annotations: freeze<string[]>([]),
		bindsEntrypoint: false,
		limitations: freeze([
			"The namespace does not bind project ownership or resource dependencies.",
			"Rivet cannot delete namespaces; uncertain creation, updates, replacement, removal and destroy are denied.",
		]),
		validate,
		build(input) {
			validate(input);
			if (objectKeys(input.dependencies).length !== 0)
				throw new AlchemyIacError(
					"RIVET_DEPENDENCY_UNSUPPORTED",
					"the namespace mapper does not bind project dependencies",
				);
			const definition = definitionFor(input);
			const resourceId = rivetNamespaceResourceId(
				input.bindleName,
				input.declaration.name,
			);
			return Effect.gen(function* () {
				const primary = yield* Namespace(resourceId, {
					endpoint: definition.endpoint,
					name: definition.namespaceName,
					token: Redacted.make(Redacted.value(definition.token)),
				});
				return {
					primary,
					resources: [primary],
					boundDependencies: [],
				};
			});
		},
	};
	return freeze({ project: freeze(project) });
}
