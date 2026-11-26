/**
 * The RFC 8628 device-code grant.
 *
 * This is how `hobo login` gets a real token on a machine with no browser. It
 * is fully seamed — fetch, sleep and clock are all injected — so the whole
 * protocol can be exercised without a network or a real timer, which is what
 * these tests do.
 *
 * The polling loop is where the protocol lives, and §3.5 gives four distinct
 * error responses that a naive implementation collapses into "not yet":
 *
 * - `authorization_pending` — keep going at the same interval.
 * - `slow_down` — keep going, but add five seconds. An implementation that
 *   ignored this would keep hammering at the original rate and be throttled or
 *   blocked by the issuer, turning a slow sign-in into a failed one.
 * - `access_denied` — stop. The user said no, and retrying cannot change that.
 * - `expired_token` — stop. The code is dead; a new one is needed.
 *
 * The other property worth naming: **no fixture fallback.** Every failure is a
 * typed `DeviceGrantError` carrying remediation, because the alternative — a
 * grant that quietly degraded to the offline fixture session on error — would
 * hand the caller an unprivileged token while reporting a successful login.
 */
import { describe, expect, it } from "vitest";

import {
	DEFAULT_OIDC_CLIENT_ID,
	DEVICE_CODE_GRANT_TYPE,
	DeviceGrantError,
	HOBO_OIDC_AUDIENCE_ENV,
	HOBO_OIDC_CLIENT_ID_ENV,
	HOBO_OIDC_ISSUER_ENV,
	resolveOidcIssuerConfig,
	runDeviceCodeGrant,
} from "../src/oidc-device-grant.js";

const ISSUER = "https://issuer.example";

const CONFIG = {
	issuer: ISSUER,
	clientId: "hobo-cli",
	audience: "hobo-cli",
};

const METADATA = {
	issuer: ISSUER,
	device_authorization_endpoint: `${ISSUER}/device`,
	token_endpoint: `${ISSUER}/token`,
	jwks_uri: `${ISSUER}/jwks`,
};

const AUTHORIZATION = {
	device_code: "dc-1",
	user_code: "WXYZ-1234",
	verification_uri: `${ISSUER}/activate`,
	expires_in: 300,
	interval: 5,
};

type Reply = { ok?: boolean; status?: number; json?: unknown };

/**
 * A fetch stand-in routing by URL: discovery, device authorization, then a
 * queue of token replies, then JWKS.
 */
function issuer(options: {
	discovery?: Reply;
	authorization?: Reply;
	tokens?: readonly Reply[];
	jwks?: Reply;
	throwOn?: (url: string) => boolean;
}) {
	const seen: Array<{ url: string; body?: string }> = [];
	let tokenIndex = 0;
	const reply = (r: Reply | undefined) => ({
		ok: r?.ok ?? true,
		status: r?.status ?? 200,
		json: async () => (r && Object.hasOwn(r, "json") ? r.json : {}),
	});
	const impl = (async (url: string, init?: RequestInit) => {
		seen.push({ url, body: init?.body as string | undefined });
		if (options.throwOn?.(url)) throw new Error("network unreachable");
		if (url.includes("openid-configuration")) {
			return reply(options.discovery ?? { json: METADATA });
		}
		if (url.endsWith("/device")) {
			return reply(options.authorization ?? { json: AUTHORIZATION });
		}
		if (url.endsWith("/token")) {
			const queue = options.tokens ?? [];
			const next = queue[Math.min(tokenIndex, queue.length - 1)];
			tokenIndex += 1;
			return reply(next);
		}
		return reply(options.jwks ?? { json: { keys: [] } });
	}) as unknown as typeof fetch;
	return {
		impl,
		seen,
		get tokenCalls() {
			return tokenIndex;
		},
	};
}

