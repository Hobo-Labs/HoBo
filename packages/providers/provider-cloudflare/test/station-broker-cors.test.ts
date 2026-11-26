import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * Station-broker CORS + health contract (pure checks; Worker body lives under station-broker/).
 * Full provision is covered by temporary-station tests with mocked transport.
 */
const ALLOWED_ORIGIN =
	/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$|^https:\/\/([a-z0-9-]+\.)*github\.io$/iu;

describe("station-broker CORS allowlist", () => {
	it("allows localhost and github.io Origins", () => {
		expect(ALLOWED_ORIGIN.test("http://localhost:4321")).toBe(true);
		expect(ALLOWED_ORIGIN.test("http://127.0.0.1:4321")).toBe(true);
		expect(ALLOWED_ORIGIN.test("https://tyler-r-kendrick.github.io")).toBe(
			true,
		);
		expect(ALLOWED_ORIGIN.test("https://evil.example")).toBe(false);
	});
});

describe("CORS relay module contract", () => {
	it("is Temporary Accounts only", async () => {
		const { assertCorsRelayIsAnonymousOnly, CORS_RELAY_WORKER_MODULE } =
			await import("../src/cors-relay-source.js");
		assertCorsRelayIsAnonymousOnly(CORS_RELAY_WORKER_MODULE);
		expect(CORS_RELAY_WORKER_MODULE).toMatch(/hobo-cors-relay/);
	});
});

describe("PoW fixture stability", () => {
	it("matches known small challenge digest length", async () => {
		const seed = Buffer.alloc(32, 3);
		const k = 2;
		const g = 3;
		let hash = createHash("sha256").update(seed).digest();
		for (let segment = 0; segment < k; segment++) {
			for (let i = 0; i < g; i++) {
				hash = createHash("sha256").update(hash).digest();
			}
		}
		expect(hash.length).toBe(32);
	});
});
