/**
 * Neon provider errors — redaction, and mapping HTTP status onto a HoBo code.
 *
 * An error message is the one string that reliably reaches a log, a receipt,
 * and a support ticket. Upstream error bodies have carried connection strings
 * before, so **provider text is never interpolated verbatim** — it goes
 * through `redactProviderText` on the way into every message and every detail
 * field.
 *
 * Two things that redaction has to do beyond replacing secrets:
 *
 * **Flatten control characters.** A raw CR/LF in provider text is log forging:
 * it lets an upstream body write what looks like a second log record. Turning
 * them into spaces costs nothing and closes that.
 *
 * **Bound the length.** An error message is copied into several places, and an
 * unbounded upstream body is a way to push arbitrary content into all of them.
 *
 * The status mapping carries one judgement worth pinning: **a 5xx on a create
 * is ambiguous, not retryable.** "Failed" and "created but not acknowledged"
 * are indistinguishable from the client, and retrying would provision a second
 * database. The same 5xx on a read *is* retryable, because reading twice costs
 * nothing.
 */
import { describe, expect, it } from "vitest";

import {
	isProviderError,
	NeonProviderError,
	PROVIDER_ERROR_CODES,
	providerErrorForStatus,
	redactProviderText,
} from "../src/errors.js";

describe("redactProviderText", () => {
	it("leaves ordinary text alone", () => {
		expect(redactProviderText("database not found")).toBe("database not found");
	});

	it("redacts a Postgres URI", () => {
		// The URI is the credential, and it has genuinely appeared in upstream
		// error bodies before.
		const out = redactProviderText("failed: postgres://a:pw@db/main is bad");
		expect(out).toContain("[redacted]");
		expect(out).not.toContain("pw@db");
	});

	it("redacts every credential shape it knows", () => {
		for (const [text, secret] of [
			["Bearer abc123xyz", "abc123xyz"],
			["password=hunter2", "hunter2"],
			["PGPASSWORD: hunter2", "hunter2"],
			["role npg_AbCd1234 failed", "npg_AbCd1234"],
			["key sk-livevalue123", "sk-livevalue123"],
			["key pk_testvalue123", "pk_testvalue123"],
			[
				"-----BEGIN PRIVATE KEY-----\nMIIEsecret\n-----END PRIVATE KEY-----",
				"MIIEsecret",
			],
		] as const) {
			const out = redactProviderText(text);
			expect(out, text).toContain("[redacted]");
			expect(out, text).not.toContain(secret);
		}
	});

	it("redacts every occurrence, not just the first", () => {
		// The patterns are global on purpose: an upstream body that repeats a
		// connection string would otherwise leak the second copy.
		const out = redactProviderText(
			"postgres://a:1@x/y then postgres://b:2@z/w",
		);
		expect(out.match(/\[redacted\]/gu)).toHaveLength(2);
		expect(out).not.toContain("@z");
	});

	it("flattens control characters so provider text cannot forge a log record", () => {
		// A raw CR/LF lets an upstream body write what reads as a second log
		// line — with whatever severity and message it chooses.
		const out = redactProviderText("real error\n2026-01-01 FATAL forged");
		expect(out).not.toContain("\n");
		expect(out).not.toContain("\r");
		expect(out).toContain("real error");
	});

	it("trims after flattening", () => {
		expect(redactProviderText("\n  spaced  \t")).toBe("spaced");
	});

	it("truncates at the default bound with an ellipsis", () => {
		// An unbounded upstream body would be copied into a log, a receipt, and
		// a ticket at full length.
		const out = redactProviderText("x".repeat(500));
		expect(out).toHaveLength(257);
		expect(out.endsWith("…")).toBe(true);
	});

	it("takes a caller-supplied bound", () => {
		expect(redactProviderText("x".repeat(500), 10)).toBe(`${"x".repeat(10)}…`);
	});

	it("does not truncate text at exactly the bound", () => {
		// Off-by-one here would append an ellipsis to a message that was never
		// shortened, implying content that is not missing.
		const out = redactProviderText("x".repeat(256));
		expect(out).toHaveLength(256);
		expect(out).not.toContain("…");
	});
});