/** Records every sleep so the polling cadence can be asserted directly. */
function clock(startMs = 1_000_000) {
	const slept: number[] = [];
	let current = startMs;
	return {
		slept,
		now: () => current,
		sleep: async (ms: number) => {
			slept.push(ms);
			current += ms;
		},
		advance: (ms: number) => {
			current += ms;
		},
	};
}

async function grantFails(
	options: Parameters<typeof issuer>[0],
	overrides: Record<string, unknown> = {},
): Promise<DeviceGrantError> {
	const time = clock();
	try {
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: issuer(options).impl,
			sleep: time.sleep,
			now: time.now,
			...overrides,
		} as never);
	} catch (error) {
		expect(error).toBeInstanceOf(DeviceGrantError);
		return error as DeviceGrantError;
	}
	throw new Error("expected the device grant to fail");
}

describe("resolveOidcIssuerConfig", () => {
	it("returns null when no issuer is configured", () => {
		// Null is the signal that `hobo login` stays on the offline fixture lane.
		// Throwing here would make an unconfigured machine unable to run login at
		// all, which is the common case for a first-time user.
		expect(resolveOidcIssuerConfig({})).toBeNull();
	});

	it("treats a blank or whitespace issuer as unconfigured", () => {
		// An exported-but-empty variable is the same as unset. Passing `""`
		// through would produce a discovery URL of `/.well-known/...` and a
		// failure that reads as an unreachable issuer rather than a missing one.
		for (const raw of ["", "   ", "\t"]) {
			expect(
				resolveOidcIssuerConfig({ [HOBO_OIDC_ISSUER_ENV]: raw }),
			).toBeNull();
		}
	});

	it("ignores a non-string issuer", () => {
		expect(
			resolveOidcIssuerConfig({ [HOBO_OIDC_ISSUER_ENV]: 7 } as never),
		).toBeNull();
	});

	it("trims the issuer and strips trailing slashes", () => {
		// The issuer string is compared byte-for-byte against the `issuer` claim
		// in the discovery document. A trailing slash would fail that comparison
		// against an issuer that is otherwise correct.
		expect(
			resolveOidcIssuerConfig({ [HOBO_OIDC_ISSUER_ENV]: `  ${ISSUER}///  ` })
				?.issuer,
		).toBe(ISSUER);
	});

	it("defaults the client id", () => {
		expect(
			resolveOidcIssuerConfig({ [HOBO_OIDC_ISSUER_ENV]: ISSUER })?.clientId,
		).toBe(DEFAULT_OIDC_CLIENT_ID);
	});

	it("honours an explicit client id, trimmed", () => {
		expect(
			resolveOidcIssuerConfig({
				[HOBO_OIDC_ISSUER_ENV]: ISSUER,
				[HOBO_OIDC_CLIENT_ID_ENV]: "  my-client  ",
			})?.clientId,
		).toBe("my-client");
	});

	it("falls back to the default for a blank client id", () => {
		expect(
			resolveOidcIssuerConfig({
				[HOBO_OIDC_ISSUER_ENV]: ISSUER,
				[HOBO_OIDC_CLIENT_ID_ENV]: "   ",
			})?.clientId,
		).toBe(DEFAULT_OIDC_CLIENT_ID);
	});

	it("defaults the audience to the client id", () => {
		// The token's audience is checked at verification. Defaulting to the
		// client id matches what most issuers mint by default; leaving it empty
		// would fail every verification for a correctly-configured issuer.
		expect(
			resolveOidcIssuerConfig({
				[HOBO_OIDC_ISSUER_ENV]: ISSUER,
				[HOBO_OIDC_CLIENT_ID_ENV]: "my-client",
			})?.audience,
		).toBe("my-client");
	});

	it("honours an explicit audience distinct from the client id", () => {
		// Issuers that front several APIs mint per-audience tokens. Without this
		// the CLI would present a token scoped to itself rather than to the API.
		const config = resolveOidcIssuerConfig({
			[HOBO_OIDC_ISSUER_ENV]: ISSUER,
			[HOBO_OIDC_CLIENT_ID_ENV]: "my-client",
			[HOBO_OIDC_AUDIENCE_ENV]: "https://api.example",
		});
		expect(config?.audience).toBe("https://api.example");
		expect(config?.clientId).toBe("my-client");
	});

	it("falls back to the client id for a blank audience", () => {
		expect(
			resolveOidcIssuerConfig({
				[HOBO_OIDC_ISSUER_ENV]: ISSUER,
				[HOBO_OIDC_AUDIENCE_ENV]: "  ",
			})?.audience,
		).toBe(DEFAULT_OIDC_CLIENT_ID);
	});
});

