/**
 * The gate in front of the live conformance lane.
 *
 * Everything past this file spends somebody's money and creates real resources
 * in somebody's account. So the default answer is no, and every yes has to be
 * spelled out: the lane on, this specific provider named, a credential handed
 * over as a *reference* rather than material, a resource budget, and a date a
 * human last read the provider's docs. Any missing gate refuses with the exact
 * variable to set — a guard nobody can act on gets bypassed.
 *
 * The environment arrives as a parameter. This module never touches
 * `process.env`, so it is as testable as the pure suites.
 */
import {
	parseSecretRef,
	redactSecretRef,
	type SecretRef,
} from "@hobo/bindings";

export const LIVE_ENV_KEYS = {
	enable: "HOBO_CONFORMANCE_LIVE",
	providers: "HOBO_CONFORMANCE_LIVE_PROVIDERS",
	credentialRef: "HOBO_CONFORMANCE_LIVE_CREDENTIAL_REF",
	maximumResources: "HOBO_CONFORMANCE_LIVE_MAX_RESOURCES",
	providerDocsCheckedAt: "HOBO_CONFORMANCE_LIVE_PROVIDER_DOCS_CHECKED_AT",
	runTag: "HOBO_CONFORMANCE_LIVE_RUN_TAG",
} as const;

/**
 * Variables whose presence means an unattended automation is driving us. The
 * live lane refuses in all of them; there is no override, because "we needed
 * it green in CI" is precisely how a lane that spends money gets scheduled.
 */
export const CI_ENV_KEYS: readonly string[] = [
	"BUILDKITE",
	"CI",
	"CIRCLECI",
	"CODEBUILD_BUILD_ID",
	"CONTINUOUS_INTEGRATION",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"JENKINS_URL",
	"TEAMCITY_VERSION",
	"TF_BUILD",
];

export const LIVE_REFUSAL_CODES = [
	"LIVE_LANE_DISABLED",
	"LIVE_LANE_PROVIDER_NOT_ENABLED",
	"LIVE_LANE_CREDENTIAL_MISSING",
	"LIVE_LANE_CREDENTIAL_NOT_A_REFERENCE",
	"LIVE_LANE_REFUSED_IN_CI",
	"LIVE_LANE_RESOURCE_BUDGET_INVALID",
	"LIVE_LANE_PROVIDER_DOCS_DATE_MISSING",
	"LIVE_LANE_RUN_TAG_INVALID",
	"LIVE_LANE_PROVIDER_ID_INVALID",
] as const;

export type LiveRefusalCode = (typeof LIVE_REFUSAL_CODES)[number];

export class LiveRunRefusedError extends Error {
	readonly code: LiveRefusalCode;
	/** What the operator has to do. Always actionable, never "see docs". */
	readonly remediation: string;

	constructor(code: LiveRefusalCode, message: string, remediation: string) {
		super(`${message}\n  remediation: ${remediation}`);
		this.name = "LiveRunRefusedError";
		this.code = code;
		this.remediation = remediation;
	}
}

/** A parsed, non-negotiable permission to run against one provider. */
export type LiveRunGrant = {
	readonly providerId: string;
	/** A locator. The material never enters this process's own state. */
	readonly credentialRef: SecretRef;
	/** The only form safe to print or persist. */
	readonly redactedCredentialRef: string;
	readonly maximumResources: number;
	/** ISO date a human last read this provider's docs. */
	readonly providerDocsCheckedAt: string;
	readonly runTag?: string;
};

export type LiveRunGrantInput = {
	readonly providerId: string;
	readonly env: Readonly<Record<string, string | undefined>>;
};

const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RUN_TAG = /^[a-z0-9][a-z0-9-]{2,40}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DEFAULT_MAXIMUM_RESOURCES = 4;
const RESOURCE_CEILING = 16;

/**
 * Parse-don't-validate boundary for permission to run live.
 *
 * Returns a grant or throws. There is no "partially permitted" state, because
 * a caller holding a half-checked grant is a caller who will provision on the
 * half that passed.
 */
