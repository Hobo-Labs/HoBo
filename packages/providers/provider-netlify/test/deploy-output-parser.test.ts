import { describe, expect, it } from "vitest";
import { parseNetlifyAnonymousDeployOutput as parse } from "../src/temporary-station.js";

const base = {
	site_url: "https://owned.netlify.app",
	deploy_id: "deployment-owned",
	claim_url: "https://app.netlify.com/drop/owned#drop_token=fake",
};
describe("observed Netlify anonymous identity", () => {
	it("parses pretty JSON amid CLI progress chatter", () => {
		expect(
			parse(`Deploying...\n${JSON.stringify(base, null, 2)}\nDone.`),
		).toEqual({
			deployId: base.deploy_id,
			stationUrl: base.site_url,
			claimUrl: base.claim_url,
		});
	});
	it.each([
		"site_url",
		"url",
		"deploy_url",
		"deployUrl",
		"ssl_url",
	])("accepts the reported %s URL", (key) => {
		const { site_url, ...rest } = base;
		expect(parse(JSON.stringify({ ...rest, [key]: site_url })).stationUrl).toBe(
			site_url,
		);
	});
	it.each([
		"deploy_id",
		"deployId",
	])("accepts the reported %s identity", (key) => {
		const { deploy_id, ...rest } = base;
		expect(parse(JSON.stringify({ ...rest, [key]: deploy_id })).deployId).toBe(
			deploy_id,
		);
	});
	it.each([
		"site_id",
		"id",
	])("never substitutes %s for a deployment identity", (key) => {
		const { deploy_id, ...rest } = base;
		expect(() => parse(JSON.stringify({ ...rest, [key]: deploy_id }))).toThrow(
			/identity/,
		);
	});
	it("refuses a hostname-only success without native deployment and claim identity", () => {
		expect(() => parse("Website URL: https://owned.netlify.app\nDone")).toThrow(
			/claim/,
		);
		expect(() =>
			parse(
				"site https://owned.netlify.app claim https://app.netlify.com/drop/owned",
			),
		).toThrow(/identity/);
	});
	it("never invents ownership authority from a deployment hostname", () => {
		const { claim_url: _claimUrl, ...withoutClaim } = base;
		expect(() => parse(JSON.stringify(withoutClaim))).toThrow(/claim/);
	});
	it("continues to a valid JSON line after a malformed progress blob", () => {
		expect(
			parse(`{not json\n${JSON.stringify(base)}\n} trailer`).deployId,
		).toBe(base.deploy_id);
	});
	it("upgrades the reported historic HTTP hosting URL", () => {
		expect(
			parse(JSON.stringify({ ...base, site_url: "http://owned.netlify.app" }))
				.stationUrl,
		).toBe(base.site_url);
	});
	it("keeps the password in the fragment even when the claim URL has query parameters", () => {
		const r = parse(
			JSON.stringify({
				...base,
				claim_url: "https://app.netlify.com/drop/owned?token=fake",
				password: "a&b c",
			}),
		);
		expect(r.claimUrl).toBe(
			"https://app.netlify.com/drop/owned?token=fake#password=a%26b%20c",
		);
	});
	it("preserves an existing claim fragment and appends the password", () => {
		expect(
			parse(JSON.stringify({ ...base, password: "fake-password" })).claimUrl,
		).toBe(`${base.claim_url}&password=fake-password`);
	});
	it("does not replace an already reported password", () => {
		expect(
			parse(
				JSON.stringify({
					...base,
					claim_url: `${base.claim_url}&password=existing`,
					password: "replacement",
				}),
			).claimUrl,
		).toBe(`${base.claim_url}&password=existing`);
	});
	it.each([
		"https://evil.example/claim",
		"https://app.netlify.com.evil.example/claim",
		"https://user:pass@app.netlify.com/claim",
		"https://app.netlify.com:444/claim",
		"https://app.netlify.com/settings/drop",
	])("refuses foreign claim authority %s", (claim_url) => {
		expect(() => parse(JSON.stringify({ ...base, claim_url }))).toThrow(
			/claim URL/,
		);
	});
	it.each([
		"https://evil.example/netlify.app",
		"https://netlify.app.evil.example",
		"https://x.netlify.app:444",
		"https://user:pass@owned.netlify.app",
	])("refuses a foreign station authority %s", (site_url) => {
		expect(() => parse(JSON.stringify({ ...base, site_url }))).toThrow(
			/station URL/,
		);
	});
	it("refuses empty output and malformed JSON", () => {
		expect(() => parse("")).toThrow(/empty/);
		expect(() => parse("nothing parseable")).toThrow(/URL/);
	});
	it("returns the same observed identity for the same output", () => {
		expect(parse(JSON.stringify(base))).toEqual(parse(JSON.stringify(base)));
	});
});
