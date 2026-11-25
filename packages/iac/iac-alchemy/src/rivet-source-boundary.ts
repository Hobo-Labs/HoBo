import { types } from "node:util";
import { type AnyActorDefinition, Registry } from "rivetkit";

const hasOwnDescriptor = Object.hasOwn;
const isProxy = types.isProxy;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const objectPrototype = Object.prototype;
const freeze = Object.freeze;
const createNull = Object.create;
const defineProperty = Object.defineProperty;
const nativeString = String;
const NativeMap = Map;
const mapSet = NativeMap.prototype.set;
const mapGet = NativeMap.prototype.get;
const registryConfigDescriptor = getOwnDescriptor(Registry.prototype, "config");
const registryConfig =
	registryConfigDescriptor !== undefined &&
	hasOwnDescriptor(registryConfigDescriptor, "get")
		? registryConfigDescriptor.get
		: undefined;
const applyCaptured = Reflect.apply;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: inputs cross a provider boundary and the RivetKit private-field getter is invoked without mutable function methods. */
export function rivetOwnData<Value>(
	input: unknown,
	key: string,
): Value | undefined {
	try {
		if (typeof input !== "object" || input === null || isProxy(input))
			return undefined;
		const descriptor = getOwnDescriptor(input, key);
		if (
			descriptor === undefined ||
			!hasOwnDescriptor(descriptor, "value") ||
			!descriptor.enumerable
		)
			return undefined;
		return descriptor.value as Value;
	} catch {
		return undefined;
	}
}

export function inspectRivetRegistry(input: unknown):
	| Readonly<{
			readonly names: readonly string[];
			readonly actor: (name: string) => AnyActorDefinition | undefined;
	  }>
	| undefined {
	try {
		const configDescriptor = getOwnDescriptor(Registry.prototype, "config");
		if (
			typeof input !== "object" ||
			input === null ||
			isProxy(input) ||
			registryConfig === undefined ||
			getPrototypeOf(input) !== Registry.prototype ||
			getOwnDescriptor(input, "config") !== undefined ||
			configDescriptor === undefined ||
			!hasOwnDescriptor(configDescriptor, "get") ||
			configDescriptor.get !== registryConfig
		)
			return undefined;
		const config: unknown = applyCaptured(registryConfig, input, []);
		const use = rivetOwnData<unknown>(config, "use");
		if (typeof use !== "object" || use === null || isProxy(use))
			return undefined;
		const prototype = getPrototypeOf(use);
		if (prototype !== objectPrototype && prototype !== null) return undefined;
		const keys = ownKeys(use);
		if (keys.length > 256) return undefined;
		const actors = new NativeMap<string, AnyActorDefinition>();
		const names: string[] = [];
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			if (typeof key !== "string") return undefined;
			const field = getOwnDescriptor(use, key);
			if (
				field === undefined ||
				!hasOwnDescriptor(field, "value") ||
				!field.enumerable
			)
				return undefined;
			applyCaptured(mapSet, actors, [key, field.value]);
			const property: PropertyDescriptor = createNull(null);
			property.value = key;
			property.enumerable = true;
			property.configurable = true;
			property.writable = true;
			defineProperty(names, nativeString(index), freeze(property));
		}
		return freeze({
			names: freeze(names),
			actor: (name: string) => applyCaptured(mapGet, actors, [name]),
		});
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
