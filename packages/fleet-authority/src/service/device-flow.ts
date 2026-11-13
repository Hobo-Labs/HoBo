/**
 * The device-code variant of sign-in is refused for any fleet whose policy
 * requires dual control (§6.5, E17). The enrollment request does not say
 * which flow minted its person token, so the service reads it from the
 * journal (§7.5): the person's `fleet.PersonSignedIn` events on
 * `fleet-person-<sha256(principal)>` name the sign-in state and key, and that
 * sign-in's `fleet.SignInStarted` says whether it was a device-code flow.
 * A token is from the device flow when any live sign-in of its key was.
 */
import { createHash } from "node:crypto";
import type { JsonObject, JsonValue, PrincipalRef } from "@hobo/core";
import type { FleetEventStore } from "@hobo/fleet";

// public-contract: the stream prefixes of design §7.5.
const PERSON_STREAM_PREFIX = "fleet-person-";
// public-contract: the stream prefixes of design §7.5.
const SIGN_IN_STREAM_PREFIX = "fleet-signin-";

function personStream(principal: PrincipalRef): string {
	const digest = createHash("sha256")
		.update(`${principal.kind}:${principal.id}`, "utf8")
		.digest("base64url");
	return `${PERSON_STREAM_PREFIX}${digest}`;
}

const tagOf = Object.prototype.toString;

function field<T>(data: T, name: string): JsonValue | undefined {
	if (data === null || Array.isArray(data)) return undefined;
	if (tagOf.call(data) !== "[object Object]") return undefined;
	// SAFETY: event data is JSON (the store's contract); a plain object of it is a JsonObject.
	return (data as JsonObject)[name];
}

function isText(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}

/** True when the person token bound to `jkt` came from a device-code sign-in. */
export async function signedInByDeviceFlow(
	store: FleetEventStore,
	principal: PrincipalRef,
	jkt: string,
): Promise<boolean> {
	const states: string[] = [];
	for await (const event of store.read(personStream(principal))) {
		if (event.type !== "fleet.PersonSignedIn") continue;
		const state = field(event.data, "state");
		if (field(event.data, "jkt") === jkt && isText(state)) states.push(state);
	}
	for (const state of states) {
		for await (const event of store.read(`${SIGN_IN_STREAM_PREFIX}${state}`)) {
			if (event.type !== "fleet.SignInStarted") continue;
			if (field(event.data, "deviceFlow") === true) return true;
			break;
		}
	}
	return false;
}
