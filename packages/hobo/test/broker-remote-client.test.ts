/**
 * The remote broker client: construction, the anonymous session, and the
 * error it throws. Placement is in `broker-remote-place.test.ts` and claiming
 * in `broker-remote-claim.test.ts`.
 *
 * Three operations — anonymous session, place, claim — each of which crosses the
 * network and comes back as a *parsed* record rather than a response. The
 * parsing is the point: nothing downstream re-checks a broker's payload, so a
 * field this parser lets through is treated as real for the rest of the deploy.
 * A missing `primaryUrl` accepted as an empty string produces a deployment
 * receipt naming an address nobody can open, discovered by whoever tries.
 *
 * **Discovery is fetched once and cached.** A client that re-discovered per call
 * could be repointed mid-deploy by a changed document, so that place and claim
 * for one deployment went to two different brokers.
 */
import { describe, expect, it } from "vitest";

import {
	createRemoteBrokerClient,
	RemoteBrokerClientError,
} from "../src/broker-remote-client.js";
import type { JsonValue } from "../src/json.js";
import {
	BROKER,
	CREDENTIAL,
	client,
	DISCOVERY,
	discoveryFor,
	PLACE_PAYLOAD,
	SESSION_PAYLOAD,
	withField,
	without,
} from "./support/remote-broker-fixtures.js";

describe("remote deployment endpoint safety", () => {
	it.each([
		"https://other.example/v1/place",
		"http://broker.example/v1/place",
		"https://user:pass@broker.example/v1/place",
	])("refuses unsafe discovered placement endpoint %s before sending credentials", async (placeEndpoint) => {
		const { client: remote, seen } = client([], {
			...DISCOVERY,
			placeEndpoint,
		});
		await expect(
			remote.place({
				bindleName: "app",
				projectDir: "/app",
				credential: CREDENTIAL,
			}),
		).rejects.toMatchObject({ code: "HOBO_BROKER_ENDPOINT_UNSAFE" });
		expect(seen).toHaveLength(0);
	});

	it("does not follow redirects carrying anonymous-session POST bodies", async () => {
		const { client: remote, seen } = client([{ status: 307 }]);
		await expect(remote.createAnonymousSession()).rejects.toMatchObject({
			code: "HOBO_ANON_SESSION_FAILED",
		});
		expect(seen[0]?.init.redirect).toBe("error");
	});

	it("refuses a cross-origin claim endpoint before sending the claim token", async () => {
		const { client: remote, seen } = client([], {
			...DISCOVERY,
			claimEndpoint: "https://other.example/claim",
		});
		await expect(
			remote.claim({
				claimToken: "claim-test-token",
				account: "account-1",
				credential: CREDENTIAL,
			}),
		).rejects.toMatchObject({ code: "HOBO_BROKER_ENDPOINT_UNSAFE" });
		expect(seen).toHaveLength(0);
	});

	it("blocks redirects on credential-bearing placement and claim requests", async () => {
		const { client: remote, seen } = client([{ status: 307 }]);
		await expect(
			remote.place({
				bindleName: "app",
				projectDir: "/app",
				credential: CREDENTIAL,
			}),
		).rejects.toThrow();
		await expect(
			remote.claim({
				claimToken: "claim-test-token",
				account: "account-1",
				credential: CREDENTIAL,
			}),
		).rejects.toThrow();
		expect(seen).toHaveLength(2);
		expect(seen.every(({ init }) => init.redirect === "error")).toBe(true);
	});
});

describe("construction", () => {
	it("strips trailing slashes from the broker URI", () => {
		// Endpoints are joined onto this. Without the strip the URL would contain
		// `//`, which some gateways normalise and others route differently — a
		// difference that shows up in one environment only.
		expect(
			createRemoteBrokerClient({
				brokerUri: `${BROKER}///`,
				discovery: discoveryFor().client,
			}).brokerUri,
		).toBe(BROKER);
	});

	it("reports the broker it was built for", () => {
		expect(client().client.brokerUri).toBe(BROKER);
	});

	it("caches discovery across calls", async () => {
		// A client that re-discovered per call could be repointed mid-deploy, so
		// that place and claim for one deployment reached two different brokers.
		const { client: remote, discovery } = client([
			{ json: SESSION_PAYLOAD },
			{ json: PLACE_PAYLOAD },
		]);
		await remote.discover();
		await remote.discover();
		await remote.createAnonymousSession();
		expect(discovery.calls).toBe(1);
	});
});

