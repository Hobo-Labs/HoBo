/**
 * What the fleet knows about a member: an opaque id, and why it did not answer.
 *
 * Nothing here names a product, a host or a credential. A host maps its own
 * failures (a SQL state, an HTTP status, a socket code) to one of the classes
 * below with a classifier of its own; the fleet never sees the error text.
 */
import { BackendFleetError } from "./errors.js";

const BACKEND_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/** A backend id is opaque to the fleet; it only has to be a stable short token. */
export function parseFleetBackendId(value: string, field = "backend"): string {
	if (!BACKEND_ID.test(value))
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			`${field} must be a short lower-case token`,
			{ detail: { field } },
		);
	return value;
}

/** Why a backend did not answer. `unknown` is a failure nobody has classified. */
export const FLEET_FAILURE_CLASSES = [
	"unreachable",
	"quota-exhausted",
	"auth",
	"unknown",
] as const;

export type FleetFailureClass = (typeof FLEET_FAILURE_CLASSES)[number];

/**
 * Maps a failed call to a class. Only the class leaves it: a driver's message
 * can carry a host name or a connection string.
 */
export type FleetFailureClassifier = (
	error: Error | undefined,
) => FleetFailureClass;

/** The classifier a register uses when its host gives none. */
export const unclassifiedFailure: FleetFailureClassifier = () => "unknown";
