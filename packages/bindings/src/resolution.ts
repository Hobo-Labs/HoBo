/**
 * Binding resolution records — the plan-phase answer to "which product and
 * which connectivity implementation satisfy this capability profile inside
 * this Yard" (ADR-0157).
 *
 * The Yard is the binding authority: its binding rows are hard filters over
 * ADR-0151 selection, never a ranking input. What survives that filtering is a
 * `BindingResolution` — a decision record, not a decision procedure. It exists
 * so the choice is auditable: it names the Yard, the profile, the chosen
 * product and connectivity, how the capability is realized, which canonical
 * Yard binding row keys constrained the outcome, and how many candidates were
 * considered. `packages/cloud` produces it; this package owns its shape so the
 * planner and the event log cannot drift apart.
 *
 * Everything here is a parse boundary. A resolution arriving from another
 * package is untrusted structurally (it crosses a package seam) and untrusted
 * for content (a provider product id is provider-supplied text). Both are
 * checked before a frozen record exists.
 */

import { parseSecretRef, SecretRefError } from "./secret-ref.js";

export const BINDING_RESOLUTION_CONTRACT = "hobo.binding-resolution/v1"; // public-contract: contract id carried on every resolution record

/**
 * How the capability is realized behind the binding: a first-class provider
 * product (`native`), a HoBo-authored pack running on provider primitives
 * (`pack`), or a shim over a foreign shape (`bridge`).
 */
export const BINDING_REALIZATIONS = Object.freeze([
	"native",
	"pack",
	"bridge",
] as const);

export type BindingRealization = (typeof BINDING_REALIZATIONS)[number];

/**
 * Why a binding could not be resolved. The first three are the Yard binding
 * row refusals (ADR-0157 decision 2): a row is never silently dropped, because
 * a silently-dropped row is a portability lie. The fourth composes with the
 * pre-existing `CapabilityBindingError` code of the same name.
 */
export const BINDING_UNAVAILABLE_CODES = Object.freeze([
	"YARD_BINDING_PRODUCT_UNKNOWN",
	"YARD_BINDING_PROVIDER_MISMATCH",
	"YARD_BINDING_EXCLUDED_ALL",
	"NO_COMPATIBLE_BINDING",
] as const);

export type BindingUnavailableCode = (typeof BINDING_UNAVAILABLE_CODES)[number];

export interface BindingResolution {
	readonly contract: typeof BINDING_RESOLUTION_CONTRACT;
	readonly yardId: string;
	readonly profile: string;
	readonly productId: string;
	readonly connectivityId: string;
	readonly realization: BindingRealization;
	/** Canonical Yard binding row keys that constrained this decision. */
	readonly appliedRows: readonly string[];
	readonly consideredCount: number;
}

export const BINDING_RECORD_ERROR_CODES = Object.freeze([
	"BINDING_RECORD_INVALID",
	"BINDING_RECORD_CREDENTIAL_VALUE",
	"BINDING_RECORD_REMEDIATION_MISSING",
] as const);

export type BindingRecordErrorCode =
	(typeof BINDING_RECORD_ERROR_CODES)[number];

export class BindingRecordError extends Error {
	readonly code: BindingRecordErrorCode;

	constructor(code: BindingRecordErrorCode, message: string) {
		// The offending value is deliberately not interpolated: a rejected field
		// is frequently the plaintext credential that got it rejected.
		super(message);
		this.name = "BindingRecordError";
		this.code = code;
	}
}

/** Unicode "Other, control" — C0, DEL, and C1. Log-forging sequences live here. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/**
 * Codepoint ordering, not `localeCompare`. Canonical row keys end up in a
 * content hash and in an audit trail, so the ordering must not depend on the
 * host's collation locale.
 */
export function compareCanonical(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * Secret screening, delegated to the package's existing plaintext-credential
 * detector rather than a second copy of it: `parseSecretRef` already knows what
 * a connection string, bearer token, PEM private key, or provider API key looks
 * like, and reports it as `SECRET_REFERENCE_EMBEDS_VALUE`. Every other parse
 * failure means "this is not a secret locator", which is exactly what an
 * ordinary field value is.
 */
function assertNoSecretValue(field: string, value: string): void {
	try {
		parseSecretRef(value);
	} catch (error) {
		if (
			error instanceof SecretRefError &&
			error.code === "SECRET_REFERENCE_EMBEDS_VALUE"
		) {
			throw new BindingRecordError(
				"BINDING_RECORD_CREDENTIAL_VALUE",
				`${field} looks like a plaintext credential; deposit it into secret custody and carry the locator instead`,
			);
		}
	}
}

/**
 * The one field parser every record in this module funnels through: non-empty,
 * free of control characters (which forge log lines), and free of anything
 * shaped like a credential.
 */
type ParsedScalar = string | number | null | undefined;

function isString(value: ParsedScalar): value is string {
	return value === String(value);
}

function isNumber(value: ParsedScalar): value is number {
	return Number.isInteger(value) && value === Number(value);
}

export function assertNonSecretField(
	field: string,
	value: ParsedScalar,
): string {
	if (!isString(value) || value.trim().length === 0) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			`${field} must be a non-empty string`,
		);
	}
	if (CONTROL_CHARACTERS.test(value)) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			`${field} must not contain control characters`,
		);
	}
	assertNoSecretValue(field, value);
	return value;
}

