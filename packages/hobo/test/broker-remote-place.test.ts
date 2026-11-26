/**
 * The remote broker client's `place`: the placement comes back as a *parsed*
 * record, and nothing downstream re-checks it, so a field this parser lets
 * through is treated as real for the rest of the deploy. A missing
 * `primaryUrl` accepted as an empty string produces a deployment receipt
 * naming an address nobody can open. The rest of the client is in
 * `broker-remote-client.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { RemotePlaceRequest } from "../src/broker-remote-client.js";
import type { JsonValue } from "../src/json.js";
import {
	CREDENTIAL,
	client,
	PLACE_PAYLOAD,
	sentHeader,
	without,
} from "./support/remote-broker-fixtures.js";

describe("place", () => {
	const REQUEST: RemotePlaceRequest = {
		bindleName: "shop",
		projectDir: "/work/shop",
		credential: CREDENTIAL,
	};

	it("returns the parsed placement", async () => {
		const { client: remote } = client([{ json: PLACE_PAYLOAD }]);
		const result = await remote.place(REQUEST);
		expect(result.deploymentId).toBe("dep-1");
		expect(result.primaryUrl).toBe("https://app.example");
		expect(result.brokerId).toBe("broker-1");
	});

	it("sends the credential as an authorization header", async () => {
		// The credential is what the broker authorises the placement against.
		// Sending it in the body instead would put it in request logs.
		const { client: remote, seen } = client([{ json: PLACE_PAYLOAD }]);
		await remote.place(REQUEST);
		expect(sentHeader(seen[0]?.init, "authorization")).toBe(true);
	});

	it("does not put the credential in the request body", async () => {
		const { client: remote, seen } = client([{ json: PLACE_PAYLOAD }]);
		await remote.place(REQUEST);
		expect(String(seen[0]?.init.body)).not.toContain("tok-1");
	});

	it("sends an explicit null camp rather than omitting it", async () => {
		// Absent and null mean different things to a broker that treats a missing
		// key as "use my default". Being explicit says the caller expressed no
		// preference.
		const { client: remote, seen } = client([{ json: PLACE_PAYLOAD }]);
		await remote.place(REQUEST);
		expect(JSON.parse(String(seen[0]?.init.body)).camp).toBeNull();
	});

	/** A place request as an untyped caller (CLI flags, plugin JSON) builds it. */
	function untypedPlace(
		request: Omit<RemotePlaceRequest, "anonymous"> & {
			readonly anonymous: JsonValue;
		},
	): RemotePlaceRequest {
		// SAFETY: deliberately outside the declared type. Requests reach the
		// client from untyped callers, so `anonymous` may be any JSON value; the
		// client reads it with `=== true`, which is the behaviour under test.
		return request as RemotePlaceRequest;
	}

	it("normalizes anonymous to a strict boolean", async () => {
		// `=== true`. A truthy-but-not-true value from a caller would otherwise
		// reach the broker as something other than a boolean, and a strict broker
		// would reject the whole request.
		const { client: remote, seen } = client([{ json: PLACE_PAYLOAD }]);
		await remote.place(untypedPlace({ ...REQUEST, anonymous: "yes" }));
		expect(JSON.parse(String(seen[0]?.init.body)).anonymous).toBe(false);
	});

	it("carries anonymous through when it is genuinely true", async () => {
		const { client: remote, seen } = client([{ json: PLACE_PAYLOAD }]);
		await remote.place({ ...REQUEST, anonymous: true });
		expect(JSON.parse(String(seen[0]?.init.body)).anonymous).toBe(true);
	});

	it("attributes the placement to the presented principal", async () => {
		// Taken from the credential rather than the response. A broker echoing a
		// different principal must not be able to reattribute a deployment to
		// somebody who did not make it.
		const { client: remote } = client([
			{ json: { ...PLACE_PAYLOAD, principal: { id: "other", kind: "user" } } },
		]);
		const result = await remote.place(REQUEST);
		expect(result.principal).toEqual({ id: "user-1", kind: "user" });
		expect(result.credentialScheme).toBe("bearer-session");
	});

	it("carries a human principal only when the credential had one", async () => {
		// The on-behalf-of case. An empty humanPrincipal key would read as a
		// human having authorised something no human touched.
		const { client: plain } = client([{ json: PLACE_PAYLOAD }]);
		expect(Object.hasOwn(await plain.place(REQUEST), "humanPrincipal")).toBe(
			false,
		);

		const { client: onBehalf } = client([{ json: PLACE_PAYLOAD }]);
		const result = await onBehalf.place({
			...REQUEST,
			credential: {
				...CREDENTIAL,
				humanPrincipal: { id: "human-1", kind: "user" },
			},
		});
		expect(result.humanPrincipal).toEqual({ id: "human-1", kind: "user" });
	});

	it("defaults the status to deployed", async () => {
		const { client: remote } = client([{ json: PLACE_PAYLOAD }]);
		expect((await remote.place(REQUEST)).status).toBe("deployed");
	});

	it("honours a status the broker reported", async () => {
		const { client: remote } = client([
			{ json: { ...PLACE_PAYLOAD, status: "pending" } },
		]);
		expect((await remote.place(REQUEST)).status).toBe("pending");
	});

	it("defaults resources to an empty map", async () => {
		const { client: remote } = client([{ json: PLACE_PAYLOAD }]);
		expect((await remote.place(REQUEST)).resources).toEqual({});
	});

	it("ignores a resources value that is not an object", async () => {
		// A string here would otherwise be indexed character by character by
		// whatever read it.
		const { client: remote } = client([
			{ json: { ...PLACE_PAYLOAD, resources: "db" } },
		]);
		expect((await remote.place(REQUEST)).resources).toEqual({});
	});

	it("omits the optional claim fields when the broker sent none", async () => {
		// Conditional spread. A `claimToken: undefined` key would read to a
		// receipt writer as a claim token that exists and is blank.
		const result = await client([{ json: PLACE_PAYLOAD }]).client.place(
			REQUEST,
		);
		for (const field of ["claimToken", "claimUrl", "expiresAt", "ttlSeconds"]) {
			expect(Object.hasOwn(result, field)).toBe(false);
		}
	});

	it("carries the optional claim fields when the broker sent them", async () => {
		const { client: remote } = client([
			{
				json: {
					...PLACE_PAYLOAD,
					claimToken: "ct-1",
					claimUrl: "https://broker.example/claim/ct-1",
					expiresAt: "2026-01-01T00:00:00.000Z",
					ttlSeconds: 900,
				},
			},
		]);
		const result = await remote.place(REQUEST);
		expect(result.claimToken).toBe("ct-1");
		expect(result.ttlSeconds).toBe(900);
	});

	it("ignores an optional field of the wrong type rather than carrying it", async () => {
		// A numeric ttlSeconds is required; a string one is a contract drift that
		// would otherwise be arithmetic'd on somewhere downstream.
		const { client: remote } = client([
			{ json: { ...PLACE_PAYLOAD, ttlSeconds: "900", claimToken: 7 } },
		]);
		const result = await remote.place(REQUEST);
		expect(Object.hasOwn(result, "ttlSeconds")).toBe(false);
		expect(Object.hasOwn(result, "claimToken")).toBe(false);
	});

	it("reports the broker's own message on a failure", async () => {
		// The broker knows why it refused. Replacing its message with a generic
		// one would send an operator to the wrong place.
		const { client: remote } = client([
			{ status: 400, json: { message: "camp is at capacity" } },
		]);
		await expect(remote.place(REQUEST)).rejects.toMatchObject({
			message: "camp is at capacity",
			code: "HOBO_REMOTE_PLACE_FAILED",
		});
	});

	it("falls back to the status when the broker sent no message", async () => {
		const { client: remote } = client([{ status: 502, json: {} }]);
		await expect(remote.place(REQUEST)).rejects.toThrow(/HTTP 502/u);
	});

	it("survives an error body that is not JSON at all", async () => {
		// `.catch(() => ({}))`. A gateway's HTML error page must not turn a
		// reportable failure into an unrelated parse error.
		const { client: remote } = client([{ status: 502, jsonThrows: true }]);
		await expect(remote.place(REQUEST)).rejects.toThrow(/HTTP 502/u);
	});

	it("carries the broker's error body as structured data", async () => {
		// So a caller can branch on what the broker said rather than on its
		// prose.
		const { client: remote } = client([
			{ status: 400, json: { message: "no", retryAfter: 30 } },
		]);
		await expect(remote.place(REQUEST)).rejects.toMatchObject({
			data: { retryAfter: 30 },
		});
	});

	it("refuses a success payload that is not an object", async () => {
		for (const json of [null, "ok", 7]) {
			const { client: remote } = client([{ json }]);
			await expect(remote.place(REQUEST)).rejects.toMatchObject({
				code: "HOBO_REMOTE_PLACE_INVALID",
			});
		}
	});

	it("refuses a success payload missing a required locator", async () => {
		for (const field of ["deploymentId", "primaryUrl", "brokerId"]) {
			const { client: remote } = client([
				{ json: without(PLACE_PAYLOAD, field) },
			]);
			await expect(remote.place(REQUEST)).rejects.toMatchObject({
				code: "HOBO_REMOTE_PAYLOAD_INVALID",
			});
		}
	});
});