describe("createAnonymousSession", () => {
	it("returns the parsed session", async () => {
		const { client: remote } = client([{ json: SESSION_PAYLOAD }]);
		const session = await remote.createAnonymousSession();
		expect(session.deploymentId).toBe("dep-1");
		expect(session.ephemeralPrincipal.id).toBe("anon-1");
		expect(session.claimToken).toBe("ct-1");
	});

	it("refuses when the broker does not advertise anonymous support", async () => {
		// Checked before the request, not after. Posting to an endpoint the
		// broker never advertised would produce a 404 that reads as an outage.
		const { client: remote, seen } = client([], {
			...DISCOVERY,
			supportsAnonymous: false,
		});
		await expect(remote.createAnonymousSession()).rejects.toMatchObject({
			code: "HOBO_ANON_NOT_SUPPORTED",
			data: { brokerId: "broker-1" },
		});
		expect(seen).toEqual([]);
	});

	it("posts the bindle name, defaulting it rather than omitting it", async () => {
		// The broker records what was deployed. An absent name would produce a
		// session attributed to nothing; `"unknown"` at least says so honestly.
		const { client: remote, seen } = client([{ json: SESSION_PAYLOAD }]);
		await remote.createAnonymousSession();
		expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
			bindleName: "unknown",
		});
	});

	it("carries a stated bindle name", async () => {
		const { client: remote, seen } = client([{ json: SESSION_PAYLOAD }]);
		await remote.createAnonymousSession({ bindleName: "shop" });
		expect(JSON.parse(String(seen[0]?.init.body)).bindleName).toBe("shop");
	});

	it("resolves a relative endpoint against the broker URI", async () => {
		const { client: remote, seen } = client([{ json: SESSION_PAYLOAD }]);
		await remote.createAnonymousSession();
		expect(seen[0]?.url).toBe(`${BROKER}/v1/anonymous-session`);
	});

	it("honours an absolute endpoint the broker advertised", async () => {
		// A broker may serve its session endpoint on a different host. Prefixing
		// the broker URI onto an absolute URL would produce nonsense.
		const { client: remote, seen } = client([{ json: SESSION_PAYLOAD }], {
			...DISCOVERY,
			anonymousSessionEndpoint: "https://auth.example/session",
		});
		await remote.createAnonymousSession();
		expect(seen[0]?.url).toBe("https://auth.example/session");
	});

	it("joins an endpoint that omits its leading slash", async () => {
		const { client: remote, seen } = client([{ json: SESSION_PAYLOAD }], {
			...DISCOVERY,
			anonymousSessionEndpoint: "v1/session",
		});
		await remote.createAnonymousSession();
		expect(seen[0]?.url).toBe(`${BROKER}/v1/session`);
	});

	it("reports a failed request with the status", async () => {
		const { client: remote } = client([{ status: 503 }]);
		await expect(remote.createAnonymousSession()).rejects.toMatchObject({
			code: "HOBO_ANON_SESSION_FAILED",
			message: expect.stringContaining("503"),
		});
	});

	it("defaults the TTL rather than reporting an unbounded session", async () => {
		// A session with no TTL would be treated as permanent by whatever
		// reclaims them, and an anonymous deployment would outlive its lane.
		const { client: remote } = client([{ json: SESSION_PAYLOAD }]);
		expect((await remote.createAnonymousSession()).ttlSeconds).toBe(3600);
	});

	it("honours a TTL the broker stated", async () => {
		const { client: remote } = client([
			{ json: { ...SESSION_PAYLOAD, ttlSeconds: 900 } },
		]);
		expect((await remote.createAnonymousSession()).ttlSeconds).toBe(900);
	});

	it("defaults restrictions to an empty list", async () => {
		// Not undefined: every consumer iterates restrictions, and one would
		// forget the nullish guard.
		const { client: remote } = client([{ json: SESSION_PAYLOAD }]);
		expect((await remote.createAnonymousSession()).restrictions).toEqual([]);
	});

	it("keeps only string restrictions from a mixed list", async () => {
		// A restriction that is not a string cannot be matched against anything,
		// and carrying it would put an unenforceable entry in a policy list that
		// reads as enforced.
		const { client: remote } = client([
			{ json: { ...SESSION_PAYLOAD, restrictions: ["no-egress", 7, null] } },
		]);
		expect((await remote.createAnonymousSession()).restrictions).toEqual([
			"no-egress",
		]);
	});

	it("refuses a payload that is not an object", async () => {
		for (const json of [null, "session", 7, undefined]) {
			const { client: remote } = client([{ json }]);
			await expect(remote.createAnonymousSession()).rejects.toMatchObject({
				code: "HOBO_ANON_SESSION_INVALID",
			});
		}
	});

	it("refuses a payload with no usable ephemeral principal", async () => {
		// The principal is who the deployment is attributed to. An absent or
		// malformed one produces a deployment belonging to nobody.
		const principals: Array<JsonValue | undefined> = [
			undefined,
			null,
			{},
			{ id: "anon-1" },
			{ kind: "ephemeral" },
			{ id: 7, kind: "ephemeral" },
		];
		for (const principal of principals) {
			const { client: remote } = client([
				{ json: withField(SESSION_PAYLOAD, "ephemeralPrincipal", principal) },
			]);
			await expect(remote.createAnonymousSession()).rejects.toMatchObject({
				code: "HOBO_ANON_SESSION_INVALID",
			});
		}
	});

	it("refuses a payload missing any required string field", async () => {
		// Each of these is a locator or a credential. An empty one accepted here
		// becomes a receipt naming an address nobody can open, or a claim URL
		// that leads nowhere.
		for (const field of [
			"accessToken",
			"claimToken",
			"claimUrl",
			"primaryUrl",
			"expiresAt",
			"deploymentId",
		]) {
			const { client: remote } = client([
				{ json: without(SESSION_PAYLOAD, field) },
			]);
			await expect(remote.createAnonymousSession()).rejects.toMatchObject({
				code: "HOBO_REMOTE_PAYLOAD_INVALID",
			});
		}
	});

	it("treats an empty string as missing", async () => {
		// `value.length === 0`. An empty primaryUrl is not a shorter address, it
		// is no address.
		const { client: remote } = client([
			{ json: { ...SESSION_PAYLOAD, primaryUrl: "" } },
		]);
		await expect(remote.createAnonymousSession()).rejects.toMatchObject({
			code: "HOBO_REMOTE_PAYLOAD_INVALID",
		});
	});

	it("names the missing field in the message", async () => {
		// So the operator knows which of six fields the broker omitted rather
		// than that one of them was.
		const { client: remote } = client([
			{ json: without(SESSION_PAYLOAD, "claimUrl") },
		]);
		await expect(remote.createAnonymousSession()).rejects.toThrow(
			/missing field claimUrl/u,
		);
	});
});

describe("RemoteBrokerClientError", () => {
	it("carries a code callers branch on", () => {
		const error = new RemoteBrokerClientError("boom", "HOBO_X");
		expect(error.code).toBe("HOBO_X");
		expect(error.name).toBe("RemoteBrokerClientError");
	});

	it("omits data entirely when there is none", () => {
		// Absent rather than an empty object, so a reader can tell "the broker
		// said nothing" from "the broker sent an empty body".
		expect(new RemoteBrokerClientError("boom", "HOBO_X").data).toBeUndefined();
	});

	it("carries structured data when given", () => {
		expect(
			new RemoteBrokerClientError("boom", "HOBO_X", { retryAfter: 30 }).data,
		).toEqual({ retryAfter: 30 });
	});
});