export function assertMember<T extends string>(
	field: string,
	value: ParsedScalar,
	allowed: readonly T[],
): T {
	if (!isString(value) || !allowed.some((candidate) => candidate === value)) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			`${field} must be one of ${allowed.join(", ")}`,
		);
	}
	// SAFETY: the membership check above proves value belongs to allowed.
	return value as T;
}

export function assertCount(
	field: string,
	value: ParsedScalar,
	minimum: number,
): number {
	if (!isNumber(value) || value < minimum) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			`${field} must be an integer >= ${minimum}`,
		);
	}
	return value;
}

/**
 * A Yard binding row's canonical key: the same `(profile, productId ?? "",
 * connectivityId ?? "")` tuple `@hobo/yards` canonicalizes rows by (§1.1),
 * rendered as one string so it can be carried in a record and an event.
 */
const ROW_KEY_SEPARATOR = "|";
const ROW_KEY_SEGMENT = /^[^|\p{Cc}]*$/u;

export function yardBindingRowKey(row: {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
}): string {
	return parseYardBindingRowKey(
		[row.profile, row.productId ?? "", row.connectivityId ?? ""].join(
			ROW_KEY_SEPARATOR,
		),
	);
}

export function parseYardBindingRowKey(value: string | number): string {
	if (!isString(value)) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			"applied row key must be a string",
		);
	}
	const segments = value.split(ROW_KEY_SEPARATOR);
	const profile = segments[0];
	const productId = segments[1];
	const connectivityId = segments[2];
	if (
		segments.length !== 3 ||
		profile === undefined ||
		productId === undefined ||
		connectivityId === undefined
	) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			"applied row key must be <profile>|<productId>|<connectivityId>",
		);
	}
	if (profile.length === 0) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			"applied row key must name a capability profile",
		);
	}
	// Mirrors YARD_BINDING_EMPTY_CONSTRAINT: a row constraining nothing is
	// meaningless and would read as a portability claim it does not make.
	if (productId.length === 0 && connectivityId.length === 0) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			"applied row key must constrain a product or a connectivity implementation",
		);
	}
	for (const segment of segments) {
		if (!ROW_KEY_SEGMENT.test(segment)) {
			throw new BindingRecordError(
				"BINDING_RECORD_INVALID",
				"applied row key segments must not contain control characters",
			);
		}
	}
	assertNoSecretValue("applied row key", value);
	return value;
}

/**
 * Deduplicated, sorted, frozen. Registration order is never signal.
 *
 * Ordering is segment-wise on `(profile, productId, connectivityId)` — the same
 * tuple order `parseYardBindings` canonicalizes rows by — rather than raw string
 * order, which would sort `a|b|` before `a||c` in one system and after it in the
 * other because `"|"` outranks most product-id characters by codepoint.
 */
export function canonicalizeAppliedRows(
	values: readonly (string | number)[],
): readonly string[] {
	const keys = new Set<string>();
	for (const value of values) keys.add(parseYardBindingRowKey(value));
	return Object.freeze(
		[...keys].sort((a, b) => {
			const left = a.split(ROW_KEY_SEPARATOR);
			const right = b.split(ROW_KEY_SEPARATOR);
			for (let index = 0; index < 3; index += 1) {
				const order = compareCanonical(left[index] ?? "", right[index] ?? "");
				if (order !== 0) return order;
			}
			return 0;
		}),
	);
}

/**
 * Parse boundary for a resolution decision. Returns a frozen derived record;
 * an invalid input throws rather than yielding a partially-valid object.
 */
type ResolutionInput = {
	contract?: ParsedScalar;
	yardId?: ParsedScalar;
	profile?: ParsedScalar;
	productId?: ParsedScalar;
	connectivityId?: ParsedScalar;
	realization?: ParsedScalar;
	appliedRows?: readonly string[] | string;
	consideredCount?: ParsedScalar;
};

type ResolutionBoundary = ResolutionInput | null | string | number | undefined;

function isResolutionObject(
	value: ResolutionBoundary,
): value is ResolutionInput {
	return (
		value !== null &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

export function parseBindingResolution(
	value: ResolutionBoundary,
): BindingResolution {
	if (!isResolutionObject(value)) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			"binding resolution must be an object",
		);
	}
	const {
		contract,
		yardId,
		profile,
		productId,
		connectivityId,
		realization,
		appliedRows,
		consideredCount,
		// SAFETY: isResolutionObject establishes the object boundary; its fields are parsed below.
	} = value;

	if (contract !== BINDING_RESOLUTION_CONTRACT) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			`binding resolution contract must be ${BINDING_RESOLUTION_CONTRACT}`,
		);
	}
	if (!Array.isArray(appliedRows)) {
		throw new BindingRecordError(
			"BINDING_RECORD_INVALID",
			"binding resolution appliedRows must be an array",
		);
	}

	return Object.freeze({
		contract: BINDING_RESOLUTION_CONTRACT,
		yardId: assertNonSecretField("yardId", yardId),
		profile: assertNonSecretField("profile", profile),
		productId: assertNonSecretField("productId", productId),
		connectivityId: assertNonSecretField("connectivityId", connectivityId),
		realization: assertMember("realization", realization, BINDING_REALIZATIONS),
		appliedRows: canonicalizeAppliedRows(appliedRows),
		// A resolution that considered nothing is incoherent: something was
		// chosen, so at least one candidate existed to choose it from.
		consideredCount: assertCount("consideredCount", consideredCount, 1),
	});
}
