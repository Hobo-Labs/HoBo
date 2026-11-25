import { createHash } from "node:crypto";
import type { JsonObject, JsonValue, PrincipalRef } from "@hobo/core";
import type { FleetEventStore } from "@hobo/fleet";

// public-contract: the stream prefixes
const PERSON_STREAM_PREFIX = "fleet-person-";
// public-contract: the stream prefixes
const SIGN_IN_STREAM_PREFIX = "fleet-signin-";

function personStream(principal: PrincipalRef): string {
	const digest = createHash("sha256")
		.update(`${principal.kind}:${principal.id}`, "utf8")
		.digest("base64url");
	return `${PERSON_STREAM_PREFIX}${digest}`;
}

const tagOf = Object.prototype.toString;

function isObject<T>(data: T): data is T & JsonObject {
	return (
		data !== null &&
		!Array.isArray(data) &&
		tagOf.call(data) === "[object Object]"
	);
}

function field<T>(data: T, name: string): JsonValue | undefined {
	return isObject(data) ? data[name] : undefined;
}

function isText(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}

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
