import {
	PRIVATE_KEY_PATTERN,
	type RedactionPattern,
	redactionPattern,
	redactMatches,
	SIGNED_JWT_PATTERN,
} from "@hobo/core/provider-redaction";
import { z } from "zod";

/**
 * Third-party GitHub Actions runner providers HoBo CI can route jobs to.
 *
 * The config only ever holds references. Each provider is limited to the auth
 * methods it really supports (checked against the provider docs listed below):
 * - `github-app`: the provider's GitHub App is installed on the org; the app
 *   mints short-lived per-job runner tokens. No credential ever exists in the repo.
 * - `oidc`: the workflow exchanges its GitHub OIDC token (`id-token: write`) for a
 *   short-lived provider token through a trust relationship. Nothing is stored.
 * - `device`: an interactive browser/device ceremony run by the provider CLI.
 * - `secret-ref`: last-resort fallback. The config names where a secret lives
 *   (`github-secret:NAME` or `env:NAME`); the value itself is never accepted.
 */
export const RUNNER_INTEGRATION_PROVIDERS = [
	"blacksmith",
	"depot",
	"jog",
	"boat",
] as const;
export type RunnerIntegrationProvider =
	(typeof RUNNER_INTEGRATION_PROVIDERS)[number];
export const RUNNER_INTEGRATION_AUTH_METHODS = [
	"github-app",
	"oidc",
	"device",
	"secret-ref",
] as const;
export type RunnerIntegrationAuthMethod =
	(typeof RUNNER_INTEGRATION_AUTH_METHODS)[number];

export interface RunnerProviderProfile {
	readonly provider: RunnerIntegrationProvider;
	readonly displayName: string;
	/** Supported auth methods, safest first. The first one is the default. */
	readonly authMethods: readonly RunnerIntegrationAuthMethod[];
	readonly labelPattern: RegExp;
	readonly exampleLabel: string;
	/** Where the owner completes the provider's own sign-in/installation step. */
	readonly ceremonyUrl: string;
	/** Provider CLI that runs a device/browser ceremony, when one exists. */
	readonly ceremonyCommand?: readonly string[];
	readonly docsUrl: string;
	/** Fallback secret name used with `secret-ref`. */
	readonly fallbackSecret?: string;
	readonly notes: string;
}

export const RUNNER_PROVIDER_PROFILES = {
	blacksmith: {
		provider: "blacksmith",
		displayName: "Blacksmith",
		authMethods: ["github-app"],
		labelPattern: /^blacksmith(-[a-z0-9]+)*$/,
		exampleLabel: "blacksmith-2vcpu-ubuntu-2404",
		ceremonyUrl: "https://app.blacksmith.sh",
		docsUrl: "https://docs.blacksmith.sh/blacksmith-administration/github-app",
		notes:
			"GitHub App only (GitHub SSO); no API tokens or OIDC for runners. Organizations only.",
	},
	depot: {
		provider: "depot",
		displayName: "Depot",
		authMethods: ["github-app", "oidc", "secret-ref"],
		labelPattern: /^depot-[a-z0-9.-]+$/,
		exampleLabel: "depot-ubuntu-24.04",
		ceremonyUrl: "https://depot.dev/orgs",
		ceremonyCommand: ["depot", "login"],
		docsUrl: "https://depot.dev/docs/cli/authentication",
		fallbackSecret: "DEPOT_TOKEN",
		notes:
			"Runners: GitHub App connected from the Depot dashboard. Builds: OIDC trust relationship (id-token: write); DEPOT_TOKEN secret reference only as fallback.",
	},
	jog: {
		provider: "jog",
		displayName: "Jog (usejog)",
		authMethods: ["github-app"],
		labelPattern: /^jog(-[a-z0-9]+)*$/,
		exampleLabel: "jog",
		ceremonyUrl: "https://usejog.com",
		docsUrl: "https://usejog.com/docs/runners/",
		notes:
			"GitHub App only; no tokens. Private repositories only; prepaid credits.",
	},
	boat: {
		provider: "boat",
		displayName: "Boat",
		authMethods: ["device", "secret-ref"],
		labelPattern: /^boat(-(small|large|xlarge))?$/,
		exampleLabel: "boat",
		ceremonyUrl: "https://docs.boat.dev/ci",
		ceremonyCommand: ["boat", "ci", "connect"],
		docsUrl: "https://docs.boat.dev/ci",
		fallbackSecret: "BOAT_API_KEY",
		notes:
			"`boat ci connect` opens GitHub to install and authorize the Boat CI app; API key only as a secret reference.",
	},
} satisfies Readonly<Record<RunnerIntegrationProvider, RunnerProviderProfile>>;

