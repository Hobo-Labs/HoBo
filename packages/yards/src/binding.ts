/**
 * Yard binding rows — the Yard's authoring surface for "which provider product
 * (or connectivity implementation) may satisfy this capability profile here"
 * (ADR-0157). The Yard is the binding authority: a Bindle names a capability
 * profile and says nothing about how it is satisfied; the Yard says which of
 * its provider's offerings are admissible.
 *
 * Two properties of this module are load-bearing and easy to lose:
 *
 * 1. **Rows are a set, not a list.** They are canonicalized by sorting on
 *    `(profile, productId ?? "", connectivityId ?? "")` and duplicate triples
 *    are refused. If authoring order survived into the record it would leak
 *    into selection as a preference, and ADR-0151 forbids any weighted or
 *    ordered scoring — selection is hard gates then lexicographic ordering.
 *    Rows filter; they never rank.
 *
 * 2. **Parse checks grammar and shape only.** It never infers a product's
 *    provider from its id, because that would make a naming convention
 *    load-bearing (ADR-0144 forbids exactly that). Whether a named product
 *    actually belongs to this Yard's provider is a resolution-time gate, run
 *    where the product catalog exists — not here.
 */
import {
	canonicalizeProperties,
	canonicalizeStringList,
	deepFreeze,
	findCredentialKey,
	isPlainObject,
} from "./canonical.js";
import { isJsonString, type JsonObject, type JsonValue } from "./json.js";

export const YARD_BINDING_CONTRACT = "hobo.yard-binding/v1"; // public-contract: contract id on every yard binding record

/** Capability profile id grammar (ADR-0151): <primitive-family>.<path>/v<major> */
export const YARD_BINDING_PROFILE_PATTERN =
	/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\/v[1-9][0-9]*$/u;

export interface YardBindingInput {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly require?: readonly string[];
	readonly properties?: Readonly<JsonObject>;
}

export interface YardBinding {
	readonly contract: typeof YARD_BINDING_CONTRACT;
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly require: readonly string[];
	readonly properties: Readonly<JsonObject>;
}

export type YardBindingErrorCode =
	| "YARD_BINDING_PROFILE_INVALID"
	| "YARD_BINDING_EMPTY_CONSTRAINT"
	| "YARD_BINDING_DUPLICATE"
	| "YARD_BINDING_CREDENTIAL_PROPERTY"
	| "YARD_BINDING_PIN_CONFLICT";

export class YardBindingError extends Error {
	readonly code: YardBindingErrorCode;
	readonly profile?: string;

	constructor(code: YardBindingErrorCode, message: string, profile?: string) {
		super(message);
		this.name = "YardBindingError";
		this.code = code;
		if (profile !== undefined) {
			this.profile = profile;
		}
	}
}

const NO_BINDINGS: readonly YardBinding[] = Object.freeze([]);

/** Parses + canonicalizes a row set. Sorted by (profile, productId ?? "", connectivityId ?? ""). */
export function parseYardBindings(
	input: readonly YardBindingInput[] | undefined,
	options?: { readonly pinnedSlots?: readonly string[] },
): readonly YardBinding[] {
	if (input === undefined) return NO_BINDINGS;
	if (!Array.isArray(input)) {
		throw new TypeError("yard bindings must be an array");
	}
	const pinnedSlots = new Set(options?.pinnedSlots ?? []);
	const rows = input.map((row) => parseRow(row, pinnedSlots));

	const seen = new Set<string>();
	for (const row of rows) {
		const key = duplicateKey(row);
		if (seen.has(key)) {
			throw new YardBindingError(
				"YARD_BINDING_DUPLICATE",
				`duplicate yard binding row for profile ${row.profile} (productId ${row.productId ?? "-"}, connectivityId ${row.connectivityId ?? "-"})`,
				row.profile,
			);
		}
		seen.add(key);
	}

	return deepFreeze([...rows].sort(compareRows));
}

