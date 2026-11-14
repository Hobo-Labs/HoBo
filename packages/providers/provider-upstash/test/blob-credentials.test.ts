import type { HttpTransport } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createUpstashBlobCredentials,
	upstashBlobFailureDomains,
} from "../src/blob-credentials.js";

const account = "0123456789abcdef0123456789abcdef";
const bucket = "12345678-1234-1234-1234-123456789abc";
const now = 1_800_000_000_000;

function fixture() {
	let clock = now;
	let token = "credential_token_1";
	let response = {
		endpoint: `https://${account}.r2.cloudflarestorage.com`,
		bucket,
		region: "auto",
		visibility: "private",
		accessKeyId: "access",
		secretAccessKey: "secret",
		sessionToken: "session",
		expiresAt: Math.floor((now + 600_000) / 1000),
	};
	let requests = 0;
	let reservations = 0;
	let deny = false;
	let rejectGuard = false;
	let status = 200;
	let intercept: (() => Promise<void>) | undefined;
	const transport: HttpTransport = async (request) => {
		requests++;
		expect(request.url).toBe("https://blob.upstash.io/v1/credentials");
		expect(request.headers.authorization).toBe(`Bearer ${token}`);
		await intercept?.();
		return {
			status,
			headers: status === 302 ? { location: "https://example.test/" } : {},
			body: JSON.stringify(response),
		};
	};
	const cache = createUpstashBlobCredentials({
		upstashAccountId: "upstash-account",
		bucketId: bucket,
		r2AccountId: account,
		resolveToken: async () => token,
		transport,
		now: () => clock,
		reserveMint: async () => {
			reservations++;
			if (deny) throw new Error("quota denied");
			return async () => {
				if (rejectGuard) throw new Error("sensitive-admission-detail");
			};
		},
	});
	return {
		cache,
		requests: () => requests,
		reservations: () => reservations,
		setToken(value: string) {
			token = value;
		},
		setClock(value: number) {
			clock = value;
		},
		setResponse(value: Partial<typeof response>) {
			response = { ...response, ...value };
		},
		setStatus(value: number) {
			status = value;
		},
		setIntercept(value: typeof intercept) {
			intercept = value;
		},
		deny() {
			deny = true;
		},
		rejectGuard() {
			rejectGuard = true;
		},
	};
}

describe("Upstash Blob scoped credentials", () => {
	it("shares a private bucket session, refreshes before expiry and charges each mint", async () => {
		const f = fixture();
		const [a, b] = await Promise.all([
			f.cache.resolveCredentials(),
			f.cache.resolveCredentials(),
		]);
		expect(a).toEqual({
			accessKeyId: "access",
			secretAccessKey: "secret",
			sessionToken: "session",
		});
		expect(b).toEqual(a);
		expect(Object.isFrozen(a)).toBe(true);
		expect(f.requests()).toBe(1);
		expect(f.reservations()).toBe(1);
		f.setClock(now + 575_000);
		f.setResponse({ expiresAt: Math.floor((now + 1_000_000) / 1000) });
		await f.cache.resolveCredentials();
		expect(f.requests()).toBe(2);
		expect(f.reservations()).toBe(2);
	});

	it.each([
		[{ visibility: "public" }, "public bucket"],
		[{ endpoint: "https://attacker.example" }, "foreign endpoint"],
		[
			{ endpoint: `https://${account}.r2.cloudflarestorage.com/extra` },
			"endpoint path",
		],
		[{ bucket: "foreign-bucket" }, "foreign bucket"],
		[{ region: "us-east-1" }, "unexpected region"],
		[
			{ expiresAt: Math.floor((now + 29_000) / 1000) },
			"nearly expired session",
		],
	])("refuses %s (%s)", async (change) => {
		const f = fixture();
		f.setResponse(change);
		await expect(f.cache.resolveCredentials()).rejects.toThrow();
	});

	it("does not call Upstash when the Broker denies the mint", async () => {
		const f = fixture();
		f.deny();
		await expect(f.cache.resolveCredentials()).rejects.toThrow(
			"budget-unavailable",
		);
		expect(f.requests()).toBe(0);
	});

	it("does not send if the reservation cannot be revalidated", async () => {
		const f = fixture();
		f.rejectGuard();
		await expect(f.cache.resolveCredentials()).rejects.toThrow(
			"budget-unavailable",
		);
		expect(f.requests()).toBe(0);
	});

	it("rejects redirects and never exposes a provider error containing the token", async () => {
		const redirected = fixture();
		redirected.setStatus(302);
		await expect(redirected.cache.resolveCredentials()).rejects.toThrow(
			"unavailable",
		);
		const leaked = fixture();
		leaked.setIntercept(async () => {
			throw new Error("credential_token_1");
		});
		await expect(leaked.cache.resolveCredentials()).rejects.toThrow(
			"unavailable",
		);
	});

	it("discards a late session from a rotated token", async () => {
		const f = fixture();
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let first = true;
		f.setIntercept(async () => {
			if (first) {
				first = false;
				entered?.();
				await gate;
			}
		});
		const old = f.cache.resolveCredentials();
		await waiting;
		f.setToken("credential_token_2");
		await f.cache.resolveCredentials();
		release?.();
		await expect(old).rejects.toThrow("credential-rotated");
		expect(f.requests()).toBe(2);
	});

	it("records Cloudflare as an underlying common failure domain", () => {
		expect(upstashBlobFailureDomains("account", account)).toContain(
			"cloudflare:r2",
		);
	});
});
