// Guest SDK for hobo:resolver components: the WIT types in their JSON
// lowering, and small helpers authors use inside a guest. A guest never
// handles credential material: it passes the request's `credentialRef` to
// `authorizedFetch` and the host attaches the credential.
import type {
	ResolverGuestExports,
	ResolverGuestImports,
	ResolverGuestModule,
	WitHttpResponse,
	WitResolveOutcome,
	WitResolverAction,
	WitResult,
} from "./types.js";

export type * from "./types.js";

/** Identity helper that pins a guest program to the WIT types. */
export function defineResolverGuest(
	instantiate: (imports: ResolverGuestImports) => ResolverGuestExports,
): ResolverGuestModule {
	return Object.freeze({ instantiate });
}

/** `result::ok` */
export function ok<T>(value: T): WitResult<T> {
	return { ok: value };
}

/** `result::err(resolver-error::rejected)` */
export function rejected<T>(message: string): WitResult<T> {
	return { err: { tag: "rejected", val: message } };
}

/** `result::err(resolver-error::unsupported)` */
export function unsupported<T>(message: string): WitResult<T> {
	return { err: { tag: "unsupported", val: message } };
}

/** A resolve-outcome with canonical (key-sorted) outputs. */
export function outcome(
	action: WitResolverAction,
	physicalId: string,
	outputs: Readonly<Record<string, string | number | boolean>>,
	diagnostics: readonly string[] = [],
): WitResolveOutcome {
	const sorted: Record<string, string | number | boolean> = {};
	for (const key of Object.keys(outputs).sort()) {
		const value = outputs[key];
		if (value !== undefined) sorted[key] = value;
	}
	return {
		action,
		physicalId,
		outputsJson: JSON.stringify(sorted),
		diagnostics,
	};
}

/** Case-insensitive header lookup on a response. */
export function header(
	response: WitHttpResponse,
	name: string,
): string | undefined {
	const wanted = name.toLowerCase();
	return response.headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** Parse a desired/observed JSON object handed to the guest. */
export function properties(
	json: string | null,
): Readonly<Record<string, string | number | boolean>> {
	if (json === null) return {};
	const parsed: Record<string, string | number | boolean> = JSON.parse(json);
	return parsed;
}
