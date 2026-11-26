import { describe, expect, it } from "vitest";

import { describeDeployTarget } from "../src/deploy-preflight.js";

describe("describeDeployTarget", () => {
	it("selects Cloudflare (live) when token + account id are present", () => {
		const d = describeDeployTarget({
			CLOUDFLARE_API_TOKEN: "cf-tok",
			CLOUDFLARE_ACCOUNT_ID: "acct-1",
		});
		expect(d.backend).toBe("cloudflare");
		expect(d.live).toBe(true);
		expect(d.activate).toEqual([]);
	});

	it("takes Cloudflare over Vercel when both are set (precedence)", () => {
		const d = describeDeployTarget({
			CLOUDFLARE_API_TOKEN: "cf-tok",
			CLOUDFLARE_ACCOUNT_ID: "acct-1",
			VERCEL_TOKEN: "vc-tok",
		});
		expect(d.backend).toBe("cloudflare");
	});

	it("selects Vercel (live) when only VERCEL_TOKEN is present", () => {
		const d = describeDeployTarget({ VERCEL_TOKEN: "vc-tok" });
		expect(d.backend).toBe("vercel");
		expect(d.live).toBe(true);
	});

	it("falls back to in-memory and lists how to activate each real backend", () => {
		const d = describeDeployTarget({});
		expect(d.backend).toBe("in-memory");
		expect(d.live).toBe(false);
		expect(d.activate).toEqual([
			{ backend: "vercel", missing: ["VERCEL_TOKEN"] },
			{
				backend: "cloudflare",
				missing: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
			},
		]);
	});

	it("reports the exact missing Cloudflare var when only one of the pair is set", () => {
		const d = describeDeployTarget({ CLOUDFLARE_API_TOKEN: "cf-tok" });
		expect(d.backend).toBe("in-memory");
		const cf = d.activate.find((a) => a.backend === "cloudflare");
		expect(cf?.missing).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
	});

	it("treats empty-string env vars as absent", () => {
		const d = describeDeployTarget({ VERCEL_TOKEN: "" });
		expect(d.backend).toBe("in-memory");
	});
});

describe("resolver lane", () => {
	it.each([
		"0",
		"false",
		"true",
		"",
		" 1",
	])("does not opt into resolvers for %j", (value) => {
		const target = describeDeployTarget({
			VERCEL_TOKEN: "t",
			HOBO_DEPLOY_RESOLVERS: value,
		});
		expect(target.lane).toBe("resolver");
	});
	// The lane is reported separately from the cloud because the two converge
	// differently: a resolver re-run adopts an existing resource, where the
	// bespoke clients re-upload. An operator reading only "cloudflare" would
	// not know which behaviour they are about to get.
	it("reports the bespoke client when the opt-in is absent", () => {
		const target = describeDeployTarget({
			CLOUDFLARE_API_TOKEN: "t",
			CLOUDFLARE_ACCOUNT_ID: "a",
		});
		expect(target.backend).toBe("cloudflare");
		expect(target.lane).toBe("resolver");
		expect(target.summary).toContain("authoritative hosting budget");
	});

	it("reports the resolver plane when opted in", () => {
		const target = describeDeployTarget({
			CLOUDFLARE_API_TOKEN: "t",
			CLOUDFLARE_ACCOUNT_ID: "a",
			HOBO_DEPLOY_RESOLVERS: "1",
		});
		expect(target.lane).toBe("resolver");
		expect(target.summary).toContain("native liability evidence");
	});

	it("switches Vercel onto the resolver plane too", () => {
		expect(
			describeDeployTarget({ VERCEL_TOKEN: "t", HOBO_DEPLOY_RESOLVERS: "1" })
				.lane,
		).toBe("resolver");
	});

	it("never engages the resolver lane without a credential", () => {
		// The opt-in alone must not turn the credential-free default into a
		// live deploy — it can only change WHICH driver a credentialed deploy
		// uses, never whether one happens.
		const target = describeDeployTarget({ HOBO_DEPLOY_RESOLVERS: "1" });
		expect(target.backend).toBe("in-memory");
		expect(target.lane).toBe("in-memory");
		expect(target.live).toBe(false);
	});
});