function parseRow(
	row: YardBindingInput,
	pinnedSlots: ReadonlySet<string>,
): YardBinding {
	if (!isPlainObject(row)) {
		throw new TypeError("yard binding row must be an object");
	}
	const profile = row.profile;
	if (!isJsonString(profile) || !YARD_BINDING_PROFILE_PATTERN.test(profile)) {
		throw new YardBindingError(
			"YARD_BINDING_PROFILE_INVALID",
			`yard binding profile must match <primitive-family>.<path>/v<major> (got ${JSON.stringify(profile)})`,
			isJsonString(profile) ? profile : undefined,
		);
	}
	const productId = parseConstraint(profile, "productId", row.productId);
	const connectivityId = parseConstraint(
		profile,
		"connectivityId",
		row.connectivityId,
	);
	if (productId === undefined && connectivityId === undefined) {
		throw new YardBindingError(
			"YARD_BINDING_EMPTY_CONSTRAINT",
			`yard binding row for ${profile} must constrain productId or connectivityId — a row that constrains neither claims a portability guarantee it does not make`,
			profile,
		);
	}
	const properties = parseProperties(profile, row.properties);
	if (pinnedSlots.has(profile)) {
		throw new YardBindingError(
			"YARD_BINDING_PIN_CONFLICT",
			`yard binding row for ${profile} conflicts with a resolver pin on the same slot — pin the slot or bind the capability, not both`,
			profile,
		);
	}

	return {
		contract: YARD_BINDING_CONTRACT,
		profile,
		...(productId !== undefined ? { productId } : undefined),
		...(connectivityId !== undefined ? { connectivityId } : undefined),
		require: parseRequire(profile, row.require),
		properties,
	};
}

/**
 * An absent constraint is legal on its own (the sibling may carry the row);
 * a present-but-empty one is authoring garbage and is refused rather than
 * normalized away, because a silently dropped constraint is a portability lie.
 */
function parseConstraint(
	profile: string,
	field: "productId" | "connectivityId",
	value: JsonValue | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	if (!isJsonString(value)) {
		throw new TypeError(
			`yard binding ${field} must be a string when present (profile ${profile})`,
		);
	}
	if (value.length === 0) {
		throw new YardBindingError(
			"YARD_BINDING_EMPTY_CONSTRAINT",
			`yard binding ${field} must be a non-empty string when present (profile ${profile})`,
			profile,
		);
	}
	return value;
}

function parseRequire(
	profile: string,
	value: readonly string[] | undefined,
): readonly string[] {
	if (value === undefined) return canonicalizeStringList([]);
	if (!Array.isArray(value)) {
		throw new TypeError(
			`yard binding require must be an array (profile ${profile})`,
		);
	}
	for (const entry of value) {
		if (!isJsonString(entry) || entry.length === 0) {
			throw new TypeError(
				`yard binding require entries must be non-empty strings (profile ${profile})`,
			);
		}
	}
	return canonicalizeStringList(value);
}

function parseProperties(
	profile: string,
	value: Readonly<JsonObject> | undefined,
): Readonly<JsonObject> {
	if (value === undefined) return Object.freeze({});
	if (!isPlainObject(value)) {
		throw new TypeError(
			`yard binding properties must be an object (profile ${profile})`,
		);
	}
	const credentialKey = findCredentialKey(value);
	if (credentialKey !== undefined) {
		throw new YardBindingError(
			"YARD_BINDING_CREDENTIAL_PROPERTY",
			`yard binding properties must not contain credentials (forbidden key: ${credentialKey}, profile ${profile}) — reference secrets by locator instead`,
			profile,
		);
	}
	return canonicalizeProperties(value, `yard binding properties (${profile})`);
}

function duplicateKey(row: YardBinding): string {
	return JSON.stringify([
		row.profile,
		row.productId ?? "",
		row.connectivityId ?? "",
	]);
}

function compareRows(a: YardBinding, b: YardBinding): number {
	if (a.profile !== b.profile) return a.profile < b.profile ? -1 : 1;
	const aProduct = a.productId ?? "";
	const bProduct = b.productId ?? "";
	if (aProduct !== bProduct) return aProduct < bProduct ? -1 : 1;
	const aConnectivity = a.connectivityId ?? "";
	const bConnectivity = b.connectivityId ?? "";
	if (aConnectivity !== bConnectivity) {
		return aConnectivity < bConnectivity ? -1 : 1;
	}
	return 0;
}