describe("NeonProviderError", () => {
	it("redacts the message at construction", () => {
		// Every caller gets this for free — a call site that forgot would
		// otherwise leak, and there are many call sites.
		const error = new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"bad: postgres://a:pw@db/main",
		);
		expect(error.message).toContain("[redacted]");
		expect(error.message).not.toContain("pw@db");
	});

	it("defaults to not retryable", () => {
		// Retrying a provisioning call that may have succeeded costs a second
		// database. The safe default is to make the caller opt in.
		expect(
			new NeonProviderError("PROVIDER_CONTRACT_CHANGED", "x").retryable,
		).toBe(false);
	});

	it("carries an explicit retryable flag and retry delay", () => {
		const error = new NeonProviderError("PROVIDER_RATE_LIMITED", "x", {
			retryable: true,
			retryAfterMs: 5_000,
		});
		expect(error.retryable).toBe(true);
		expect(error.retryAfterMs).toBe(5_000);
	});

	it("omits the retry delay entirely when none was given", () => {
		// `retryAfterMs: undefined` in a serialized error is a field a scheduler
		// has to reason about; an absent one is not.
		const error = new NeonProviderError("PROVIDER_RATE_LIMITED", "x");
		expect(error.retryAfterMs).toBeUndefined();
		expect("retryAfterMs" in error.toJSON()).toBe(false);
	});

	it("freezes an empty detail map by default", () => {
		// Callers read `detail` unconditionally. `undefined` would throw in the
		// error path, which is the worst place for a second failure.
		const error = new NeonProviderError("MIGRATION_FAILED", "x");
		expect(error.detail).toEqual({});
		expect(Object.isFrozen(error.detail)).toBe(true);
	});

	it("copies the caller's detail rather than aliasing it", () => {
		// The caller's object is often a request context reused across retries.
		const detail = { status: 500 };
		const error = new NeonProviderError("MIGRATION_FAILED", "x", { detail });
		(detail as Record<string, unknown>).status = 200;
		expect(error.detail.status).toBe(500);
	});

	it("keeps a cause when one is given, and sets none otherwise", () => {
		// The cause chain is what a debugger walks. Setting `cause: undefined`
		// explicitly would make the property present and empty.
		const cause = new Error("socket");
		expect(
			new NeonProviderError("MIGRATION_FAILED", "x", { cause }).cause,
		).toBe(cause);
		expect("cause" in new NeonProviderError("MIGRATION_FAILED", "x")).toBe(
			false,
		);
	});

	it("projects to a receipt-safe JSON shape", () => {
		// The message is already redacted by construction, which is why the
		// projection can include it at all.
		const json = new NeonProviderError(
			"PROVIDER_RATE_LIMITED",
			"slow: Bearer abc123xyz",
			{ retryable: true, retryAfterMs: 100, detail: { status: 429 } },
		).toJSON();
		expect(json).toEqual({
			name: "NeonProviderError",
			code: "PROVIDER_RATE_LIMITED",
			message: "slow: [redacted]",
			retryable: true,
			retryAfterMs: 100,
			detail: { status: 429 },
		});
	});

	it("is recognisable through the type guard", () => {
		// Callers branch on this to decide whether a failure is the provider's
		// or a bug; a plain Error must not be mistaken for one.
		expect(isProviderError(new NeonProviderError("LEASE_EXPIRED", "x"))).toBe(
			true,
		);
		for (const value of [new Error("x"), null, undefined, {}, "err"]) {
			expect(isProviderError(value)).toBe(false);
		}
	});

	it("declares each code exactly once", () => {
		// A duplicated code would make two different failures indistinguishable
		// to a caller branching on it.
		expect(new Set(PROVIDER_ERROR_CODES).size).toBe(
			PROVIDER_ERROR_CODES.length,
		);
	});
});