describe("discovery", () => {
	it("fetches the well-known document from the issuer", async () => {
		const fetched = issuer({});
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: fetched.impl,
			sleep: clock().sleep,
			now: clock().now,
		} as never).catch(() => undefined);
		expect(fetched.seen[0]?.url).toBe(
			`${ISSUER}/.well-known/openid-configuration`,
		);
	});

	it("reports a non-200 discovery with remediation naming the env var", async () => {
		// The remediation is the whole value of a typed error here: the person
		// hitting this has misconfigured one environment variable, and the error
		// says which.
		const error = await grantFails({ discovery: { ok: false, status: 404 } });
		expect(error.code).toBe("HOBO_OIDC_DISCOVERY_FAILED");
		expect(error.remediation.join(" ")).toContain(HOBO_OIDC_ISSUER_ENV);
	});

	it("reports an unreachable issuer distinctly from a bad response", async () => {
		// A thrown fetch is a network problem; a 404 is a wrong URL. The
		// remediation differs, and this arm suggests unsetting the variable to
		// fall back to the offline lane.
		const error = await grantFails({
			throwOn: (url) => url.includes("openid-configuration"),
		});
		expect(error.code).toBe("HOBO_OIDC_DISCOVERY_FAILED");
		expect(error.remediation.join(" ")).toContain("offline fixture session");
	});

	it("refuses a discovery document that is not an object", async () => {
		for (const json of [null, "metadata", 7]) {
			const error = await grantFails({ discovery: { json } });
			expect(error.code).toBe("HOBO_OIDC_METADATA_INVALID");
		}
	});

	it("refuses a document whose issuer does not match the configured one", async () => {
		// The mix-up check. An issuer serving a document for a *different* issuer
		// means a misconfigured proxy or an impersonation, and continuing would
		// have the CLI mint a token from one issuer and verify it against
		// another's expectations.
		const error = await grantFails({
			discovery: { json: { ...METADATA, issuer: "https://other.example" } },
		});
		expect(error.code).toBe("HOBO_OIDC_METADATA_INVALID");
		expect(error.message).toContain("does not match configured issuer");
	});

	it("refuses a document missing any endpoint it needs, naming which", async () => {
		// Named individually because they fail for different reasons: no
		// device_authorization_endpoint means the issuer does not do RFC 8628 at
		// all, which is a different conversation from a missing jwks_uri.
		for (const [field, needle] of [
			["device_authorization_endpoint", "RFC 8628"],
			["token_endpoint", "token_endpoint"],
			["jwks_uri", "jwks_uri"],
		] as const) {
			const error = await grantFails({
				discovery: { json: { ...METADATA, [field]: undefined } },
			});
			expect(error.code).toBe("HOBO_OIDC_METADATA_INVALID");
			expect(error.message).toContain(needle);
		}
	});
});

