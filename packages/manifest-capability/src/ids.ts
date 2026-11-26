export const BINDLE_PRIMITIVES = [
	"web",
	"api",
	"service",
	"data",
	"kv",
	"bucket",
	"queue",
	"topic",
	"secretRef",
	"webhook",
] as const;

export type BindlePrimitive = (typeof BINDLE_PRIMITIVES)[number];

export const BINDLE_RUNTIMES = [
	"wasm",
	"oci",
	"vm_iaas",
	"paas",
	"serverless_faas",
] as const;

export type BindleRuntime = (typeof BINDLE_RUNTIMES)[number];

export const REALIZATION_KINDS = ["native", "pack", "bridge"] as const;

export type RealizationKind = (typeof REALIZATION_KINDS)[number];

declare const profileIdBrand: unique symbol;

/** A parsed profile ID. Construct only through {@link parseProfileId}. */
export type ProfileId = string & { readonly [profileIdBrand]: "ProfileId" };

export type ParsedProfileId = {
	readonly id: ProfileId;
	readonly primitive: BindlePrimitive;
	readonly path: readonly string[];
	readonly major: number;
};

export class ProfileIdError extends Error {
	readonly code = "INVALID_CAPABILITY_PROFILE_ID" as const;
	readonly input: string;

	constructor(input: string, detail: string) {
		super(`invalid capability profile id ${JSON.stringify(input)}: ${detail}`);
		this.name = "ProfileIdError";
		this.input = input;
	}
}

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PRIMITIVE_BY_SEGMENT = new Map<string, BindlePrimitive>(
	BINDLE_PRIMITIVES.map((primitive) => [primitive.toLowerCase(), primitive]),
);
const PRIMITIVE_ALIASES = new Map<string, BindlePrimitive>([
	["realtime", "webhook"],
	["secret-ref", "secretRef"],
	["lifecycle", "queue"],
	["schedule", "service"],
]);

export function parseProfileId(input: string): ParsedProfileId {
	if (String(input) !== input || input.length === 0) {
		throw new ProfileIdError(String(input), "must be a non-empty string");
	}
	if (input !== input.trim()) {
		throw new ProfileIdError(
			input,
			"must not have leading/trailing whitespace",
		);
	}
	if (input !== input.toLowerCase()) {
		throw new ProfileIdError(input, "must be lowercase (canonical form)");
	}
	const slash = input.lastIndexOf("/");
	if (slash <= 0 || slash === input.length - 1) {
		throw new ProfileIdError(input, "must end with /v<major>");
	}
	const namePart = input.slice(0, slash);
	const versionPart = input.slice(slash + 1);
	const versionMatch = /^v([1-9][0-9]*)$/u.exec(versionPart);
	if (!versionMatch) {
		throw new ProfileIdError(
			input,
			`version segment ${JSON.stringify(versionPart)} must be v<major> with major >= 1`,
		);
	}
	const path = namePart.split(".");
	if (path.length < 2) {
		throw new ProfileIdError(
			input,
			"must be <primitive-family>.<name> before the version",
		);
	}
	for (const segment of path) {
		if (!SEGMENT.test(segment)) {
			throw new ProfileIdError(
				input,
				`segment ${JSON.stringify(segment)} must match ${SEGMENT.source}`,
			);
		}
	}
	const [family = ""] = path;
	const primitive =
		PRIMITIVE_BY_SEGMENT.get(family) ?? PRIMITIVE_ALIASES.get(family);
	if (primitive === undefined) {
		throw new ProfileIdError(
			input,
			`unknown primitive family ${JSON.stringify(family)}`,
		);
	}
	return {
		id: input as ProfileId,
		primitive,
		path,
		major: Number(versionMatch[1]),
	};
}

export function tryParseProfileId(input: string): ParsedProfileId | undefined {
	try {
		return parseProfileId(input);
	} catch {
		return undefined;
	}
}

export function isBindlePrimitive(value: string): value is BindlePrimitive {
	return BINDLE_PRIMITIVES.some((primitive) => primitive === value);
}

export function isBindleRuntime(value: string): value is BindleRuntime {
	return BINDLE_RUNTIMES.some((runtime) => runtime === value);
}
