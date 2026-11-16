/**
 * Parse, don't validate: every setting a ceremony reads from the outside
 * (an environment variable, the committed locator, the setup page, a tunnel
 * CLI's output) is parsed once, where it enters, into a branded type that
 * only its parser can produce. Code past that point takes the brand, so an
 * invalid value cannot be passed along, assigned or noticed late: a bad
 * 1Password vault id is refused when it is read, not as a sign-in failure
 * three calls later.
 */

declare const httpsOriginBrand: unique symbol;
declare const publicOriginBrand: unique symbol;
declare const vaultIdBrand: unique symbol;
declare const proxyUrlBrand: unique symbol;

/** An https origin: scheme, host and optional port; no path, query or credentials. */
export type HttpsOrigin = string & { readonly [httpsOriginBrand]: true };
/** An https origin whose host is public (not loopback, private or link-local). */
export type PublicOrigin = HttpsOrigin & { readonly [publicOriginBrand]: true };
/** A 1Password vault id: 26 lowercase letters and digits. */
export type OnePasswordVaultId = string & { readonly [vaultIdBrand]: true };
/** An http(s) proxy URL the environment requires. */
export type ProxyUrl = string & { readonly [proxyUrlBrand]: true };

/** How the owner carries GitHub's App back when no receiver is configured. */
export type AppHandOffMode = "paste" | "store";

export class SettingParseError extends Error {
	readonly code = "HOBO_SETTING_INVALID";
	constructor(
		readonly setting: string,
		readonly rule: string,
	) {
		super(`${setting} is not valid: ${rule}.`);
		this.name = "SettingParseError";
	}
}

const HTTPS_ORIGIN_RULE =
	"an https origin such as https://host.example, with no path, query or credentials";

export function parseHttpsOrigin(setting: string, text: string): HttpsOrigin {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new SettingParseError(setting, HTTPS_ORIGIN_RULE);
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		(url.pathname !== "/" && url.pathname !== "") ||
		url.search !== "" ||
		url.hash !== ""
	)
		throw new SettingParseError(setting, HTTPS_ORIGIN_RULE);
	// SAFETY: every condition of the brand was checked just above.
	return url.origin as HttpsOrigin;
}

const PRIVATE_HOST =
	/^(localhost|\[::1\]|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/u;

export function parsePublicOrigin(setting: string, text: string): PublicOrigin {
	const origin = parseHttpsOrigin(setting, text);
	if (PRIVATE_HOST.test(new URL(origin).hostname))
		throw new SettingParseError(
			setting,
			"a public https origin (not loopback, private or link-local)",
		);
	// SAFETY: an https origin whose host was just checked to be public.
	return origin as PublicOrigin;
}

export function parseOnePasswordVaultId(
	setting: string,
	text: string,
): OnePasswordVaultId {
	if (!/^[a-z0-9]{26}$/u.test(text))
		throw new SettingParseError(
			setting,
			"26 lowercase letters and digits, as 1Password shows a vault's ID",
		);
	// SAFETY: the shape of a 1Password vault id was just checked.
	return text as OnePasswordVaultId;
}

export function parseProxyUrl(setting: string, text: string): ProxyUrl {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new SettingParseError(setting, "an http:// or https:// proxy URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new SettingParseError(setting, "an http:// or https:// proxy URL");
	// SAFETY: a URL with an http(s) scheme, as just checked.
	return text as ProxyUrl;
}

export function parseAppHandOffMode(
	setting: string,
	text: string | undefined,
): AppHandOffMode {
	if (text === undefined || text === "" || text === "paste") return "paste";
	if (text === "store") return "store";
	throw new SettingParseError(setting, "paste or store");
}

/**
 * A setup-page check derived from a parser, so the page refuses exactly what
 * the parser refuses (one rule, one place).
 */
export function checkedBy<Parsed>(
	parse: (setting: string, text: string) => Parsed,
	setting: string,
): (value: string) => string | undefined {
	return (value) => {
		try {
			parse(setting, value);
			return undefined;
		} catch (error) {
			return error instanceof SettingParseError ? error.rule : "Not valid.";
		}
	};
}
