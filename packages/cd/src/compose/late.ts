/* oxlint-disable anti-slop/no-reflect-get, anti-slop/no-runtime-typeof -- SAFETY: the forwarding proxy resolves members of the bound module by name; functions are bound to it, nothing else is inspected. */
import { ComposeError } from "./errors.js";

export type LateBound<T extends object> = Readonly<{
	ref: T;
	bind(target: T): void;
	bound(): boolean;
}>;

export function lateBound<T extends object>(name: string): LateBound<T> {
	let target: T | undefined;
	const resolve = (): T => {
		if (target === undefined) {
			throw new ComposeError(
				"compose-unbound",
				`${name} was used before composition bound it`,
				name,
			);
		}
		return target;
	};
	const ref = new Proxy(
		{},
		{
			get(_shell, property) {
				if (property === "then") return undefined;
				const real = resolve();
				const value: unknown = Reflect.get(real, property, real);
				return typeof value === "function" ? value.bind(real) : value;
			},
			has(_shell, property) {
				return Reflect.has(resolve(), property);
			},
		},
	);
	return Object.freeze({
		// SAFETY: the proxy forwards every member of T to the bound module.
		ref: ref as T,
		bind(next: T) {
			if (target !== undefined) {
				throw new ComposeError(
					"compose-rebound",
					`${name} is already bound`,
					name,
				);
			}
			target = next;
		},
		bound: () => target !== undefined,
	});
}
