import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	INFISICAL_CLOUD_SITE_URL,
	infisicalBindingFromEnv,
	infisicalSecretRef,
	ownerAuthFromEnv,
	parseInfisicalBinding,
	parseInfisicalSecretRef,
} from "../src/index.js";

const fixtures = join(import.meta.dirname, "..", "data-models", "fixtures");

function corpus(kind: "valid" | "invalid") {
	return readdirSync(join(fixtures, kind)).map((name) => ({
		name,
		value: JSON.parse(readFileSync(join(fixtures, kind, name), "utf8")),
	}));
}

describe("parseInfisicalBinding", () => {
	it.each(corpus("valid"))("accepts the CUE-valid fixture $name", ({
		value,
	}) => {
		expect(() => parseInfisicalBinding(value)).not.toThrow();
	});

	it.each(corpus("invalid"))("refuses the CUE-invalid fixture $name", ({
		value,
	}) => {
		expect(() => parseInfisicalBinding(value)).toThrow(/invalid-input/u);
	});

	it("defaults to Infisical Cloud and the root folder", () => {
		expect(
			parseInfisicalBinding({ projectId: "p", environment: "prod" }),
		).toEqual({
			siteUrl: INFISICAL_CLOUD_SITE_URL,
			projectId: "p",
			environment: "prod",
			secretPath: "/",
		});
	});

	it("reads the deployment's plain configuration from the environment", () => {
		expect(
			infisicalBindingFromEnv({
				INFISICAL_SITE_URL: "https://eu.infisical.com/",
				INFISICAL_PROJECT_ID: "p",
				INFISICAL_ENVIRONMENT: "prod",
				INFISICAL_SECRET_PATH: "/hobo-ci-relay/",
			}),
		).toEqual({
			siteUrl: "https://eu.infisical.com",
			projectId: "p",
			environment: "prod",
			secretPath: "/hobo-ci-relay",
		});
		expect(() => infisicalBindingFromEnv({})).toThrow(/projectId/u);
	});

	it("refuses userinfo, a path or a query on the site URL", () => {
		for (const siteUrl of [
			"https://user:pw@app.infisical.com",
			"https://app.infisical.com/api",
			"https://app.infisical.com?x=1",
			"ftp://app.infisical.com",
		])
			expect(() =>
				parseInfisicalBinding({ siteUrl, projectId: "p", environment: "e" }),
			).toThrow();
	});
});

describe("the infisical SecretRef scheme", () => {
	it("round-trips a binding and key", () => {
		const binding = parseInfisicalBinding({
			projectId: "proj",
			environment: "prod",
			secretPath: "/hobo-ci-relay/app",
		});
		const ref = infisicalSecretRef(binding, "HOBO_CI_GITHUB_APP_PRIVATE_KEY");
		expect(ref).toBe(
			"infisical://proj/prod/hobo-ci-relay/app/HOBO_CI_GITHUB_APP_PRIVATE_KEY",
		);
		expect(parseInfisicalSecretRef(ref)).toEqual({
			binding,
			secretKey: "HOBO_CI_GITHUB_APP_PRIVATE_KEY",
		});
	});

	it("maps the root folder to no folder segment", () => {
		const binding = parseInfisicalBinding({ projectId: "p", environment: "e" });
		expect(infisicalSecretRef(binding, "K")).toBe("infisical://p/e/K");
		expect(parseInfisicalSecretRef("infisical://p/e/K").binding).toEqual(
			binding,
		);
	});

	it("refuses other schemes and field selectors", () => {
		expect(() => parseInfisicalSecretRef("vault://a/b/c")).toThrow();
		expect(() => parseInfisicalSecretRef("infisical://p/e/K#field")).toThrow();
	});
});

describe("ownerAuthFromEnv", () => {
	it("prefers an issued access token, then Universal Auth", () => {
		expect(
			ownerAuthFromEnv({
				INFISICAL_TOKEN: "tok",
				INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "id",
			}),
		).toEqual({ method: "access-token", accessToken: "tok" });
		expect(
			ownerAuthFromEnv({
				INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "id",
				INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "secret",
			}),
		).toEqual({
			method: "universal-auth",
			clientId: "id",
			clientSecret: "secret",
		});
		expect(ownerAuthFromEnv({})).toBeUndefined();
		expect(() =>
			ownerAuthFromEnv({ INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "id" }),
		).toThrow(/invalid-input/u);
	});
});
