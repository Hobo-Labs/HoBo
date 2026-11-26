/**
 * The chaos lane, driven against the REAL Cloudflare R2 resolver.
 *
 * The resolver plane's load-bearing claim is convergence: reconcile twice and
 * you get one resource with the same physicalId. Cooperative-transport tests
 * prove that on the happy path. They cannot prove the case that actually bites
 * in production — a fault landing *after* the provider applied a write but
 * *before* the driver observed it, which is precisely where a non-convergent
 * driver creates a second resource on retry and an operator pays for two.
 *
 * These tests inject that fault deterministically (by call index, never at
 * random) and assert the invariant holds across the retry.
 */

import { parseResolveRequest } from "@hobo/core";
import {
	CLOUDFLARE_R2_PRODUCT_ID,
	cloudflareResolverRegistry,
} from "@hobo/provider-cloudflare";
import { chaosTransport } from "@hobo/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../src/json.js";

const CREDENTIAL_REF = "env://CLOUDFLARE_API_TOKEN";
const TOKEN = "cf-secret-token-value";

/** A fake account that really holds state, so duplicates are observable. */
function account() {
	const buckets = new Map<string, JsonObject>();
	const json = (status: number, body: JsonValue) => ({
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const missing = () =>
		json(404, {
			success: false,
			errors: [{ code: 10006, message: "not found" }],
			messages: [],
			result: null,
		});
	const transport = async (request: {
		method: string;
		url: string;
		body?: string;
	}) => {
		const path = new URL(request.url).pathname;
		const match = path.match(/\/r2\/buckets(?:\/([^/]+))?$/);
		if (match === null) return missing();
		const name = match[1];
		if (request.method === "GET" && name !== undefined) {
			const found = buckets.get(name);
			return found === undefined
				? missing()
				: json(200, { success: true, errors: [], messages: [], result: found });
		}
		if (request.method === "POST" && name === undefined) {
			// SAFETY: assertion required at this I/O or test boundary.
			const parsed = JSON.parse(request.body ?? "{}") as { name: string };
			const created = {
				name: parsed.name,
				location: "WNAM",
				storage_class: "Standard",
			};
			buckets.set(parsed.name, created);
			return json(200, {
				success: true,
				errors: [],
				messages: [],
				result: created,
			});
		}
		if (request.method === "DELETE" && name !== undefined) {
			return buckets.delete(name)
				? json(200, { success: true, errors: [], messages: [], result: null })
				: missing();
		}
		return missing();
	};
	// SAFETY: assertion required at this I/O or test boundary.
	return { buckets, transport: transport as never };
}

function resolver() {
	return cloudflareResolverRegistry({
		accountId: "acct-chaos",
		resolveCredential: async (ref: string) => {
			if (ref !== CREDENTIAL_REF) throw new Error(`unregistered ref ${ref}`);
			return TOKEN;
		},
	}).get(CLOUDFLARE_R2_PRODUCT_ID);
}

const request = () =>
	parseResolveRequest({
		ref: {
			slot: "bucket",
			productId: CLOUDFLARE_R2_PRODUCT_ID,
			logicalId: "assets",
		},
		desired: { name: "assets" },
		credentialRef: CREDENTIAL_REF,
	});

/**
 * The refusal each injected fault must produce.
 *
 * A bare `rejects.toThrow()` — what these rows carried before — proves only
 * "the reconcile did not resolve", which every one of these cases satisfies
 * for the wrong reason just as easily as the right one: a resolver that
 * refused every faulted call with one generic error, or a harness that threw
 * before the fault was even injected, read identically. Naming the refusal per
 * fault is also how the *shape* of the guarantee becomes visible: a transport
 * failure propagates verbatim, while a provider that answers with the wrong
 * envelope is refused with the status it answered with.
 */
const REFUSAL = {
	"network-error": "chaos: connection reset by peer",
	timeout: "chaos: request exceeded 15000ms deadline",
	"server-error":
		'r2 create bucket assets: Cloudflare response has no boolean "success" field, so it is not the documented v4 envelope (status 500)',
	"rate-limited":
		'r2 create bucket assets: Cloudflare response has no boolean "success" field, so it is not the documented v4 envelope (status 429)',
	"malformed-body":
		"r2 create bucket assets: Cloudflare returned a status 200 body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed; retry, and if it repeats the API contract has changed",
	"truncated-body":
		"r2 create bucket assets: Cloudflare returned a status 200 body that is not JSON, so the outcome of the call is unknown and it is refused rather than assumed; retry, and if it repeats the API contract has changed",
};

describe("chaos: the resolver plane under fault", () => {
	let real: ReturnType<typeof account>;
	beforeEach(() => {
		real = account();
	});

	it.each([
		["network-error"],
		["timeout"],
		["server-error"],
		["rate-limited"],
		["malformed-body"],
	] as const)("a %s during create never reports success, and the retry still converges", async (fault) => {
		const r2 = resolver();
		expect(r2).toBeDefined();
		if (r2 === undefined) return;

		// Call 0 is the existence GET; call 1 is the create POST.
		const chaos = chaosTransport(real.transport, [{ at: 1, fault }]);
		await expect(r2.reconcile(request(), chaos.transport)).rejects.toThrow(
			REFUSAL[fault],
		);
		expect(chaos.fired).toHaveLength(1);

		// The retry runs against a clean transport, as a real re-run would.
		const retry = await r2.reconcile(request(), real.transport);
		expect(real.buckets.size).toBe(1);
		expect(retry.physicalId).toBe("assets");
	});

	it("a fault AFTER the provider applied the write does not duplicate on retry", async () => {
		// This is the case cooperative tests cannot reach: the POST succeeded
		// and the account really holds the bucket, but the driver never saw the
		// response. A driver that retries by creating again would bill twice.
		const r2 = resolver();
		if (r2 === undefined) return;

		const chaos = chaosTransport(real.transport, [
			{ at: 1, fault: "truncated-body" },
		]);
		await expect(r2.reconcile(request(), chaos.transport)).rejects.toThrow(
			REFUSAL["truncated-body"],
		);

		// The write really landed despite the caller's failure.
		expect(real.buckets.size).toBe(1);

		const retry = await r2.reconcile(request(), real.transport);
		expect(real.buckets.size).toBe(1);
		expect(retry.physicalId).toBe("assets");
		// Read-or-create means the retry adopts rather than re-creating.
		expect(retry.action).not.toBe("create");
	});

	it("repeated faults never accumulate resources", async () => {
		const r2 = resolver();
		if (r2 === undefined) return;
		for (const fault of ["network-error", "server-error", "timeout"] as const) {
			const chaos = chaosTransport(real.transport, [{ at: 1, fault }]);
			await expect(r2.reconcile(request(), chaos.transport)).rejects.toThrow(
				REFUSAL[fault],
			);
		}
		await r2.reconcile(request(), real.transport);
		expect(real.buckets.size).toBe(1);
	});

	it("never leaks the credential in a faulted refusal", async () => {
		const r2 = resolver();
		if (r2 === undefined) return;
		const chaos = chaosTransport(real.transport, [
			{ at: 1, fault: "server-error" },
		]);
		await r2.reconcile(request(), chaos.transport).then(
			() => expect.unreachable("expected a refusal"),
			(error: Error) => {
				expect(String(error)).not.toContain(TOKEN);
			},
		);
	});

	it("is deterministic: the same plan fires the same faults", async () => {
		const r2 = resolver();
		if (r2 === undefined) return;
		const runs: string[] = [];
		for (let pass = 0; pass < 3; pass += 1) {
			const fresh = account();
			const chaos = chaosTransport(fresh.transport, [
				{ at: 1, fault: "network-error" },
			]);
			await r2.reconcile(request(), chaos.transport).catch(() => undefined);
			runs.push(chaos.calls.map((call) => call.method).join(","));
		}
		expect(new Set(runs).size).toBe(1);
	});
});
