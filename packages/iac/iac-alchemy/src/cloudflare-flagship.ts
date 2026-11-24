import { createHash } from "node:crypto";
import { types } from "node:util";
import { AlchemyIacError } from "./plan.js";

export interface CloudflareFlagshipBoolean {
	readonly bindleName: string;
	readonly resourceName: string;
	readonly enabled: boolean;
	readonly defaultValue: boolean;
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: provider settings cross an external data boundary. */
function validNames(bindleName: string, resourceName: string): boolean {
	return (
		typeof bindleName === "string" &&
		bindleName.length > 0 &&
		bindleName.length <= 200 &&
		bindleName.trim() === bindleName &&
		!/[\p{Cc}]/u.test(bindleName) &&
		typeof resourceName === "string" &&
		/^[a-z][a-z0-9_-]{0,62}$/u.test(resourceName)
	);
}

export function cloudflareFlagshipResourceIds(
	bindleName: string,
	resourceName: string,
) {
	if (!validNames(bindleName, resourceName))
		throw new AlchemyIacError(
			"FLAGSHIP_CONFIG_INVALID",
			"a bounded bindle and lowercase flag key are required",
		);
	const digest = createHash("sha256")
		.update(JSON.stringify([bindleName, resourceName]))
		.digest("hex");
	return Object.freeze({
		app: `hobo-flag-app-${digest}`,
		flag: `hobo-flag-${digest}`,
	});
}

export function captureCloudflareFlagshipFlags(
	input: readonly CloudflareFlagshipBoolean[] | undefined,
): readonly CloudflareFlagshipBoolean[] {
	if (input === undefined) return Object.freeze([]);
	try {
		if (
			types.isProxy(input) ||
			!Array.isArray(input) ||
			Object.getPrototypeOf(input) !== Array.prototype ||
			input.length > 256 ||
			Reflect.ownKeys(input).length !== input.length + 1
		)
			throw new Error("invalid array");
		const entries: CloudflareFlagshipBoolean[] = [];
		const seen = new Set<string>();
		for (let index = 0; index < input.length; index++) {
			const element = Object.getOwnPropertyDescriptor(input, String(index));
			if (
				element === undefined ||
				!Object.hasOwn(element, "value") ||
				!element.enumerable
			)
				throw new Error("invalid element");
			const value = element.value;
			if (
				typeof value !== "object" ||
				value === null ||
				types.isProxy(value) ||
				Array.isArray(value)
			)
				throw new Error("invalid record");
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null)
				throw new Error("invalid prototype");
			const keys = Reflect.ownKeys(value);
			if (
				keys.length !== 4 ||
				keys.some(
					(key) =>
						typeof key !== "string" ||
						!["bindleName", "resourceName", "enabled", "defaultValue"].includes(
							key,
						),
				)
			)
				throw new Error("invalid fields");
			const data = (key: string) => {
				const field = Object.getOwnPropertyDescriptor(value, key);
				if (
					field === undefined ||
					!Object.hasOwn(field, "value") ||
					!field.enumerable
				)
					throw new Error("invalid field");
				return field.value;
			};
			const bindleName = data("bindleName");
			const resourceName = data("resourceName");
			const enabled = data("enabled");
			const defaultValue = data("defaultValue");
			if (
				!validNames(bindleName, resourceName) ||
				typeof enabled !== "boolean" ||
				typeof defaultValue !== "boolean"
			)
				throw new Error("invalid definition");
			const identity = JSON.stringify([bindleName, resourceName]);
			if (seen.has(identity)) throw new Error("duplicate definition");
			seen.add(identity);
			entries.push(
				Object.freeze({ bindleName, resourceName, enabled, defaultValue }),
			);
		}
		return Object.freeze(entries);
	} catch {
		throw new AlchemyIacError(
			"FLAGSHIP_CONFIG_INVALID",
			"Flagship definitions must be bounded, unique own data",
		);
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */
