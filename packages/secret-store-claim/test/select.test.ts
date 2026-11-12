import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SECRET_STORE_OFFERS,
	parseSecretStoreEvidence,
	parseSecretStoreOffer,
	readSecretStoreBinding,
	SECRET_STORE_KINDS,
	SecretStoreEvidenceSchema,
	SecretStoreOfferSchema,
	selectSecretStore,
} from "../src/index.js";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const evidence = (kind: string, available: boolean, detail = "") =>
	parseSecretStoreEvidence(
		create(SecretStoreEvidenceSchema, { kind, available, detail }),
	);

describe("the default offers", () => {
	it("prefer agent auth with a claim, then HoBo-hosted, then attach-only", () => {
		expect(DEFAULT_SECRET_STORE_OFFERS.map((offer) => offer.kind)).toEqual([
			"auth-md",
			"cloudflare-temporary",
			"infisical-self-hosted",
			"infisical-cloud-attach",
		]);
		expect(SECRET_STORE_KINDS).toHaveLength(4);
		for (const offer of DEFAULT_SECRET_STORE_OFFERS) {
			expect(offer.sourceUrl).toMatch(/^https:\/\//u);
			expect(offer.checkedAt).toBe("2026-11-12");
		}
	});

	it("record Cloudflare's 60-minute claim window", () => {
		const cloudflare = DEFAULT_SECRET_STORE_OFFERS.find(
			(offer) => offer.kind === "cloudflare-temporary",
		);
		expect(cloudflare?.claimWindowMinutes).toBe(60);
		expect(cloudflare?.claimMechanism).toBe("provider-claim-url");
	});

	it("refuse a provider claim URL without a deadline", () => {
		expect(() =>
			parseSecretStoreOffer(
				create(SecretStoreOfferSchema, {
					kind: "cloudflare-temporary",
					preference: 2,
					claimMechanism: "provider-claim-url",
					claimWindowMinutes: 0,
					runtimeBinding: "designed",
					cost: "x",
					availability: "y",
					sourceUrl: "https://example.com/",
					checkedAt: "2026-11-12",
				}),
			),
		).toThrow(/constraints/u);
	});
});

describe("routing secrets.config-service/v1 at deploy time", () => {
	it("passes over stores the relay cannot read yet, saying why", () => {
		const route = selectSecretStore({
			offers: DEFAULT_SECRET_STORE_OFFERS,
			evidence: [
				evidence(
					"auth-md",
					false,
					"auth.md metadata advertises no anonymous registration",
				),
				evidence("cloudflare-temporary", true),
				evidence("infisical-self-hosted", true),
				evidence("infisical-cloud-attach", true),
			],
			now: NOW,
		});
		expect(route.selection.selectedKind).toBe("infisical-self-hosted");
		expect(route.selection.capability).toBe("secrets.config-service/v1");
		expect(
			route.selection.skipped.map((skip) => [skip.kind, skip.reason]),
		).toEqual([
			["auth-md", "auth.md metadata advertises no anonymous registration"],
			[
				"cloudflare-temporary",
				"the relay cannot read this store yet (runtime binding designed, not built)",
			],
		]);
		expect(route.selection.decidedAt).toBe(NOW.toISOString());
	});

	it("takes the preferred claimable store when designs are allowed", () => {
		const route = selectSecretStore({
			offers: DEFAULT_SECRET_STORE_OFFERS,
			evidence: [
				evidence("auth-md", false, "no usable auth.md metadata"),
				evidence("cloudflare-temporary", true),
			],
			allowDesigned: true,
			now: NOW,
		});
		expect(route.selection.selectedKind).toBe("cloudflare-temporary");
	});

	it("falls to attach-only when no fleet host is free", () => {
		const route = selectSecretStore({
			offers: DEFAULT_SECRET_STORE_OFFERS,
			evidence: [
				evidence("infisical-self-hosted", false, "no fresh compute fleet host"),
				evidence("infisical-cloud-attach", true),
			],
			now: NOW,
		});
		expect(route.selection.selectedKind).toBe("infisical-cloud-attach");
		expect(route.selection.skipped.map((skip) => skip.reason)).toContain(
			"not probed by this deploy",
		);
	});

	it("refuses with every reason when nothing is available", () => {
		expect(() =>
			selectSecretStore({
				offers: DEFAULT_SECRET_STORE_OFFERS,
				evidence: [],
				now: NOW,
			}),
		).toThrow(/no offer can provide secrets\.config-service\/v1/u);
	});

	it("refuses evidence that hides why an offer is unavailable", () => {
		expect(() => evidence("auth-md", false)).toThrow(/why/u);
		expect(() => evidence("vercel-env", true)).toThrow(/kind/u);
	});
});

describe("the committed binding", () => {
	const fixtures = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"data-models",
		"fixtures",
	);
	it.each(
		readdirSync(path.join(fixtures, "valid")),
	)("reads valid %s", (name) => {
		const text = readFileSync(path.join(fixtures, "valid", name), "utf8");
		expect(readSecretStoreBinding(text).endpoint).toMatch(/^https:\/\//u);
	});
	it.each(
		readdirSync(path.join(fixtures, "invalid")),
	)("refuses invalid %s", (name) => {
		const text = readFileSync(path.join(fixtures, "invalid", name), "utf8");
		expect(() => readSecretStoreBinding(text)).toThrow(/constraints|kind/u);
	});
});