describe("device authorization", () => {
	it("posts the client id and the openid scope as a form", async () => {
		// RFC 8628 §3.1 is form-encoded, not JSON. An issuer receiving JSON here
		// answers 400, which would read as an unregistered client.
		const fetched = issuer({ tokens: [{ json: { access_token: "at" } }] });
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: fetched.impl,
			sleep: clock().sleep,
			now: clock().now,
		} as never).catch(() => undefined);
		const request = fetched.seen.find((entry) => entry.url.endsWith("/device"));
		expect(request?.body).toContain("client_id=hobo-cli");
		expect(request?.body).toContain("scope=openid");
	});

	it("reports a rejected client id with the override to fix it", async () => {
		const error = await grantFails({
			authorization: { ok: false, status: 401 },
		});
		expect(error.code).toBe("HOBO_OIDC_DEVICE_AUTH_FAILED");
		expect(error.remediation.join(" ")).toContain(HOBO_OIDC_CLIENT_ID_ENV);
	});

	it("reports an unreachable device endpoint", async () => {
		const error = await grantFails({
			throwOn: (url) => url.endsWith("/device"),
		});
		expect(error.code).toBe("HOBO_OIDC_DEVICE_AUTH_FAILED");
	});

	it("refuses a response missing any of the three required fields", async () => {
		// Without a device code there is nothing to poll for; without a user code
		// or verification URI the person cannot complete the sign-in. All three
		// are required by §3.2.
		for (const field of ["device_code", "user_code", "verification_uri"]) {
			const error = await grantFails({
				authorization: { json: { ...AUTHORIZATION, [field]: undefined } },
			});
			expect(error.code).toBe("HOBO_OIDC_DEVICE_AUTH_FAILED");
			expect(error.message).toContain("missing device_code");
		}
	});

	it("tells the user where to go and what to type", async () => {
		// The progress line is the only way the person learns the code. Without
		// it the CLI would poll silently until the code expired.
		const messages: string[] = [];
		const time = clock();
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: issuer({ tokens: [{ json: { access_token: "at" } }] }).impl,
			sleep: time.sleep,
			now: time.now,
			emitProgress: (message) => messages.push(message),
		} as never).catch(() => undefined);
		expect(messages.join(" ")).toContain(`${ISSUER}/activate`);
		expect(messages.join(" ")).toContain("WXYZ-1234");
	});

	it("runs without a progress callback", async () => {
		// `emitProgress?.()` — optional. A caller that supplies none must not
		// crash the grant on an undefined call.
		const time = clock();
		await expect(
			runDeviceCodeGrant({
				config: CONFIG,
				fetchImpl: issuer({ tokens: [{ json: { access_token: "at" } }] }).impl,
				sleep: time.sleep,
				now: time.now,
			} as never).catch((error: unknown) => error),
		).resolves.toBeDefined();
	});
});

