import { isJsonString, isJsonBoolean, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
/**
 * Parse, don't validate — the one parser boundary of this proof.
 *
 * Untrusted inputs on the real call path:
 *   1. the `deployConvexApp` result: in the Cloud and self-hosted lanes its
 *      `deploymentUrl` is scraped out of `convex deploy` stdout, so the shape
 *      is provider text, not a HoBo value;
 *   2. the ambient environment for the fail-closed WorkOS AuthKit + deploy-key
 *      preflight (names only, never material);
 *   3. `convexImpedanceFindings` output, which planners treat as evidence.
 *
 * Each crosses this boundary exactly once and becomes a parsed derived type —
 * `DeployReceipt`, `ShipPreflight`, `ImpedanceRecord` — carrying branded
 * `DeploymentName` / `DeploymentUrl` / `EnvName` / `ConvexAppRoot` values.
 * `src/ship.ts` and the tests accept only those derived domain types, so an
 * unparsed provider response is unrepresentable past this file. The rules
 * below are the executable mirror of architecture/deploy_adapter.cue; changing
 * one without the other is a bug.
 */

declare const brandTag: unique symbol;
type Branded<Tag extends string> = string & { readonly [brandTag]: Tag };

/** Repo-relative Convex app directory (no absolute path, no `..` escape). */
export type ConvexAppRoot = Branded<"ConvexAppRoot">;
/** DNS-label deployment name, usable as a `*.convex.cloud` subdomain. */
export type DeploymentName = Branded<"DeploymentName">;
/** Absolute Convex Cloud or self-hosted deployment URL. */
export type DeploymentUrl = Branded<"DeploymentUrl">;
/** Environment variable NAME — this proof never carries values. */
export type EnvName = Branded<"EnvName">;

/** #DeployMode. */
export type DeployMode = "cloud" | "self-hosted" | "mock";
/** #ImpedanceSeverity. */
export type ImpedanceSeverity = "info" | "warn" | "block";
/** #ShipPhase — the lifecycle src/ship.ts walks. */
export type ShipPhase =
	| "requested"
	| "preflighted"
	| "deploying"
	| "deployed"
	| "refused";

/** #ShipTransitions — the only phase moves the ship path may take. */
export const SHIP_TRANSITIONS: Readonly<Record<ShipPhase, readonly ShipPhase[]>> =
	Object.freeze({
		requested: Object.freeze(["preflighted", "refused"] as const),
		preflighted: Object.freeze(["deploying", "refused"] as const),
		deploying: Object.freeze(["deployed", "refused"] as const),
		deployed: Object.freeze([] as const),
		refused: Object.freeze([] as const),
	});

const DEPLOY_MODES: readonly DeployMode[] = Object.freeze([
	"cloud",
	"self-hosted",
	"mock",
]);

const IMPEDANCE_SEVERITIES: readonly ImpedanceSeverity[] = Object.freeze([
	"info",
	"warn",
	"block",
]);

/** Codes `convexImpedanceFindings` can emit (impedance.ts). */
const IMPEDANCE_CODES = Object.freeze([
	"paradigm-mismatch",
	"no-control-plane-time-travel",
	"ts-js-runtime-only",
	"occ-contention",
] as const);

export type ImpedanceCode = (typeof IMPEDANCE_CODES)[number];

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const DEPLOYMENT_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;
const CLOUD_URL = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.convex\.cloud$/u;
const ABSOLUTE_URL = /^https?:\/\/[A-Za-z0-9._:[\]-]+(\/\S*)?$/u;
const CONVEX_CLOUD_HOST = /\.convex\.cloud(:|\/|$)/u;
const REPO_RELATIVE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/u;
const PATH_ESCAPE = /(^|\/)\.\.(\/|$)/u;

/** Every parser in this module refuses by throwing this, never by coercing. */
export class ConvexDeployParseError extends Error {
	readonly field: string;
	readonly reason: string;

	constructor(field: string, reason: string) {
		super(`${field}: ${reason}`);
		this.name = "ConvexDeployParseError";
		this.field = field;
		this.reason = reason;
	}
}

function record(value: JsonValue, field: string): JsonObject {
	if (!isJsonObject(value)) {
		throw new ConvexDeployParseError(field, "expected an object");
	}
	// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
	return value as JsonObject;
}

function requireString(
	source: JsonObject,
	field: string,
): string {
	const value = source[field];
	if (!isJsonString(value)) {
		throw new ConvexDeployParseError(field, "expected a string");
	}
	return value;
}

function requireBoolean(
	source: JsonObject,
	field: string,
): boolean {
	const value = source[field];
	if (!isJsonBoolean(value)) {
		throw new ConvexDeployParseError(field, "expected a boolean");
	}
	return value;
}

/** #RepoRelativePath. */
export function parseConvexAppRoot(value: JsonValue): ConvexAppRoot {
	if (!isJsonString(value) || !REPO_RELATIVE.test(value)) {
		throw new ConvexDeployParseError(
			"root",
			"expected a repo-relative Convex app directory",
		);
	}
	if (PATH_ESCAPE.test(value)) {
		throw new ConvexDeployParseError("root", "path escapes the repo via ..");
	}
	// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
	return value as ConvexAppRoot;
}

/** #DeploymentName. */
export function parseDeploymentName(value: JsonValue): DeploymentName {
	if (!isJsonString(value) || !DEPLOYMENT_NAME.test(value)) {
		throw new ConvexDeployParseError(
			"deploymentName",
			"expected a DNS label (lowercase alphanumeric plus inner hyphens)",
		);
	}
	// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
	return value as DeploymentName;
}

/** #EnvName. */
export function parseEnvName(value: JsonValue): EnvName {
	if (!isJsonString(value) || !ENV_NAME.test(value)) {
		throw new ConvexDeployParseError(
			"missing[]",
			"expected an environment variable NAME",
		);
	}
	// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
	return value as EnvName;
}

function parseDeployMode(value: JsonValue): DeployMode {
	if (
		!isJsonString(value) ||
		// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
		!DEPLOY_MODES.includes(value as DeployMode)
	) {
		throw new ConvexDeployParseError(
			"mode",
			`expected one of ${DEPLOY_MODES.join(", ")}`,
		);
	}
	// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
	return value as DeployMode;
}

/**
 * #ConvexDeployReceipt.deployment_url — the mode decides which URL family is
 * admissible, so a self-hosted lane can never claim a convex.cloud host.
 */
export function parseDeploymentUrl(
	value: JsonValue,
	mode: DeployMode,
): DeploymentUrl {
	if (!isJsonString(value)) {
		throw new ConvexDeployParseError("deploymentUrl", "expected a string");
	}
	const isCloud = CLOUD_URL.test(value);
	const isSelfHosted = ABSOLUTE_URL.test(value) && !CONVEX_CLOUD_HOST.test(value);
	if (mode === "cloud" && !isCloud) {
		throw new ConvexDeployParseError(
			"deploymentUrl",
			"cloud deployments must be https://<name>.convex.cloud",
		);
	}
	if (mode === "self-hosted" && !isSelfHosted) {
		throw new ConvexDeployParseError(
			"deploymentUrl",
			"self-hosted deployments need an absolute non-convex.cloud http(s) URL",
		);
	}
	if (!isCloud && !isSelfHosted) {
		throw new ConvexDeployParseError(
			"deploymentUrl",
			"expected an absolute http(s) deployment URL",
		);
	}
	// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
	return value as DeploymentUrl;
}

/** Parsed derived type for #ConvexDeployRequest. */
export type DeployRequest = {
	readonly root: ConvexAppRoot;
	readonly deploymentName: DeploymentName;
	readonly mock: boolean;
	readonly selfHostedUrl?: DeploymentUrl;
	readonly hasDeployKey: boolean;
	readonly hasSelfHostedAdminKey: boolean;
};

/** Parsed derived type for #ConvexDeployReceipt. */
export type DeployReceipt = {
	readonly ok: true;
	readonly deploymentUrl: DeploymentUrl;
	readonly deploymentName: DeploymentName;
	readonly mocked: boolean;
	readonly mode: DeployMode;
};

/** Parsed derived type for #DeployPreflight. */
export type ShipPreflight = {
	readonly live: boolean;
	readonly missing: readonly EnvName[];
	readonly remediation: string;
	readonly mode: DeployMode;
};

/** Parsed derived type for #ImpedanceFindingRecord. */
export type ImpedanceRecord = {
	readonly code: ImpedanceCode;
	readonly severity: ImpedanceSeverity;
	readonly message: string;
};

/**
 * Parse an untrusted ship request (CLI flags, HOBO.md config, agent input)
 * into the refined request the executor may see. Enforces the fail-closed
 * credential rule from deploy.ts: a non-mock deploy needs a Cloud deploy key,
 * or BOTH the self-hosted URL and its admin key.
 */
export function parseDeployRequest(input: JsonValue): DeployRequest {
	const source = record(input, "request");
	const root = parseConvexAppRoot(source.root);
	const deploymentName = parseDeploymentName(source.deploymentName);
	const mock = source.mock === undefined ? false : requireBoolean(source, "mock");
	const hasDeployKey = Boolean(source.deployKey);
	const hasSelfHostedAdminKey = Boolean(source.selfHostedAdminKey);
	const selfHostedUrl =
		source.selfHostedUrl === undefined
			? undefined
			: parseDeploymentUrl(source.selfHostedUrl, "self-hosted");

	if (hasSelfHostedAdminKey && selfHostedUrl === undefined) {
		throw new ConvexDeployParseError(
			"selfHostedUrl",
			"a self-hosted admin key without its URL cannot address a backend",
		);
	}
	if (!mock && !hasDeployKey && !(selfHostedUrl && hasSelfHostedAdminKey)) {
		throw new ConvexDeployParseError(
			"credentials",
			"fail closed: a non-mock deploy needs CONVEX_DEPLOY_KEY, or the self-hosted URL plus admin key",
		);
	}

	return Object.freeze({
		root,
		deploymentName,
		mock,
		...(selfHostedUrl === undefined ? undefined : { selfHostedUrl }),
		hasDeployKey,
		hasSelfHostedAdminKey,
	});
}

/**
 * Parse the executor's response. `ok` must be present and true (the executor
 * throws on failure, so a falsy receipt is a contract break), and `mocked`
 * must agree with `mode === "mock"` — the mock lane is explicit in both
 * fields or not trusted at all.
 */
export function parseDeployReceipt(input: JsonValue): DeployReceipt {
	const source = record(input, "receipt");
	if (requireBoolean(source, "ok") !== true) {
		throw new ConvexDeployParseError("ok", "a receipt is never a failure");
	}
	const mode = parseDeployMode(source.mode);
	const mocked = requireBoolean(source, "mocked");
	if (mocked !== (mode === "mock")) {
		throw new ConvexDeployParseError(
			"mocked",
			`mocked=${mocked} disagrees with mode="${mode}"`,
		);
	}
	const deploymentName = parseDeploymentName(source.deploymentName);
	const deploymentUrl = parseDeploymentUrl(source.deploymentUrl, mode);

	if (mode === "cloud" && !deploymentUrl.includes(deploymentName)) {
		throw new ConvexDeployParseError(
			"deploymentUrl",
			`cloud URL does not name deployment "${deploymentName}"`,
		);
	}

	return Object.freeze({
		ok: true as const,
		deploymentUrl,
		deploymentName,
		mocked,
		mode,
	});
}

/**
 * Fold a presence-only preflight out of an untrusted environment record plus
 * the requested mode. `live` is true only when nothing is missing AND the
 * caller did not ask for the mock lane — mock never claims live credentials.
 */
export function parseShipPreflight(input: {
	readonly missing: readonly unknown[];
	readonly remediation: JsonValue;
	readonly mode: JsonValue;
}): ShipPreflight {
	const mode = parseDeployMode(input.mode);
	const missing = Object.freeze(input.missing.map(parseEnvName));
	const remediation = requireString(
		{ remediation: input.remediation },
		"remediation",
	);
	if (remediation.trim() === "") {
		throw new ConvexDeployParseError(
			"remediation",
			"a preflight always explains itself",
		);
	}
	return Object.freeze({
		live: missing.length === 0 && mode !== "mock",
		missing,
		remediation,
		mode,
	});
}

/**
 * Parse plan-time impedance findings. Enforces the impedance.ts invariant that
 * `block` belongs to exactly one code: a paradigm mismatch. Anything else
 * claiming `block` is a provider bug, not a planner input.
 */
export function parseImpedanceRecords(
	input: readonly unknown[],
): readonly ImpedanceRecord[] {
	return Object.freeze(
		input.map((entry) => {
			const source = record(entry, "finding");
			const code = requireString(source, "code");
			// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
			if (!(IMPEDANCE_CODES as readonly string[]).includes(code)) {
				throw new ConvexDeployParseError("code", `unknown finding "${code}"`);
			}
			const severity = requireString(source, "severity");
			// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
			if (!IMPEDANCE_SEVERITIES.includes(severity as ImpedanceSeverity)) {
				throw new ConvexDeployParseError(
					"severity",
					`expected one of ${IMPEDANCE_SEVERITIES.join(", ")}`,
				);
			}
			const message = requireString(source, "message");
			if (message.trim() === "") {
				throw new ConvexDeployParseError("message", "expected a reason");
			}
			if ((severity === "block") !== (code === "paradigm-mismatch")) {
				throw new ConvexDeployParseError(
					"severity",
					`severity "${severity}" disagrees with code "${code}"`,
				);
			}
			return Object.freeze({
				// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
				code: code as ImpedanceCode,
				// SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
				severity: severity as ImpedanceSeverity,
				message,
			});
		}),
	);
}

/** #ShipTransitions — refuse a phase move the lifecycle does not allow. */
export function assertShipTransition(from: ShipPhase, to: ShipPhase): void {
	if (!SHIP_TRANSITIONS[from].includes(to)) {
		throw new ConvexDeployParseError(
			"phase",
			`"${from}" cannot transition to "${to}"`,
		);
	}
}
