/**
 * The closed set of fleet error codes (design §7.6) and the two error classes
 * the package throws: `FleetParseError` from the `parse*` constructors, and
 * `FleetNotImplemented` from every entry point whose lane has not landed yet.
 *
 * Everything that crosses a port returns an `Outcome` carrying a
 * `FleetFailure` with one of these codes; nothing here is thrown across a port.
 */

// public-contract: the wire `FleetError.code` values of §7.6; clients match on them.
export const FLEET_ERROR_CODES = [
	"invalid-request",
	"unauthenticated",
	"proof-invalid",
	"proof-replayed",
	"forbidden",
	"token-invalid",
	"token-used",
	"token-expired",
	"fleet-unknown",
	"member-unknown",
	"work-unknown",
	"fleet-policy",
	"quota-exceeded",
	"attestation-insufficient",
	"key-known",
	"approval-pending",
	"member-suspended",
	"member-locked",
	"member-revoked",
	"generation-mismatch",
	"incarnation-stale",
	"agent-outdated",
	"conflict",
	"residency-denied",
	"evidence-invalid",
	"sandbox-inadequate",
	"order-invalid",
	"assignment-mismatch",
	"session-denied",
	"no-majority",
	"undecided",
	"sign-in-pending",
	"name-taken",
	"unavailable",
] as const;

export type FleetErrorCode = (typeof FLEET_ERROR_CODES)[number];

/**
 * The HTTP status of each code (§7.6, in brackets there). Codes that never
 * leave a device (`sandbox-inadequate`, `order-invalid`, `assignment-mismatch`,
 * `session-denied`, `no-majority`, `undecided`) have none.
 */
export const FLEET_ERROR_HTTP_STATUS = {
	"invalid-request": 400,
	unauthenticated: 401,
	"proof-invalid": 401,
	"proof-replayed": 401,
	forbidden: 403,
	"token-invalid": 401,
	"token-used": 409,
	"token-expired": 410,
	"fleet-unknown": 404,
	"member-unknown": 404,
	"work-unknown": 404,
	"fleet-policy": 403,
	"quota-exceeded": 429,
	"attestation-insufficient": 403,
	"key-known": 409,
	"approval-pending": 409,
	"member-suspended": 403,
	"member-locked": 423,
	"member-revoked": 410,
	"generation-mismatch": 423,
	"incarnation-stale": 401,
	"agent-outdated": 426,
	conflict: 409,
	"residency-denied": 403,
	"evidence-invalid": 400,
	"sandbox-inadequate": undefined,
	"order-invalid": undefined,
	"assignment-mismatch": undefined,
	"session-denied": undefined,
	"no-majority": undefined,
	undecided: undefined,
	"sign-in-pending": 428,
	"name-taken": 409,
	unavailable: 503,
} as const satisfies Readonly<Record<FleetErrorCode, number | undefined>>;

/** Thrown by the `parse*` constructors of `ids.ts`; always `invalid-request`. */
export class FleetParseError extends Error {
	readonly code: FleetErrorCode = "invalid-request";
	readonly field: string;

	constructor(field: string, message: string) {
		super(message);
		this.name = "FleetParseError";
		this.field = field;
	}
}

/**
 * Thrown by an entry point whose body its lane has not written yet. The
 * contract commit ships every entry point of §7.3 with this body; each lane
 * replaces the bodies it owns.
 */
export class FleetNotImplemented extends Error {
	readonly entryPoint: string;

	constructor(entryPoint: string) {
		super(`${entryPoint} is not implemented yet (HoBo Fleet contract commit)`);
		this.name = "FleetNotImplemented";
		this.entryPoint = entryPoint;
	}
}
