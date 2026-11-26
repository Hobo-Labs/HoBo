/**
 * Provisioning an anonymous Environment Station on a Cloudflare temporary
 * account.
 *
 * This path runs with **no user credentials**: it solves a proof-of-work
 * challenge, is handed a short-lived account, and deploys a Worker into it. So
 * the properties worth pinning are about what it puts in somebody's account and
 * what name it puts it under.
 *
 * **The script name is derived, bounded and DNS-legal.** It becomes a
 * `workers.dev` hostname, so anything outside `[a-z0-9-]` or over 63 characters
 * is not a cosmetic problem — it is a deploy that fails, or worse, a name that
 * collides with another station's. The comment in the source records that long
 * UUID station ids used to be truncated mid-hyphen; taking the *last* 24
 * characters of a compacted id is what fixed it, and reversing that would
 * reintroduce the bug for exactly the ids that are hardest to test by hand.
 *
 * **The Worker module is checked for application code before it is uploaded.**
 * An Environment Station is infrastructure; shipping app code inside it would
 * put user code in an account the user does not yet own.
 *
 * **Cloudflare's envelope is unwrapped, not trusted.** `success: false` with a
 * 200 status is a normal Cloudflare answer, so the status alone is not the
 * verdict, and an envelope with no `result` is a failure even when it claims
 * success.
 *
 * **Two field spellings are accepted throughout** (`accountId` /`account_id`,
 * nested `account.apiToken`), because the Temporary Accounts API has shipped
 * more than one shape and a station that only understood today's would break
 * silently on a rollout.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../src/json.js";
import type { TemporaryEnvironmentStationInput } from "../src/temporary-station.js";

import {
	CF_API_BASE,
	CLOUDFLARE_TEMPORARY_PROVIDER_ID,
	createCloudflareTemporaryAccountTransport,
	provisionTemporaryEnvironmentStation,
	TEMPORARY_STATION_TTL_MS,
	type TemporaryAccountTransport,
} from "../src/temporary-station.js";

/** A transport that provisions without solving anything. */
function transport(
	overrides: Partial<TemporaryAccountTransport> = {},
): TemporaryAccountTransport & { deployed: JsonObject[] } {
	const deployed: JsonObject[] = [];
	return {
		deployed,
		requestChallenge: async () => ({
			challengeToken: "tok",
			seed: Buffer.alloc(32, 1).toString("base64url"),
			k: 2,
			g: 2,
		}),
		createPreviewAccount: async () => ({
			accountId: "acc-1",
			apiToken: "cf-token",
			claimUrl: "https://dash.cloudflare.com/claim/xyz",
		}),
		deployWorkerScript: async (input) => {
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			deployed.push(input as JsonObject);
			return { workersDevUrl: `https://${input.scriptName}.sub.workers.dev` };
		},
		...overrides,
	};
}

const provision = (input: Partial<TemporaryEnvironmentStationInput> = {}) =>
	provisionTemporaryEnvironmentStation({
		stationId: "station:local",
		transport: transport(),
		...input,
	});