describe("polling, per RFC 8628 §3.5", () => {
	it("waits the issuer's interval before the first poll", async () => {
		// Polling immediately would race the person, who has not yet opened the
		// browser — and would burn one attempt against a rate limit for nothing.
		const time = clock();
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: issuer({ tokens: [{ json: { access_token: "at" } }] }).impl,
			sleep: time.sleep,
			now: time.now,
		} as never).catch(() => undefined);
		expect(time.slept[0]).toBe(5000);
	});

	it("defaults the interval to five seconds when the issuer omits one", async () => {
		const time = clock();
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: issuer({
				authorization: { json: { ...AUTHORIZATION, interval: undefined } },
				tokens: [{ json: { access_token: "at" } }],
			}).impl,
			sleep: time.sleep,
			now: time.now,
		} as never).catch(() => undefined);
		expect(time.slept[0]).toBe(5000);
	});

	it("honours a longer interval the issuer asked for", async () => {
		const time = clock();
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: issuer({
				authorization: { json: { ...AUTHORIZATION, interval: 10 } },
				tokens: [{ json: { access_token: "at" } }],
			}).impl,
			sleep: time.sleep,
			now: time.now,
		} as never).catch(() => undefined);
		expect(time.slept[0]).toBe(10_000);
	});

	it("keeps polling while the issuer says authorization_pending", async () => {
		// The normal path: the person is still typing the code. Treating pending
		// as a failure would make every real sign-in fail.
		const time = clock();
		const fetched = issuer({
			tokens: [
				{ ok: false, status: 400, json: { error: "authorization_pending" } },
				{ ok: false, status: 400, json: { error: "authorization_pending" } },
				{ json: { access_token: "at-final" } },
			],
		});
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: fetched.impl,
			sleep: time.sleep,
			now: time.now,
		} as never).catch(() => undefined);
		expect(fetched.tokenCalls).toBe(3);
		expect(time.slept).toEqual([5000, 5000, 5000]);
	});

	it("adds five seconds to the interval on slow_down, and keeps it", async () => {
		// The rule that matters most for a real issuer. Ignoring `slow_down`
		// keeps hammering at the original rate and gets the client throttled or
		// blocked — turning a slow sign-in into a failed one. The increment also
		// has to *persist*: reverting to the old interval on the next poll would
		// be the same mistake one round later.
		const time = clock();
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: issuer({
				tokens: [
					{ ok: false, status: 400, json: { error: "slow_down" } },
					{ ok: false, status: 400, json: { error: "authorization_pending" } },
					{ json: { access_token: "at" } },
				],
			}).impl,
			sleep: time.sleep,
			now: time.now,
		} as never).catch(() => undefined);
		expect(time.slept).toEqual([5000, 10_000, 10_000]);
	});

	it("compounds repeated slow_down responses", async () => {
		const time = clock();
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: issuer({
				tokens: [
					{ ok: false, status: 400, json: { error: "slow_down" } },
					{ ok: false, status: 400, json: { error: "slow_down" } },
					{ json: { access_token: "at" } },
				],
			}).impl,
			sleep: time.sleep,
			now: time.now,
		} as never).catch(() => undefined);
		expect(time.slept).toEqual([5000, 10_000, 15_000]);
	});

	it("stops on access_denied rather than polling until expiry", async () => {
		// The user said no. Continuing to poll would keep the CLI hanging for the
		// full code lifetime on a decision that has already been made.
		const error = await grantFails({
			tokens: [{ ok: false, status: 400, json: { error: "access_denied" } }],
		});
		expect(error.code).toBe("HOBO_OIDC_ACCESS_DENIED");
		expect(error.remediation.join(" ")).toContain("hobo login");
	});

	it("stops on expired_token with the expiry code", async () => {
		const error = await grantFails({
			tokens: [{ ok: false, status: 400, json: { error: "expired_token" } }],
		});
		expect(error.code).toBe("HOBO_OIDC_EXPIRED");
	});

	it("gives up once the code's own lifetime has elapsed", async () => {
		// Belt and braces alongside `expired_token`: an issuer that kept
		// answering `authorization_pending` forever would otherwise poll for ever.
		// The deadline comes from the issuer's own `expires_in`.
		const error = await grantFails({
			authorization: { json: { ...AUTHORIZATION, expires_in: 4 } },
			tokens: [
				{ ok: false, status: 400, json: { error: "authorization_pending" } },
			],
		});
		expect(error.code).toBe("HOBO_OIDC_EXPIRED");
	});

	it("defaults the code lifetime when the issuer omits expires_in", async () => {
		// Five minutes rather than unbounded. Without a default the deadline
		// would be NaN and the comparison would never fire.
		const time = clock();
		const fetched = issuer({
			authorization: { json: { ...AUTHORIZATION, expires_in: undefined } },
			tokens: [{ json: { access_token: "at" } }],
		});
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: fetched.impl,
			sleep: time.sleep,
			now: time.now,
		} as never).catch(() => undefined);
		expect(fetched.tokenCalls).toBe(1);
	});

	it("reports an unrecognised error rather than looping on it", async () => {
		// The `default` arm. An issuer answering with something outside §3.5 is a
		// contract problem, and continuing would spin until the code expired and
		// then report the wrong cause.
		const error = await grantFails({
			tokens: [{ ok: false, status: 400, json: { error: "invalid_client" } }],
		});
		expect(error.code).toBe("HOBO_OIDC_TOKEN_FAILED");
		expect(error.message).toContain("invalid_client");
	});

	it("reports a failure body carrying no error field at all", async () => {
		// `doc.error ?? \`HTTP ${status}\``. A bare 500 with an empty body still
		// has to produce a message that says what happened.
		const error = await grantFails({
			tokens: [{ ok: false, status: 500, json: {} }],
		});
		expect(error.code).toBe("HOBO_OIDC_TOKEN_FAILED");
		expect(error.message).toContain("500");
	});

	it("posts the device-code grant type and the device code", async () => {
		// The grant type string is the protocol identifier; an issuer receiving
		// anything else treats the request as a different grant entirely.
		const fetched = issuer({ tokens: [{ json: { access_token: "at" } }] });
		await runDeviceCodeGrant({
			config: CONFIG,
			fetchImpl: fetched.impl,
			sleep: clock().sleep,
			now: clock().now,
		} as never).catch(() => undefined);
		const request = fetched.seen.find((entry) => entry.url.endsWith("/token"));
		expect(request?.body).toContain(encodeURIComponent(DEVICE_CODE_GRANT_TYPE));
		expect(request?.body).toContain("device_code=dc-1");
	});

	it("refuses a 200 that carries no access token", async () => {
		// A success without a token is unusable, and returning an empty string
		// would have every later call authenticate as nobody.
		for (const json of [{}, { access_token: "" }, { access_token: 7 }]) {
			const error = await grantFails({ tokens: [{ json }] });
			expect(error.code).toBe("HOBO_OIDC_TOKEN_FAILED");
			expect(error.message).toContain("without an access_token");
		}
	});

	it("reports an unreachable token endpoint", async () => {
		const error = await grantFails({
			throwOn: (url) => url.endsWith("/token"),
		});
		expect(error.code).toBe("HOBO_OIDC_TOKEN_FAILED");
	});
});

