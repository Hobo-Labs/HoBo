/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: application results cross the native Response boundary here. */
import { types } from "node:util";

const isProxy = types.isProxy;
const getPrototype = Object.getPrototypeOf;
const descriptor = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const create = Object.create;
const freeze = Object.freeze;
const apply = Reflect.apply;
const NativeResponse = Response;
const responseJson = NativeResponse.json;
const responsePrototype = NativeResponse.prototype;
const statusGetter = descriptor(responsePrototype, "status")?.get;

const nonThenable: PropertyDescriptor = create(null);
nonThenable.value = undefined;
nonThenable.writable = false;
nonThenable.configurable = false;
nonThenable.enumerable = false;
freeze(nonThenable);

export function rivetIsResponse(value: unknown): value is Response {
	try {
		if (typeof value !== "object" || value === null || isProxy(value))
			return false;
		let current = getPrototype(value);
		let found = false;
		for (let depth = 0; depth < 32 && current !== null; depth++) {
			if (isProxy(current)) return false;
			if (current === responsePrototype) {
				found = true;
				break;
			}
			current = getPrototype(current);
		}
		return (
			found &&
			statusGetter !== undefined &&
			typeof apply(statusGetter, value, []) === "number"
		);
	} catch {
		return false;
	}
}

export function rivetProtectResponse(value: unknown): value is Response {
	if (!rivetIsResponse(value)) return false;
	try {
		define(value, "then", nonThenable);
		return true;
	} catch {
		return false;
	}
}

export interface RivetHttpOutcomes {
	readonly forbidden: Response;
	readonly authorizationNotStarted: Response;
	readonly authorizationPossiblyCompleted: Response;
	readonly authorizationDeniedPossiblyCompleted: Response;
	readonly applicationPossiblyCompleted: Response;
}

const forbiddenInit: ResponseInit = create(null);
forbiddenInit.status = 403;
freeze(forbiddenInit);
const unavailableInit: ResponseInit = create(null);
unavailableInit.status = 503;
freeze(unavailableInit);

function failure(
	error:
		| "authorization-unavailable"
		| "authorization-denied"
		| "application-failed",
	execution: "not-started" | "possibly-completed",
	init: ResponseInit = unavailableInit,
): Response {
	const body: { error: string; execution: string } = create(null);
	body.error = error;
	body.execution = execution;
	freeze(body);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the captured native JSON constructor returns an ordinary Response.
	const response = apply(responseJson, NativeResponse, [
		body,
		init,
	]) as Response;
	if (!rivetProtectResponse(response)) throw new TypeError("invalid response");
	freeze(response);
	return response;
}

export function rivetCreateHttpNotStarted(): Response {
	return failure("authorization-unavailable", "not-started");
}

export function rivetCreateHttpOutcomes(): RivetHttpOutcomes {
	const forbidden = new NativeResponse("Forbidden", forbiddenInit);
	if (!rivetProtectResponse(forbidden)) throw new TypeError("invalid response");
	freeze(forbidden);
	const result: {
		forbidden: Response;
		authorizationNotStarted: Response;
		authorizationPossiblyCompleted: Response;
		authorizationDeniedPossiblyCompleted: Response;
		applicationPossiblyCompleted: Response;
	} = create(null);
	result.forbidden = forbidden;
	result.authorizationNotStarted = failure(
		"authorization-unavailable",
		"not-started",
	);
	result.authorizationPossiblyCompleted = failure(
		"authorization-unavailable",
		"possibly-completed",
	);
	result.authorizationDeniedPossiblyCompleted = failure(
		"authorization-denied",
		"possibly-completed",
		forbiddenInit,
	);
	result.applicationPossiblyCompleted = failure(
		"application-failed",
		"possibly-completed",
	);
	return freeze(result);
}
