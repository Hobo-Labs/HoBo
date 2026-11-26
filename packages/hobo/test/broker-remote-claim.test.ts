/**
 * The remote broker client's `claim`. The rest of the client is in
 * `broker-remote-client.test.ts`.
 *
 * **A claim token is bearer authority over a deployment.** Whoever holds it can
 * take ownership. That is why the claim path distinguishes a 401/403 with its
 * own code — an invalid token and a broker that is simply unwell demand opposite
 * responses, and collapsing them would have a caller retry a token that will
 * never work, or discard one that would have.
 */
import { describe, expect, it } from "vitest";

import type { RemoteClaimRequest } from "../src/broker-remote-client.js";
import type { JsonValue } from "../src/json.js";
import {
	CLAIM_PAYLOAD,
	CREDENTIAL,
	client,
	sentHeader,
	withField,
	without,
} from "./support/remote-broker-fixtures.js";

describe("claim", () => {
	const REQUEST: RemoteClaimRequest = { claimToken: "ct-1", account: "acme" };

	it("returns the parsed claim", async () => {
		const { client: remote } = client([{ json: CLAIM_PAYLOAD }]);
		const result = await remote.claim(REQUEST);
		expect(result.deploymentId).toBe("dep-1");
		expect(result.owner).toEqual({ id: "user-1", kind: "user" });
	});

	it("posts the claim token and the account", async () => {
		const { client: remote, seen } = client([{ json: CLAIM_PAYLOAD }]);
		await remote.claim(REQUEST);
		expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
			claimToken: "ct-1",
			account: "acme",
		});
	});

	it("claims without a credential, because the token is the authority", async () => {
		// The whole point of a claim token: an anonymous deployment is claimed by
		// whoever holds it, before any account credential exists. Requiring one
		// would make the anonymous lane unclaimable.
		const { client: remote, seen } = client([{ json: CLAIM_PAYLOAD }]);
		await remote.claim(REQUEST);
		expect(sentHeader(seen[0]?.init, "authorization")).toBe(false);
	});

	it("adds an authorization header when a credential was supplied", async () => {
		const { client: remote, seen } = client([{ json: CLAIM_PAYLOAD }]);
		await remote.claim({ ...REQUEST, credential: CREDENTIAL });
		expect(sentHeader(seen[0]?.init, "authorization")).toBe(true);
	});

	it("distinguishes an invalid token from a broker failure", async () => {
		// The consequential branch. An invalid token will never work and a caller
		// should stop; a 500 is worth retrying. One code for both would have a
		// caller do the wrong thing in one of the two cases.
		for (const status of [401, 403]) {
			const { client: remote } = client([{ status, json: {} }]);
			await expect(remote.claim(REQUEST)).rejects.toMatchObject({
				code: "HOBO_CLAIM_TOKEN_INVALID",
			});
		}
		const { client: remote } = client([{ status: 500, json: {} }]);
		await expect(remote.claim(REQUEST)).rejects.toMatchObject({
			code: "HOBO_REMOTE_CLAIM_FAILED",
		});
	});

	it("prefers a code the broker supplied over the status heuristic", async () => {
		// The broker knows more than the status does. A 403 carrying
		// `HOBO_CLAIM_EXPIRED` means issue a new token, not fix this one.
		const { client: remote } = client([
			{ status: 403, json: { code: "HOBO_CLAIM_EXPIRED" } },
		]);
		await expect(remote.claim(REQUEST)).rejects.toMatchObject({
			code: "HOBO_CLAIM_EXPIRED",
		});
	});

	it("survives a non-JSON error body", async () => {
		const { client: remote } = client([{ status: 500, jsonThrows: true }]);
		await expect(remote.claim(REQUEST)).rejects.toThrow(/HTTP 500/u);
	});

	it("refuses a payload with no owner", async () => {
		// A claim result is a statement about who now owns a deployment. Without
		// an owner it states nothing, and accepting it would report a successful
		// claim by nobody.
		const owners: Array<JsonValue | undefined> = [
			undefined,
			null,
			{},
			{ kind: "user" },
			{ id: 7 },
		];
		for (const owner of owners) {
			const { client: remote } = client([
				{ json: withField(CLAIM_PAYLOAD, "owner", owner) },
			]);
			await expect(remote.claim(REQUEST)).rejects.toMatchObject({
				code: "HOBO_REMOTE_CLAIM_INVALID",
			});
		}
	});

	it("refuses a payload that is not an object", async () => {
		for (const json of [null, "claimed", 7]) {
			const { client: remote } = client([{ json }]);
			await expect(remote.claim(REQUEST)).rejects.toMatchObject({
				code: "HOBO_REMOTE_CLAIM_INVALID",
			});
		}
	});

	it("reports a null previous owner for a first claim", async () => {
		// Null rather than absent: a first claim is a distinct fact from a
		// transfer, and a receipt has to be able to say which happened.
		const { client: remote } = client([{ json: CLAIM_PAYLOAD }]);
		expect((await remote.claim(REQUEST)).previousOwner).toBeNull();
	});

	it("carries a previous owner on a transfer", async () => {
		const { client: remote } = client([
			{
				json: {
					...CLAIM_PAYLOAD,
					previousOwner: { id: "user-0", kind: "user" },
				},
			},
		]);
		expect((await remote.claim(REQUEST)).previousOwner).toEqual({
			id: "user-0",
			kind: "user",
		});
	});

	it("normalizes alreadyClaimed to a strict boolean", async () => {
		// `=== true`. Whether a claim was a no-op decides what the CLI tells the
		// user, and a truthy string would report a re-claim as a fresh one.
		const { client: yes } = client([
			{ json: { ...CLAIM_PAYLOAD, alreadyClaimed: true } },
		]);
		expect((await yes.claim(REQUEST)).alreadyClaimed).toBe(true);
		const notTrue: Array<JsonValue | undefined> = ["true", 1, undefined, null];
		for (const alreadyClaimed of notTrue) {
			const { client: no } = client([
				{ json: withField(CLAIM_PAYLOAD, "alreadyClaimed", alreadyClaimed) },
			]);
			expect((await no.claim(REQUEST)).alreadyClaimed).toBe(false);
		}
	});

	it("defaults the status to claimed", async () => {
		const { client: remote } = client([{ json: CLAIM_PAYLOAD }]);
		expect((await remote.claim(REQUEST)).status).toBe("claimed");
	});

	it("refuses a payload missing a required locator", async () => {
		for (const field of ["deploymentId", "primaryUrl"]) {
			const { client: remote } = client([
				{ json: without(CLAIM_PAYLOAD, field) },
			]);
			await expect(remote.claim(REQUEST)).rejects.toMatchObject({
				code: "HOBO_REMOTE_PAYLOAD_INVALID",
			});
		}
	});
});