export function parseLiveRunGrant(input: LiveRunGrantInput): LiveRunGrant {
	const { env } = input;
	const providerId = input.providerId.trim();
	if (!PROVIDER_ID.test(providerId)) {
		throw new LiveRunRefusedError(
			"LIVE_LANE_PROVIDER_ID_INVALID",
			`provider id ${JSON.stringify(input.providerId)} is not a lowercase dns-style label`,
			"pass a provider id such as 'neon' or 'cloudflare-workers'",
		);
	}

	const ciKey = CI_ENV_KEYS.find((key) => isTruthy(env[key]));
	if (ciKey !== undefined) {
		throw new LiveRunRefusedError(
			"LIVE_LANE_REFUSED_IN_CI",
			`the live conformance lane refuses to run under automation (${ciKey} is set)`,
			"run this lane from an operator workstation; the mandatory offline lane is what CI runs",
		);
	}

	if (env[LIVE_ENV_KEYS.enable] !== "1") {
		throw new LiveRunRefusedError(
			"LIVE_LANE_DISABLED",
			"the live conformance lane is off by default because it creates billable provider resources",
			`set ${LIVE_ENV_KEYS.enable}=1 to acknowledge that this run provisions real resources`,
		);
	}

	const enabledProviders = (env[LIVE_ENV_KEYS.providers] ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (!enabledProviders.includes(providerId)) {
		throw new LiveRunRefusedError(
			"LIVE_LANE_PROVIDER_NOT_ENABLED",
			`provider ${providerId} is not in the per-provider allowlist`,
			`set ${LIVE_ENV_KEYS.providers} to a comma-separated list including ${providerId}`,
		);
	}

	const rawCredentialRef = env[LIVE_ENV_KEYS.credentialRef];
	if (rawCredentialRef === undefined || rawCredentialRef.trim().length === 0) {
		throw new LiveRunRefusedError(
			"LIVE_LANE_CREDENTIAL_MISSING",
			`no credential was supplied for ${providerId}`,
			`set ${LIVE_ENV_KEYS.credentialRef} to a secret locator such as hobo-secret://tenant/live-conformance/${providerId}`,
		);
	}
	let credentialRef: SecretRef;
	try {
		credentialRef = parseSecretRef(rawCredentialRef.trim()).ref;
	} catch (error) {
		// The offending value is deliberately not echoed: a rejected reference
		// is very often a pasted plaintext credential.
		throw new LiveRunRefusedError(
			"LIVE_LANE_CREDENTIAL_NOT_A_REFERENCE",
			`${LIVE_ENV_KEYS.credentialRef} is not a registered secret locator (${
				error instanceof Error ? error.name : "unparseable"
			})`,
			`deposit the credential into secret custody and set ${LIVE_ENV_KEYS.credentialRef} to its locator; never paste the material itself`,
		);
	}

	const maximumResources = parseResourceBudget(
		env[LIVE_ENV_KEYS.maximumResources],
	);

	const providerDocsCheckedAt =
		env[LIVE_ENV_KEYS.providerDocsCheckedAt]?.trim();
	if (
		providerDocsCheckedAt === undefined ||
		!ISO_DATE.test(providerDocsCheckedAt)
	) {
		throw new LiveRunRefusedError(
			"LIVE_LANE_PROVIDER_DOCS_DATE_MISSING",
			"evidence has to cite the date a human last checked the provider's documented contract",
			`set ${LIVE_ENV_KEYS.providerDocsCheckedAt} to the YYYY-MM-DD date you read the provider docs`,
		);
	}

	const runTag = env[LIVE_ENV_KEYS.runTag]?.trim();
	if (runTag !== undefined && runTag.length > 0 && !RUN_TAG.test(runTag)) {
		throw new LiveRunRefusedError(
			"LIVE_LANE_RUN_TAG_INVALID",
			`run tag ${JSON.stringify(runTag)} is not a 3-41 character lowercase dns-style label`,
			`unset ${LIVE_ENV_KEYS.runTag} to get a generated tag, or supply a lowercase label`,
		);
	}

	return Object.freeze({
		providerId,
		credentialRef,
		redactedCredentialRef: redactSecretRef(credentialRef),
		maximumResources,
		providerDocsCheckedAt,
		...(runTag !== undefined && runTag.length > 0 ? { runTag } : undefined),
	});
}

function parseResourceBudget(raw: string | undefined): number {
	if (raw === undefined || raw.trim().length === 0) {
		return DEFAULT_MAXIMUM_RESOURCES;
	}
	const parsed = Number(raw.trim());
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > RESOURCE_CEILING) {
		throw new LiveRunRefusedError(
			"LIVE_LANE_RESOURCE_BUDGET_INVALID",
			`${LIVE_ENV_KEYS.maximumResources}=${JSON.stringify(raw)} is not an integer between 1 and ${RESOURCE_CEILING}`,
			`set ${LIVE_ENV_KEYS.maximumResources} to the number of resources this run may create (1-${RESOURCE_CEILING})`,
		);
	}
	return parsed;
}

function isTruthy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

/** Whether a live run would be permitted, without throwing. For `doctor`-style output. */
export function liveRunRefusalFor(
	input: LiveRunGrantInput,
): LiveRunRefusedError | undefined {
	try {
		parseLiveRunGrant(input);
		return undefined;
	} catch (error) {
		return error instanceof LiveRunRefusedError ? error : undefined;
	}
}