describe("the provisioned station", () => {
	it("reports the provider it was created on", async () => {
		expect((await provision()).providerId).toBe(
			CLOUDFLARE_TEMPORARY_PROVIDER_ID,
		);
	});

	it("declares itself anonymous and temporary", async () => {
		// Both flags drive UI that warns the user this will disappear; a station
		// that under-claimed either would be presented as permanent.
		const station = await provision();
		expect(station.anonymous).toBe(true);
		expect(station.temporary).toBe(true);
	});

	it("carries the station id it was asked for", async () => {
		expect((await provision()).stationId).toBe("station:local");
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("reports the deployed URL as both the station and primary URL", async () => {
		// They are the same thing here; reporting one and not the other would
		// leave a caller reading the wrong field with nothing.
		const station = await provision();
		expect(station.stationUrl).toBe(station.primaryUrl);
		expect(station.stationUrl).toContain(".workers.dev");
	});

	it("carries the claim URL, since the account is not yet the user's", async () => {
		// Without it the temporary account expires and everything in it is lost.
		expect((await provision()).claimUrl).toBe(
			"https://dash.cloudflare.com/claim/xyz",
		);
	});

	it("carries the account the Worker actually landed in", async () => {
		expect((await provision()).accountId).toBe("acc-1");
	});

	it("expires within the declared TTL", async () => {
		// A station with no expiry reads as permanent, which is the one thing a
		// temporary account is not.
		const station = await provision();
		const remaining = Date.parse(station.expiresAt) - Date.now();
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(TEMPORARY_STATION_TTL_MS);
	});
});

describe("the script name", () => {
	const nameFor = async (input: JsonObject) =>
		(await provision(input)).scriptName;

	it("is prefixed so it is identifiable in a shared account", async () => {
		expect(await nameFor({ stationId: "station:local" })).toMatch(/^hobo/u);
	});

	it("strips characters a workers.dev hostname cannot carry", async () => {
		// The name becomes a hostname; a colon in it is a deploy that fails.
		expect(await nameFor({ stationId: "station:local!" })).toMatch(
			/^[a-z0-9-]+$/u,
		);
	});

	it("keeps the tail of a long station id, not the head", async () => {
		// Long UUID ids used to be truncated mid-hyphen and break workers.dev;
		// the distinguishing part of a UUID is at the end.
		const id = `station:${"a".repeat(20)}${"b".repeat(20)}`;
		expect(await nameFor({ stationId: id })).toContain("b");
	});

	it("stays within the 63-character DNS label limit", async () => {
		const name = await nameFor({ stationId: `station:${"x".repeat(200)}` });
		expect(name.length).toBeLessThanOrEqual(63);
	});

	it("falls back to a placeholder for an id with nothing usable in it", async () => {
		// An empty label would produce `https://.sub.workers.dev`.
		expect(await nameFor({ stationId: "!!!" })).toContain("anon");
	});

	it("uses an explicit override", async () => {
		expect(await nameFor({ scriptName: "my-station" })).toBe("my-station");
	});

	it("sanitizes an override rather than trusting the caller", async () => {
		// The caller is not necessarily closer to the DNS rules than this is —
		// and the trailing hyphen a stripped character leaves behind is removed
		// too, since a trailing hyphen is not a legal DNS label either.
		expect(await nameFor({ scriptName: "My Station!" })).toBe("my-station");
	});

	it("does not leave an override starting or ending in a hyphen", async () => {
		// A leading or trailing hyphen is not a legal DNS label.
		const name = await nameFor({ scriptName: "--edge--" });
		expect(name.startsWith("-")).toBe(false);
		expect(name.endsWith("-")).toBe(false);
	});

	it("falls back when an override sanitizes away entirely", async () => {
		expect(await nameFor({ scriptName: "!!!" })).toBe("hobo-env-station");
	});

	it("truncates a long override too", async () => {
		expect((await nameFor({ scriptName: "z".repeat(120) })).length).toBe(63);
	});
});

describe("what gets deployed", () => {
	it("uploads the station Worker module by default", async () => {
		const t = transport();
		await provisionTemporaryEnvironmentStation({
			stationId: "s",
			transport: t,
		});
		expect(String(t.deployed[0]?.moduleSource).length).toBeGreaterThan(0);
	});

	it("refuses a module carrying application code", async () => {
		// An Environment Station is infrastructure. Shipping app code inside it
		// would put user code in an account the user does not own yet.
		await expect(
			provision({
				workerModule: "export default { waspApp: true, fetch() {} };",
			}),
		).rejects.toThrow(/app\/Bindle/u);
	});

	it("deploys with the credentials the temporary account handed back", async () => {
		const t = transport();
		await provisionTemporaryEnvironmentStation({
			stationId: "s",
			transport: t,
		});
		expect(t.deployed[0]).toMatchObject({
			accountId: "acc-1",
			apiToken: "cf-token",
		});
	});

	it("passes compatibility flags through when given", async () => {
		const t = transport();
		await provisionTemporaryEnvironmentStation({
			stationId: "s",
			transport: t,
			compatibilityFlags: ["nodejs_compat"],
		});
		expect(t.deployed[0]?.compatibilityFlags).toEqual(["nodejs_compat"]);
	});

	it("omits compatibility flags entirely when there are none", async () => {
		// An empty array is a different Worker configuration from an absent key.
		const t = transport();
		await provisionTemporaryEnvironmentStation({
			stationId: "s",
			transport: t,
		});
		expect(t.deployed[0]).not.toHaveProperty("compatibilityFlags");
	});

	it("passes bindings through when given", async () => {
		const t = transport();
		await provisionTemporaryEnvironmentStation({
			stationId: "s",
			transport: t,
			bindings: { TEMP_API_TOKEN: "t" },
		});
		expect(t.deployed[0]?.bindings).toEqual({ TEMP_API_TOKEN: "t" });
	});

	it("surfaces a provisioning failure rather than deploying anyway", async () => {
		// Deploying into an account that was never created is the worst kind of
		// half-success: it fails at a point that looks like a Worker problem.
		const t = transport({
			createPreviewAccount: async () => {
				throw new Error("challenge rejected");
			},
		});
		await expect(
			provisionTemporaryEnvironmentStation({
				stationId: "s",
				transport: t,
			}),
		).rejects.toThrow(/challenge rejected/u);
		expect(t.deployed).toHaveLength(0);
	});
});

describe("the Cloudflare transport", () => {
	type Call = { url: string; init: RequestInit };
	const CHALLENGE = {
		challengeToken: "tok",
		seed: "seed",
		k: 2,
		g: 2,
	};

	function cf(script: { status?: number; body?: JsonValue }[] = []) {
		const calls: Call[] = [];
		let n = 0;
		const fetchImpl = async (url: string | URL, init: RequestInit = {}) => {
			const headers = new Headers(init.headers);
			const recorded = { ...init };
			if (
				headers.get("content-type")?.startsWith("multipart/form-data") &&
				init.body
			)
				recorded.body = await new Response(init.body, { headers }).formData();
			calls.push({ url: String(url), init: recorded });
			const entry = script[n++] ?? { body: { success: true, result: {} } };
			const status = entry.status ?? 200;
			return new Response(
				JSON.stringify(entry.body ?? { success: true, result: {} }),
				{ status },
			);
		};
		// SAFETY: fake fetch is the injected Fetch API for this transport.
		const injected = fetchImpl as typeof fetch;
		return {
			calls,
			api: createCloudflareTemporaryAccountTransport(injected),
		};
	}

	const ok = (result: JsonValue) => ({ body: { success: true, result } });

	it("asks the previews endpoint for a challenge", async () => {
		const c = cf([ok({ challengeToken: "tok" })]);
		expect(await c.api.requestChallenge()).toMatchObject({
			challengeToken: "tok",
		});
		expect(c.calls[0]?.url).toBe(
			`${CF_API_BASE}/provisioning/previews/challenge`,
		);
	});

	it("unwraps Cloudflare's success envelope", async () => {
		const c = cf([ok({ challengeToken: "tok" })]);
		expect(await c.api.requestChallenge()).not.toHaveProperty("success");
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("treats success:false as a failure despite a 200", async () => {
		// Cloudflare answers 200 with success:false routinely; reading the status
		// alone would accept an error as a challenge.
		const c = cf([
			{ body: { success: false, errors: [{ message: "rate limited" }] } },
		]);
		await expect(c.api.requestChallenge()).rejects.toThrow(/rate limited/u);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("treats a successful envelope with no result as a failure", async () => {
		// Downstream code would dereference the missing result immediately.
		const c = cf([{ body: { success: true } }]);
		await expect(c.api.requestChallenge()).rejects.toThrow(
			/preview challenge failed/u,
		);
	});

	it("falls back to the HTTP status when Cloudflare gave no error text", async () => {
		const c = cf([{ status: 503, body: { success: false } }]);
		await expect(c.api.requestChallenge()).rejects.toThrow(/HTTP 503/u);
	});

	it("joins several Cloudflare errors rather than reporting only the first", async () => {
		const c = cf([
			{
				body: {
					success: false,
					errors: [{ message: "first" }, { message: "second" }],
				},
			},
		]);
		await expect(c.api.requestChallenge()).rejects.toThrow(/first; second/u);
	});

	it("falls back to an error code when one carries no message", async () => {
		const c = cf([{ body: { success: false, errors: [{ code: 10015 }] } }]);
		await expect(c.api.requestChallenge()).rejects.toThrow(/10015/u);
	});

	it("names which call failed", async () => {
		// "Cloudflare failed" without the label leaves an operator guessing which
		// of five requests it was.
		const c = cf([{ body: { success: false } }]);
		await expect(c.api.requestChallenge()).rejects.toThrow(
			/Cloudflare preview challenge failed/u,
		);
	});

	it("accepts the camelCase account shape", async () => {
		const c = cf([
			ok({
				accountId: "a",
				apiToken: "t",
				claimUrl: "https://dash.cloudflare.com/claim/test",
			}),
		]);
		expect(
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			await c.api.createPreviewAccount(CHALLENGE, { checkpoints: "" }),
		).toMatchObject({ accountId: "a", apiToken: "t" });
	});

	it("accepts the snake_case account shape", async () => {
		// The API has shipped more than one spelling; understanding only today's
		// would break silently on a rollout.
		const c = cf([
			ok({
				account_id: "a",
				api_token: "t",
				claim_url: "https://dash.cloudflare.com/claim/test",
			}),
		]);
		expect(
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			await c.api.createPreviewAccount(CHALLENGE, { checkpoints: "" }),
		).toMatchObject({ accountId: "a", apiToken: "t" });
	});

	it("accepts the nested account shape", async () => {
		const c = cf([
			ok({
				account: { id: "a", apiToken: "t" },
				claim: { url: "https://dash.cloudflare.com/claim/test" },
			}),
		]);
		expect(
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			await c.api.createPreviewAccount(CHALLENGE, { checkpoints: "" }),
		).toMatchObject({ accountId: "a", apiToken: "t" });
	});

	it("refuses an account response missing any of the three essentials", async () => {
		// A station with a token and no claim URL is an account nobody can keep.
		const c = cf([ok({ accountId: "a", apiToken: "t" })]);
		await expect(
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			c.api.createPreviewAccount(CHALLENGE, { checkpoints: "" }),
		).rejects.toThrow(/missing accountId\/apiToken\/claimUrl/u);
	});

	it("carries the workers.dev subdomain when the account named one", async () => {
		const c = cf([
			ok({
				accountId: "a",
				apiToken: "t",
				claimUrl: "https://dash.cloudflare.com/claim/test",
				subdomain: "sub",
			}),
		]);
		expect(
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			await c.api.createPreviewAccount(CHALLENGE, { checkpoints: "" }),
		).toMatchObject({ workersDevSubdomain: "sub" });
	});

	it("omits the subdomain rather than reporting an empty one", async () => {
		const c = cf([
			ok({
				accountId: "a",
				apiToken: "t",
				claimUrl: "https://dash.cloudflare.com/claim/test",
			}),
		]);
		expect(
			// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
			await c.api.createPreviewAccount(CHALLENGE, { checkpoints: "" }),
		).not.toHaveProperty("workersDevSubdomain");
	});

	it("accepts the terms explicitly rather than by omission", async () => {
		// Creating an account on someone's behalf requires a recorded acceptance.
		const c = cf([
			ok({
				accountId: "a",
				apiToken: "t",
				claimUrl: "https://dash.cloudflare.com/claim/test",
			}),
		]);
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		await c.api.createPreviewAccount(CHALLENGE, {
			checkpoints: "cp",
		});
		const sent = JSON.parse(String(c.calls[0]?.init.body));
		expect(sent.acceptTermsOfService).toBe("yes");
		expect(sent.challengeToken).toBe("tok");
	});

	it("uploads the script and enables its subdomain", async () => {
		const c = cf([ok({}), ok({ enabled: true }), ok({ subdomain: "team" })]);
		const result = await c.api.deployWorkerScript({
			accountId: "acc",
			apiToken: "tok",
			scriptName: "hobo-env-station-x",
			moduleSource: "export default {}",
		});
		expect(c.calls[0]?.init.method).toBe("PUT");
		expect(c.calls[1]?.url).toContain("/subdomain");
		expect(result.workersDevUrl).toBe(
			"https://hobo-env-station-x.team.workers.dev",
		);
	});

	it("authenticates the upload with the temporary token", async () => {
		const c = cf([ok({}), ok({ enabled: true }), ok({ subdomain: "team" })]);
		await c.api.deployWorkerScript({
			accountId: "acc",
			apiToken: "tok",
			scriptName: "s",
			moduleSource: "export default {}",
		});
		const headers = c.calls[0]?.init.headers;
		expect(headers).toBeDefined();
		if (headers === undefined) throw new Error("missing upload headers");
		const authorization =
			headers instanceof Headers
				? headers.get("authorization")
				: headers.authorization;
		expect(authorization).toBe("Bearer tok");
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("uploads the module as multipart form data", async () => {
		// A Workers script upload is a form with a metadata part and a module
		// part; a JSON body is rejected outright.
		const c = cf([ok({}), ok({ enabled: true }), ok({ subdomain: "team" })]);
		await c.api.deployWorkerScript({
			accountId: "acc",
			apiToken: "tok",
			scriptName: "s",
			moduleSource: "export default {}",
		});
		expect(c.calls[0]?.init.body).toBeInstanceOf(FormData);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("names the module as the entry point in its metadata", async () => {
		const c = cf([ok({}), ok({ enabled: true }), ok({ subdomain: "team" })]);
		await c.api.deployWorkerScript({
			accountId: "acc",
			apiToken: "tok",
			scriptName: "s",
			moduleSource: "export default {}",
		});
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const form = c.calls[0]?.init.body as FormData;
		// SAFETY: test fixture is the named domain type after this assertion.
		const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
		expect(metadata.main_module).toBe("station.js");
		expect(form.get("station.js")).toBeInstanceOf(File);
	});

	it("declares compatibility flags in the metadata when there are any", async () => {
		const c = cf([ok({}), ok({ enabled: true }), ok({ subdomain: "team" })]);
		await c.api.deployWorkerScript({
			accountId: "acc",
			apiToken: "tok",
			scriptName: "s",
			moduleSource: "export default {}",
			compatibilityFlags: ["nodejs_compat"],
		});
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const form = c.calls[0]?.init.body as FormData;
		// SAFETY: test fixture is the named domain type after this assertion.
		const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
		expect(metadata.compatibility_flags).toEqual(["nodejs_compat"]);
	});

	it("omits the flags key for an empty flag list", async () => {
		const c = cf([ok({}), ok({ enabled: true }), ok({ subdomain: "team" })]);
		await c.api.deployWorkerScript({
			accountId: "acc",
			apiToken: "tok",
			scriptName: "s",
			moduleSource: "export default {}",
			compatibilityFlags: [],
		});
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const form = c.calls[0]?.init.body as FormData;
		// SAFETY: test fixture is the named domain type after this assertion.
		const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
		expect(metadata).not.toHaveProperty("compatibility_flags");
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("declares bindings as plain text entries", async () => {
		const c = cf([ok({}), ok({ enabled: true }), ok({ subdomain: "team" })]);
		await c.api.deployWorkerScript({
			accountId: "acc",
			apiToken: "tok",
			scriptName: "s",
			moduleSource: "export default {}",
			bindings: { TEMP_API_TOKEN: "v" },
		});
		// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
		const form = c.calls[0]?.init.body as FormData;
		// SAFETY: test fixture is the named domain type after this assertion.
		const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
		expect(metadata.bindings).toEqual([
			{ type: "plain_text", name: "TEMP_API_TOKEN", text: "v" },
		]);
	});

	it("fails the deploy when the script upload is rejected", async () => {
		// The upload is the one step with no fallback: without it there is no
		// Worker to address.
		const c = cf([
			{ body: { success: false, errors: [{ message: "quota" }] } },
		]);
		await expect(
			c.api.deployWorkerScript({
				accountId: "acc",
				apiToken: "tok",
				scriptName: "s",
				moduleSource: "export default {}",
			}),
		).rejects.toThrow(/workers script upload failed/u);
	});

	it("refuses a failed subdomain enable rather than fabricating activation", async () => {
		const c = cf([
			ok({}),
			{ body: { success: false } },
			ok({ subdomain: "t" }),
		]);
		await expect(
			c.api.deployWorkerScript({
				accountId: "acc",
				apiToken: "tok",
				scriptName: "s",
				moduleSource: "export default {}",
			}),
		).rejects.toThrow(/subdomain enable failed/u);
	});

	// SAFETY: fixture/test or I/O boundary value is the named domain type after this assertion.
	it("refuses missing provider subdomain evidence instead of guessing a hostname", async () => {
		const c = cf([ok({}), ok({ enabled: true }), ok({})]);
		await expect(
			c.api.deployWorkerScript({
				accountId: "acc",
				apiToken: "tok",
				scriptName: "s",
				moduleSource: "export default {}",
			}),
		).rejects.toThrow(/reported a valid workers.dev subdomain/u);
	});
});