/** Shapes that are credentials, never references. Never echo the match. */
export const SECRET_PATTERNS: readonly RegExp[] = [
	// A private key first, the shared form: searched after the JWT shape, which
	// starts where a run starts, its BEGIN line was read as part of a token. It
	// runs from BEGIN to its own END line and the rest of that line's run, so
	// text glued to a key goes with it.
	PRIVATE_KEY_PATTERN,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bdepot_(?:project|org|user)_[A-Za-z0-9]{16,}\b/g,
	/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	// A signed JWT and nothing after it, the shared linear form: `\beyJ…`
	// started again at every `eyJ` in a run and read to its end, quadratic in a
	// hostile text. The bounded form keeps an unsigned token from counting and
	// the rest of a JSON body from being swallowed with the signature.
	SIGNED_JWT_PATTERN,
	/\b(?:boat|bsm|jog)_[A-Za-z0-9]{20,}\b/g,
];

const SECRET_SPANS: readonly RedactionPattern[] =
	SECRET_PATTERNS.map(redactionPattern);

function entropy(value: string): number {
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

export const OPAQUE_RUN = /[A-Za-z0-9+_=-]{32,}/g;
const OPAQUE_SPAN = redactionPattern(OPAQUE_RUN);
const DIGEST = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function opaqueCredential(run: string): boolean {
	return (
		!DIGEST.test(run) &&
		/[0-9]/.test(run) &&
		/[a-z]/.test(run) &&
		/[A-Z]/.test(run) &&
		entropy(run) >= 4
	);
}

/** True when a string looks like a raw credential rather than a reference. */
export function looksLikeSecret(value: string): boolean {
	if (SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source).test(value)))
		return true;
	return [...value.matchAll(OPAQUE_RUN)].some((match) =>
		opaqueCredential(match[0]),
	);
}

/** Remove credential-shaped substrings and any explicitly known secret values. */
export function redactSecrets(
	text: string,
	known: readonly string[] = [],
): string {
	let out = text;
	for (const secret of known)
		if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
	// Every shape over the same text: replaced in turn, a private key's END
	// line took the BEGIN line glued after it, and the next key was not found.
	// The opaque-run rule too: run after the shapes, it saw a run they had cut
	// short, and the part before a JWT had lost its digit. It is run again
	// after them, for a run that only qualifies once a shape is gone.
	out = redactMatches(
		out,
		[...SECRET_SPANS, OPAQUE_SPAN],
		"[REDACTED]",
		(match, pattern) => pattern !== OPAQUE_SPAN || opaqueCredential(match),
	);
	return out.replace(OPAQUE_RUN, (run) =>
		opaqueCredential(run) ? "[REDACTED]" : run,
	);
}

export const SECRET_REFERENCE = /^(?:github-secret|env):[A-Z][A-Z0-9_]{0,63}$/;

export const RunnerIntegrationSchema = z
	.object({
		id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
		provider: z.enum(RUNNER_INTEGRATION_PROVIDERS),
		enabled: z.boolean().optional(),
		organization: z
			.string()
			.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
			.optional(),
		runsOn: z
			.array(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/))
			.min(1)
			.max(8),
		auth: z
			.object({
				method: z.enum(RUNNER_INTEGRATION_AUTH_METHODS),
				secretRef: z.string().regex(SECRET_REFERENCE).optional(),
				projectId: z
					.string()
					.regex(/^[a-z0-9]{6,32}$/)
					.optional(),
			})
			.strict(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const profile: RunnerProviderProfile =
			RUNNER_PROVIDER_PROFILES[value.provider];
		if (!profile.authMethods.includes(value.auth.method))
			ctx.addIssue({
				code: "custom",
				path: ["auth", "method"],
				message: `${profile.displayName} supports ${profile.authMethods.join(", ")}`,
			});
		if ((value.auth.method === "secret-ref") !== Boolean(value.auth.secretRef))
			ctx.addIssue({
				code: "custom",
				path: ["auth", "secretRef"],
				message: "secretRef is required for secret-ref and forbidden otherwise",
			});
		if ((value.auth.method === "oidc") !== Boolean(value.auth.projectId))
			ctx.addIssue({
				code: "custom",
				path: ["auth", "projectId"],
				message: "projectId is required for oidc and forbidden otherwise",
			});
		value.runsOn.forEach((label, index) => {
			if (!profile.labelPattern.test(label))
				ctx.addIssue({
					code: "custom",
					path: ["runsOn", index],
					message: `not a ${profile.displayName} runner label (e.g. ${profile.exampleLabel})`,
				});
		});
	})
	.meta({ id: "RunnerIntegration" });