describe("token verification", () => {
	it("refuses a token it cannot verify against the issuer JWKS", async () => {
		// The last gate, and the one that makes the whole grant worth running: an
		// unverified token is a string somebody handed us. The fixture token here
		// is not a real JWT, so verification must reject it rather than accept a
		// well-formed-looking string.
		const error = await grantFails({
			tokens: [{ json: { access_token: "not-a-jwt" } }],
		});
		expect(error.code).toBe("HOBO_OIDC_TOKEN_INVALID");
	});

	it("reports an unreachable or failing JWKS endpoint", async () => {
		// Without the keys nothing can be verified, and proceeding would accept
		// an unverified token — precisely what this step exists to prevent.
		const error = await grantFails({
			tokens: [{ json: { access_token: "not-a-jwt" } }],
			jwks: { ok: false, status: 500 },
		});
		expect(error.code).toBe("HOBO_OIDC_TOKEN_INVALID");
		expect(error.message).toContain("JWKS");
	});
});

describe("DeviceGrantError", () => {
	it("carries a code and remediation a caller can print", () => {
		const error = new DeviceGrantError("HOBO_OIDC_EXPIRED", "expired", [
			"try again",
		]);
		expect(error.code).toBe("HOBO_OIDC_EXPIRED");
		expect(error.remediation).toEqual(["try again"]);
		expect(error.name).toBe("DeviceGrantError");
	});

	it("never degrades to a fixture session", async () => {
		// Stated as a property of every failure path: each one throws a typed
		// error. A grant that fell back to the offline fixture on failure would
		// hand the caller an unprivileged token while reporting a successful
		// login — the worst possible outcome for an auth flow.
		for (const options of [
			{ discovery: { ok: false, status: 500 } },
			{ authorization: { ok: false, status: 500 } },
			{
				tokens: [{ ok: false, status: 400, json: { error: "access_denied" } }],
			},
		]) {
			const error = await grantFails(options as never);
			expect(error).toBeInstanceOf(DeviceGrantError);
			expect(error.remediation.length).toBeGreaterThan(0);
		}
	});
});
