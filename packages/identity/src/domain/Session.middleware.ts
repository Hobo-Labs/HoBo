import * as Headers from "effect/http/Headers";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import type { CurrentAuthActor } from "./CurrentActor.context.js";

// public-contract: HTTP header carrying signed AuthOnboarding actor proof between client and host middleware.
export const AUTH_ONBOARDING_ACTOR_HEADER = "x-hobo-auth-actor" as const;

export class UnauthorizedAuthRequest extends Schema.TaggedError<
	UnauthorizedAuthRequest,
	{ readonly brand: unique symbol }
>()("UnauthorizedAuthRequest", {
	reason: Schema.NonEmptyString,
}) {}

export class AuthSessionMiddleware extends RpcMiddleware.Service<
	AuthSessionMiddleware,
	{ provides: CurrentAuthActor }
>()("HoboIdentity/AuthSessionMiddleware", {
	error: UnauthorizedAuthRequest,
}) {}

export function authSessionClient(signedProof: string) {
	return RpcMiddleware.layerClient(AuthSessionMiddleware, ({ request, next }) =>
		next({
			...request,
			headers: Headers.set(
				request.headers,
				AUTH_ONBOARDING_ACTOR_HEADER,
				signedProof,
			),
		}),
	);
}