export type RunnerIntegration = z.infer<typeof RunnerIntegrationSchema>;

export const RunnerIntegrationsSchema = z
	.array(RunnerIntegrationSchema)
	.max(16)
	.superRefine((entries, ctx) => {
		const ids = new Set<string>();
		entries.forEach((entry, index) => {
			if (ids.has(entry.id))
				ctx.addIssue({
					code: "custom",
					path: [index, "id"],
					message: "duplicate integration id",
				});
			ids.add(entry.id);
		});
	})
	.meta({ id: "RunnerIntegrations" });

/**
 * Reject raw credentials anywhere in a config document before parsing, without
 * echoing them. Returns JSON-pointer-ish paths of offending values.
 */
const JsonStringSchema = z.string();
const JsonArraySchema = z.array(z.json());
const JsonObjectSchema = z.record(z.string(), z.json());

/** Any JSON-shaped value a config document can carry, including absent fields. */
export type SecretScanValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| readonly SecretScanValue[]
	| { readonly [key: string]: SecretScanValue };

export function findRawSecrets(value: SecretScanValue, path = ""): string[] {
	const text = JsonStringSchema.safeParse(value);
	if (text.success) return looksLikeSecret(text.data) ? [path || "/"] : [];
	const list = JsonArraySchema.safeParse(value);
	if (list.success)
		return list.data.flatMap((entry, index) =>
			findRawSecrets(entry, `${path}/${index}`),
		);
	const record = JsonObjectSchema.safeParse(value);
	if (record.success)
		return Object.entries(record.data).flatMap(([key, entry]) =>
			findRawSecrets(entry, `${path}/${key}`),
		);
	return [];
}

export interface RunnerIntegrationOptions {
	id?: string | undefined;
	auth?: RunnerIntegrationAuthMethod | undefined;
	secretRef?: string | undefined;
	projectId?: string | undefined;
	organization?: string | undefined;
	runsOn?: readonly string[] | undefined;
}

/** Build a references-only integration entry; throws on any invalid or secret-shaped input. */
export function buildRunnerIntegration(
	provider: RunnerIntegrationProvider,
	options: RunnerIntegrationOptions = {},
): RunnerIntegration {
	const profile: RunnerProviderProfile = RUNNER_PROVIDER_PROFILES[provider];
	const scalarOptions = [
		["id", options.id],
		["auth", options.auth],
		["secret-ref", options.secretRef],
		["project-id", options.projectId],
		["org", options.organization],
	] satisfies [string, string | undefined][];
	const flagged = [
		...scalarOptions,
		...(options.runsOn ?? []).map(
			(label) => ["runs-on", label] satisfies [string, string],
		),
	];
	for (const [key, entry] of flagged)
		if (entry !== undefined && looksLikeSecret(entry))
			throw new Error(
				`--${key} looks like a raw credential. Pass a reference such as github-secret:NAME; never a secret value.`,
			);
	const method = options.auth ?? profile.authMethods[0];
	if (!method) throw new Error("provider has no auth method");
	const auth: RunnerIntegration["auth"] = { method };
	if (method === "secret-ref")
		auth.secretRef =
			options.secretRef ??
			`github-secret:${profile.fallbackSecret ?? "PROVIDER_TOKEN"}`;
	if (options.projectId) auth.projectId = options.projectId;
	const entry: RunnerIntegration = {
		id: options.id ?? provider,
		provider,
		runsOn: [...(options.runsOn ?? [profile.exampleLabel])],
		auth,
	};
	if (options.organization) entry.organization = options.organization;
	const parsed = RunnerIntegrationSchema.safeParse(entry);
	if (!parsed.success)
		throw new Error(
			parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; "),
		);
	return parsed.data;
}
