import { describe, expect, it } from "vitest";

import { surrogateEvidence } from "../src/evidence.js";
import { onlyBinding } from "./fixtures/bindings.js";

describe("surrogateEvidence", () => {
	it("names the grant by digests of the connection and the scope, not by anything that redeems", () => {
		const evidence = surrogateEvidence(onlyBinding());
		expect(evidence).toMatchObject({
			locator: "hobo-token://vercel/deploy",
			provider: "vercel",
		});
		expect(evidence.connectionDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		expect(evidence.scopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		expect(JSON.stringify(evidence)).not.toMatch(/osr_|ostest_|conn:\/\//u);
	});

	it("is stable, and the scope digest does not depend on the order paths or methods were written in", () => {
		const a = surrogateEvidence(
			onlyBinding({
				paths: ["/v9/projects", "/v1/global-config"],
				methods: ["GET", "PUT"],
			}),
		);
		const b = surrogateEvidence(
			onlyBinding({
				paths: ["/v1/global-config", "/v9/projects"],
				methods: ["PUT", "GET"],
			}),
		);
		expect(a.scopeDigest).toBe(b.scopeDigest);
		expect(a).toEqual(
			surrogateEvidence(
				onlyBinding({
					paths: ["/v9/projects", "/v1/global-config"],
					methods: ["GET", "PUT"],
				}),
			),
		);
	});

	it("changes when the scope widens or the connection changes", () => {
		const base = surrogateEvidence(onlyBinding());
		expect(
			surrogateEvidence(onlyBinding({ methods: ["GET", "POST", "DELETE"] }))
				.scopeDigest,
		).not.toBe(base.scopeDigest);
		expect(
			surrogateEvidence(onlyBinding({ paths: ["/v9/projects"] })).scopeDigest,
		).not.toBe(base.scopeDigest);
		expect(
			surrogateEvidence(onlyBinding({ connection: "conn://acme/web/vercel" }))
				.connectionDigest,
		).not.toBe(base.connectionDigest);
	});

	it("keeps paths and methods apart: swapping what they spell does not give the same digest", () => {
		const a = surrogateEvidence(
			onlyBinding({ paths: ["/get"], methods: ["POST"] }),
		);
		const b = surrogateEvidence(
			onlyBinding({ paths: ["/post"], methods: ["GET"] }),
		);
		expect(a.scopeDigest).not.toBe(b.scopeDigest);
	});
});
