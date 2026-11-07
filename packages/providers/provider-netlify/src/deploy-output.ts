/**
 * Parse `netlify deploy --allow-anonymous --json` into typed facts.
 *
 * The strictness is the point. `temporary-station.ts` parses the same command
 * leniently, because an Environment Station that ends up with a slightly odd URL
 * is a cosmetic problem. Here the same output decides who owns a live site, so
 * anything unrecognized fails closed with `PROVIDER_CONTRACT_CHANGED` instead of
 * being guessed at — a wrong claim URL is worse than no deployment.
 *
 * Only the JSON document is trusted for identity. The claim action has no
 * documented JSON field, so it is recovered from the emitted text and validated
 * structurally against {@link NETLIFY_CLAIM_URL_PREFIX}; the README records that
 * as verified-by-shape rather than documented.
 */
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "./json.js";
import { NetlifyProviderError, redactProviderText } from "./provider-errors.js";

/**
 * Documented window: "You have one hour to claim ownership of the deployed
 * project… After one hour, unclaimed projects are removed."
 */
export const NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS = 60 * 60 * 1000;

// public-contract: allowed ownership-claim URL prefix.
export const NETLIFY_CLAIM_URL_PREFIX =
	"https://app.netlify.com/claim" as const;

/**
 * Where a deadline came from. The CLI reports no expiry field, so a deadline is
 * normally derived from the documented window — and labelled as such, rather
 * than passed off as something the provider said.
 */
export type ExpirySource = "documented-window" | "provider-reported";

/** What a command runner hands back. `code: null` means killed by a signal. */
export type DeployCommandResult = {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

export type AnonymousDeployObservation = {
	readonly siteId: string;
	readonly siteName: string;
	readonly deployId: string;
	/** The live site URL. Not a credential. */
	readonly siteUrl: string;
	/** The immutable per-deploy URL, when the CLI reports one. */
	readonly deployUrl?: string;
	/**
	 * Bearer authority over the whole site until it is claimed or expires.
	 * Named `…Plaintext` so that passing it anywhere but custody looks wrong at
	 * the call site.
	 */
	readonly claimUrlPlaintext: string;
	readonly claimDeadlineMs: number;
	readonly expirySource: ExpirySource;
	readonly observedAtMs: number;
};

function contractChanged(
	message: string,
	preview?: string,
): NetlifyProviderError {
	return new NetlifyProviderError("PROVIDER_CONTRACT_CHANGED", message, {
		...(preview !== undefined
			? { detail: { preview: redactProviderText(preview, 80) } }
			: undefined),
	});
}

/** Pull the single JSON document out of otherwise chatty CLI output. */
function extractJsonObject(stdout: string): JsonObject {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw contractChanged(
			"netlify deploy --json produced no JSON document; refusing to guess the deployment identity",
			stdout,
		);
	}
	const parsed = parseJsonValue(stdout.slice(start, end + 1));
	if (!isJsonObject(parsed)) {
		throw contractChanged(
			parsed === null
				? "netlify deploy --json produced output that is not parseable JSON"
				: "netlify deploy --json did not produce a JSON object",
			stdout,
		);
	}
	return parsed;
}

function stringField(
	body: JsonObject,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = body[key];
		if (isJsonString(value) && value.length > 0) return value;
	}
	return undefined;
}

function requireStringField(
	body: JsonObject,
	keys: readonly string[],
	what: string,
): string {
	const value = stringField(body, keys);
	if (value === undefined) {
		throw contractChanged(
			`netlify deploy --json is missing ${what} (looked for ${keys.join(", ")})`,
		);
	}
	return value;
}

function normalizeHttpsUrl(raw: string, what: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw contractChanged(
			`netlify deploy --json reported ${what} that is not a URL`,
		);
	}
	// The CLI has historically printed the http:// form of a site that is in
	// fact TLS-only. Upgrading is safe; accepting a non-web scheme is not.
	if (url.protocol === "http:") url.protocol = "https:";
	if (
		url.protocol !== "https:" ||
		!url.hostname.endsWith(".netlify.app") ||
		url.username ||
		url.password ||
		url.port
	) {
		throw contractChanged(`netlify deploy --json reported a non-https ${what}`);
	}
	return url.toString().replace(/\/$/u, "");
}

