/* oxlint-disable anti-slop/no-reflect-get, anti-slop/no-runtime-typeof -- SAFETY: the forwarding proxy resolves members of the bound module by name; functions are bound to it, nothing else is inspected. */
// Late binding for the module graph's dependency cycles (WP18, plan 0024).
//
// The frozen factory signatures form cycles: the pipeline controller requests
// promotions, the promotion service reads pipelines, and fan-out schedules
// promotions. Composition hands the earlier factory a forwarding reference
// and binds it once the later module exists. Calling the reference before
// binding is a typed `compose-unbound` failure, never a silent no-op.
import { ComposeError } from "./errors.js";

export type LateBound<T extends object> = Readonly<{
	/** Forwarding reference; every member resolves against the bound target. */
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
	// The proxy target is a plain object; members are looked up on the bound
	// module at call time so a reference captured early sees the real module.
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
