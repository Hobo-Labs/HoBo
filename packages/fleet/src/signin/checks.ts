// Request checks of sign-in (design §7.2): the loopback redirect, PKCE, the
// user code and the shapes the approval page shows. Parse, don't validate:
// each check answers the normalised value or a reason.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

// public-contract: the device-code alphabet of §7.2 (no vowels, no look-alikes).
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const LOOPBACK_PREFIX = /^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]{1,5}\//u;

export type Checked<T> = Readonly<
	{ ok: true; value: T } | { ok: false; reason: string }
>;

/**
 * `http://127.0.0.1:<port>/…` or `http://[::1]:<port>/…` and nothing else: no
 * `localhost` (it can resolve elsewhere), no user info, no fragment, an
 * explicit port in range.
 */
export function checkLoopbackUri(raw: string): Checked<string> {
	if (!LOOPBACK_PREFIX.test(raw))
		return {
			ok: false,
			reason: "redirect_uri is not a loopback address with a port",
		};
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: "redirect_uri does not parse" };
	}
	const port = Number(url.port);
	if (
		url.protocol !== "http:" ||
		!LOOPBACK_HOSTS.has(url.hostname) ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== "" ||
		raw.includes("#") ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535
	)
		return {
			ok: false,
			reason: "redirect_uri is not a loopback address with a port",
		};
	return { ok: true, value: raw };
}

export function isThumbprint(value: string): boolean {
	return BASE64URL_32.test(value);
}

export function isProviderId(value: string): boolean {
	return PROVIDER_ID.test(value);
}

export function isCodeVerifier(value: string): boolean {
	return CODE_VERIFIER.test(value);
}

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(code_verifier))). */
export function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function sha256Text(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function sameText(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}

export function newUserCode(): string {
	let out = "";
	for (let i = 0; i < USER_CODE_LENGTH; i += 1)
		out += USER_CODE_ALPHABET.charAt(randomInt(USER_CODE_ALPHABET.length));
	return out;
}

/** What a person types: any case, with spaces or dashes between groups. */
export function parseUserCode(raw: string): Checked<string> {
	const code = raw.replace(/[\s-]/gu, "").toUpperCase();
	if (code.length !== USER_CODE_LENGTH)
		return { ok: false, reason: `a user code has ${USER_CODE_LENGTH} letters` };
	for (const letter of code)
		if (!USER_CODE_ALPHABET.includes(letter))
			return {
				ok: false,
				reason: "a user code uses only the letters BCDFGHJKLMNPQRSTVWXZ",
			};
	return { ok: true, value: code };
}

/**
 * The state of a device-code sign-in, derived from its user code so that the
 * verification page on any replica finds the same `fleet-signin-<state>`
 * stream without a second index stream.
 */
export function deviceState(userCode: string): string {
	return createHash("sha256")
		.update("hobo-fleet/signin-user-code/v1\u0000", "utf8")
		.update(userCode, "utf8")
		.digest("base64url");
}