/**
 * Refuse anything that is not a Netlify claim URL.
 *
 * Output parsing is the weakest link in this strategy, and the failure that
 * matters is handing a human a link to somewhere else entirely.
 */
export function assertClaimActionIsNetlify(claimUrl: string): void {
	let url: URL;
	try {
		url = new URL(claimUrl);
	} catch {
		throw contractChanged(
			"the anonymous deploy reported an invalid ownership claim URL",
		);
	}
	if (
		url.protocol === "https:" &&
		url.hostname === "app.netlify.com" &&
		!url.username &&
		!url.password &&
		!url.port &&
		/^\/(?:claim|drop)(?:\/|$)/u.test(url.pathname)
	)
		return;
	throw contractChanged(
		"the anonymous deploy reported a claim action that is not a netlify claim URL",
	);
}

function findClaimUrl(
	body: JsonObject,
	rawOutput: string,
	siteId: string,
): string {
	const fromJson = stringField(body, ["claim_url", "claimUrl", "claim"]);
	const scanned =
		fromJson ??
		/https:\/\/app\.netlify\.com\/(?:claim|drop)(?:\/|\?|#)[^\s"'<>]*/iu.exec(
			rawOutput,
		)?.[0];
	if (scanned === undefined) {
		throw new NetlifyProviderError(
			"CLAIM_NOT_VERIFIED",
			"the anonymous deploy reported no claim action, so nobody could take ownership of the site it just published",
			{ detail: { siteId } },
		);
	}
	const trimmed = scanned.replace(/[.,)]+$/u, "");
	assertClaimActionIsNetlify(trimmed);
	return trimmed;
}

export type ParseAnonymousDeployInput = {
	readonly result: DeployCommandResult;
	/** Instant the deploy completed. The one-hour window runs from here. */
	readonly observedAtMs: number;
};

export function parseAnonymousDeployOutput(
	input: ParseAnonymousDeployInput,
): AnonymousDeployObservation {
	const { result } = input;
	if (result.code !== 0) {
		// A non-zero exit does not prove nothing was published: the CLI can
		// create the site and then fail while reporting it. Ambiguous, so the
		// caller must observe before retrying rather than deploy again.
		throw new NetlifyProviderError(
			"PROVIDER_OPERATION_AMBIGUOUS",
			`netlify deploy --allow-anonymous exited ${result.code ?? "on a signal"}; a claimable site may already exist, so observe before retrying`,
			{
				detail: {
					exitCode: result.code ?? -1,
					stderr: redactProviderText(result.stderr, 120),
				},
			},
		);
	}

	const combined = `${result.stdout}\n${result.stderr}`;
	const body = extractJsonObject(result.stdout);
	const siteId = requireStringField(body, ["site_id", "siteId"], "the site id");
	const deployId = requireStringField(
		body,
		["deploy_id", "deployId"],
		"the deploy id",
	);
	const siteUrl = normalizeHttpsUrl(
		requireStringField(body, ["url", "site_url", "deploy_url"], "the site URL"),
		"the site URL",
	);
	const deployUrlRaw = stringField(body, ["deploy_url", "deployUrl"]);
	const siteName =
		stringField(body, ["site_name", "siteName", "name"]) ??
		// The subdomain is the site name whenever the CLI omits the field.
		new URL(siteUrl).hostname.split(".")[0] ??
		siteId;

	return {
		siteId,
		siteName,
		deployId,
		siteUrl,
		...(deployUrlRaw !== undefined
			? { deployUrl: normalizeHttpsUrl(deployUrlRaw, "the deploy URL") }
			: undefined),
		claimUrlPlaintext: findClaimUrl(body, combined, siteId),
		claimDeadlineMs: input.observedAtMs + NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
		expirySource: "documented-window",
		observedAtMs: input.observedAtMs,
	};
}
