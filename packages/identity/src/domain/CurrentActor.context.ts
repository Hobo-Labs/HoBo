import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PrincipalId } from "./ids.js";

export const AuthActor = Schema.Union([
	Schema.TaggedStruct("Owner", {
		principalId: PrincipalId,
	}),
	Schema.TaggedStruct("Agent", {
		principalId: PrincipalId,
	}),
	Schema.TaggedStruct("System", {}),
]);
export type AuthActor = typeof AuthActor.Type;

export function ownerActor(principalId: PrincipalId): AuthActor {
	return { _tag: "Owner", principalId };
}

export function agentActor(principalId: PrincipalId): AuthActor {
	return { _tag: "Agent", principalId };
}

export const SYSTEM_AUTH_ACTOR: AuthActor = { _tag: "System" };

export class CurrentAuthActor extends Domain.RequestContext<CurrentAuthActor>()(
	"HoboIdentity/CurrentAuthActor",
	AuthActor,
) {}

export class NotWorkspaceOwner extends Domain.Rejection("NotWorkspaceOwner", {
	expectedOwner: Schema.NullOr(PrincipalId),
	caller: Schema.NullOr(PrincipalId),
}) {}

export const requireWorkspaceOwner = Effect.fn(function* (
	expectedOwner: PrincipalId | null,
) {
	const actor = yield* CurrentAuthActor;
	if (actor._tag === "System") {
		return undefined;
	}
	if (actor._tag === "Owner" && expectedOwner === actor.principalId) {
		return undefined;
	}
	return yield* new NotWorkspaceOwner({
		expectedOwner,
		caller: actor.principalId,
	});
});