describe("providerErrorForStatus", () => {
	it("maps 429 to a retryable rate limit, carrying the delay", () => {
		const error = providerErrorForStatus(429, {
			method: "GET",
			retryAfterMs: 2_000,
		});
		expect(error.code).toBe("PROVIDER_RATE_LIMITED");
		expect(error.retryable).toBe(true);
		expect(error.retryAfterMs).toBe(2_000);
	});

	it("omits the delay when the provider sent none", () => {
		// A scheduler distinguishes "wait this long" from "back off however you
		// normally do"; a fabricated delay would override its own policy.
		expect(
			providerErrorForStatus(429, { method: "GET" }).retryAfterMs,
		).toBeUndefined();
	});

	it("maps both auth statuses to one non-retryable code", () => {
		// Retrying an auth failure with the same credential produces the same
		// failure, and quickly enough to look like an attack.
		for (const status of [401, 403]) {
			const error = providerErrorForStatus(status, { method: "GET" });
			expect(error.code, String(status)).toBe("PROVIDER_AUTH_FAILED");
			expect(error.retryable).toBe(false);
			expect(error.message).toContain(String(status));
		}
	});

	it("maps 409 to a provisioning conflict", () => {
		expect(providerErrorForStatus(409, { method: "POST" }).code).toBe(
			"PROVISIONING_CONFLICT",
		);
	});

	it("treats a 5xx on a create as ambiguous rather than retryable", () => {
		// "Failed" and "created but not acknowledged" are indistinguishable from
		// here. Retrying would provision a second database and bill for it.
		const error = providerErrorForStatus(503, { method: "POST" });
		expect(error.code).toBe("PROVIDER_OPERATION_AMBIGUOUS");
		expect(error.retryable).toBe(false);
		expect(error.message).toContain("may or may not exist");
	});

	it("treats a 5xx on a read as retryable", () => {
		// Reading twice costs nothing, so the same status means something
		// different depending on what was attempted.
		const error = providerErrorForStatus(503, { method: "GET" });
		expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
		expect(error.retryable).toBe(true);
	});

	it("maps an unexpected status to a contract change, saying so", () => {
		// A 418 or a 302 from this API means it is not the API HoBo was built
		// against, which is a different problem from a failure it anticipated.
		const error = providerErrorForStatus(418, { method: "GET" });
		expect(error.code).toBe("PROVIDER_CONTRACT_CHANGED");
		expect(error.message).toContain("unexpected 418");
		expect(error.retryable).toBe(false);
	});

	it("records the status and method in the detail", () => {
		// The method is what makes a 5xx ambiguous or retryable, so a reader of
		// the detail needs it to understand the code they were given.
		expect(
			providerErrorForStatus(500, { method: "POST" }).detail,
		).toMatchObject({ status: 500, method: "POST" });
	});

	it("redacts and bounds the body before putting it in the detail", () => {
		// The body is upstream text landing in a structured field that gets
		// serialized into receipts.
		const error = providerErrorForStatus(500, {
			method: "GET",
			body: `conn postgres://a:pw@db/main ${"x".repeat(300)}`,
		});
		const body = String(error.detail.body);
		expect(body).toContain("[redacted]");
		expect(body).not.toContain("pw@db");
		expect(body.length).toBeLessThanOrEqual(181);
	});

	it("omits the body key when the provider sent none, or sent nothing", () => {
		// An empty `body: ""` in a receipt reads as "the provider replied with
		// an empty body", which is a different fact from "there was no body".
		expect(
			"body" in providerErrorForStatus(500, { method: "GET" }).detail,
		).toBe(false);
		expect(
			"body" in providerErrorForStatus(500, { method: "GET", body: "" }).detail,
		).toBe(false);
		expect(
			"body" in
				providerErrorForStatus(500, { method: "GET", body: "   \n " }).detail,
		).toBe(false);
	});
});
