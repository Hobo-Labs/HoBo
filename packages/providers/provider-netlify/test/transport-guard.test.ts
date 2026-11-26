import { describe, expect, it } from "vitest";

import { NetlifyProviderError } from "../src/provider-errors.js";
import {
	assertAllowedEndpoint,
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	NETLIFY_ALLOWED_PATH_PREFIXES,
	NETLIFY_API_ALLOWED_HOSTS,
} from "../src/transport.js";

/**
 * Assert a refusal names the branch it came from.
 *
 * Every guard refusal reaches a caller as one `NetlifyProviderError` code —
 * `PROVIDER_CONTRACT_CHANGED` — with the core guard's code carried in
 * `detail.guard`. That detail is the only thing distinguishing "you asked for
 * http" from "that host is not ours", so it is what these assertions pin.
 */
function expectRefusal(
	call: () => void,
	guard: string,
	messageFragment: RegExp,
): void {
	try {
		call();
	} catch (cause) {
		if (!(cause instanceof NetlifyProviderError)) throw cause;
		expect(cause.code).toBe("PROVIDER_CONTRACT_CHANGED");
		expect(cause.detail).toMatchObject({ guard });
		expect(cause.message).toMatch(messageFragment);
		return;
	}
	throw new Error("endpoint was admitted instead of refused");
}

/**
 * The outbound guard had no tests of its own before this file, which is how it
 * kept a hole: the local copy checked `pathname.startsWith(prefix)` and nothing
 * else, so a path could enter through `/api/v1/sites/` and climb straight back
 * out. The guard now delegates to `@hobo/core`; these pin the behaviour at the
 * boundary that needs it, so the package does not silently depend on an
 * upstream check with nothing local to notice if it goes away.
 */
describe("netlify outbound guard", () => {
	it("pins the documented host and prefix", () => {
		expect(NETLIFY_API_ALLOWED_HOSTS).toEqual(["api.netlify.com"]);
		expect(NETLIFY_ALLOWED_PATH_PREFIXES).toEqual(["/api/v1/sites/"]);
		expect(
			assertAllowedEndpoint(
				"https://api.netlify.com/api/v1/sites/site_1",
				DEFAULT_TRANSPORT_POLICY,
			).pathname,
		).toBe("/api/v1/sites/site_1");
	});

	it("refuses percent-encoded traversal out of the allowlisted prefix", () => {
		// These three are refused by *two different branches*, and the previous
		// `/PROVIDER_CONTRACT_CHANGED|path/iu` could not tell them apart — it is
		// the §1.1 matcher, and both alternatives match the ordinary prefix
		// refusal, so this test went green whether or not the encoded-separator
		// rule existed at all. Measured with `new URL(u).pathname`:
		//
		//   /api/v1/sites/%2e%2e/user        -> /api/v1/user
		//   /api/v1/sites/%2f%2e%2e%2faccounts -> unchanged
		//   /api/v1/sites/..%5cadmin         -> unchanged
		//
		// WHATWG treats `%2e` as a dot and collapses it during parsing, so the
		// first URL never reaches the separator rule: the prefix check refuses
		// it on its own merits. Only the last two exercise the rule this test
		// is named for, and each row now says which one it is.
		const cases: readonly [url: string, fragment: RegExp][] = [
			[
				"https://api.netlify.com/api/v1/sites/%2e%2e/user",
				/^path \/api\/v1\/user is outside the allowlisted prefixes/u,
			],
			[
				"https://api.netlify.com/api/v1/sites/%2f%2e%2e%2faccounts",
				/percent-encodes a path separator or dot segment/u,
			],
			[
				"https://api.netlify.com/api/v1/sites/..%5cadmin",
				/percent-encodes a path separator or dot segment/u,
			],
		];
		for (const [url, fragment] of cases) {
			expectRefusal(
				() => assertAllowedEndpoint(url, DEFAULT_TRANSPORT_POLICY),
				"TRANSPORT_PATH_FORBIDDEN",
				fragment,
			);
		}
	});

	it("refuses plain http, a lookalike host, userinfo, and an off-prefix path", () => {
		// Five distinct refusals. The previous matcher was
		// `/PROVIDER|https|host|path|url/iu`, which every one of core's guard
		// messages satisfies, so the five rows were interchangeable: the host
		// check could have vanished entirely and this test would still have
		// passed on the scheme refusal's wording.
		const cases: readonly [url: string, guard: string, fragment: RegExp][] = [
			[
				"http://api.netlify.com/api/v1/sites/site_1",
				"TRANSPORT_SCHEME_FORBIDDEN",
				/^request url must use https, got http$/u,
			],
			[
				"https://api.netlify.com.attacker.example/api/v1/sites/site_1",
				"TRANSPORT_HOST_FORBIDDEN",
				/^host api\.netlify\.com\.attacker\.example is not exactly one of the allowlisted provider hosts \(api\.netlify\.com\)$/u,
			],
			[
				"https://user:pass@api.netlify.com/api/v1/sites/site_1",
				"TRANSPORT_HOST_FORBIDDEN",
				/must not embed userinfo/u,
			],
			[
				"https://api.netlify.com/api/v1/undocumented/thing",
				"TRANSPORT_PATH_FORBIDDEN",
				/^path \/api\/v1\/undocumented\/thing is outside the allowlisted prefixes \(\/api\/v1\/sites\/\)$/u,
			],
			[
				"not a url",
				"TRANSPORT_SCHEME_FORBIDDEN",
				/^request url is not a valid absolute URL$/u,
			],
		];
		for (const [url, guard, fragment] of cases) {
			expectRefusal(
				() => assertAllowedEndpoint(url, DEFAULT_TRANSPORT_POLICY),
				guard,
				fragment,
			);
		}
	});

	it("refuses a redirect rather than following it with the credential", async () => {
		const redirecting = createGuardedTransport({
			async request() {
				return {
					status: 302,
					headers: { location: "https://attacker.example/steal" },
					body: "",
				};
			},
		});
		await expect(
			redirecting.request({
				method: "GET",
				url: "https://api.netlify.com/api/v1/sites/site_1",
				headers: {},
				timeoutMs: 1000,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow(
			/^provider returned a 302 redirect, which this transport never follows$/u,
		);
	});
});
