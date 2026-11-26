import { describe, expect, it } from "vitest";

import {
	AuthMdError,
	discoverAuthMd,
	parseProtectedResourceMetadata,
	protectedResourceMetadataUrl,
	requestBounded,
} from "../src/index.js";
import {
	AGREEING_AUTH_MD,
	AUTH_MD_URL,
	createFetchFixture,
	METADATA_URL,
	metadataBody,
	OVERCLAIMING_AUTH_MD,
	RESOURCE,
} from "./fixtures.js";

describe("discovery precedence", () => {
	it("takes scopes and registration support from metadata, never from prose", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: { json: metadataBody() },
			[`GET ${AUTH_MD_URL}`]: { text: OVERCLAIMING_AUTH_MD },
		});

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
		});

		expect(discovery.effectiveScopes).toEqual(["repo:read", "issues:write"]);
		expect(discovery.effectiveScopes).not.toContain("admin:all");
		expect(discovery.document?.declaredScopes).toContain("admin:all");
	});

	it("records the disagreement with metadata named as the authority", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: { json: metadataBody() },
			[`GET ${AUTH_MD_URL}`]: { text: OVERCLAIMING_AUTH_MD },
		});

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
		});

		expect(discovery.conflicts).toHaveLength(1);
		expect(discovery.conflicts[0]).toMatchObject({
			field: "scopesSupported",
			authority: "metadata",
		});
	});

	it("reports no conflict when prose agrees", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: { json: metadataBody() },
			[`GET ${AUTH_MD_URL}`]: { text: AGREEING_AUTH_MD },
		});

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
		});

		expect(discovery.conflicts).toEqual([]);
		expect(discovery.anonymousRegistrationSupported).toBe(true);
	});

	it("treats prose promising registration as advisory when metadata omits the endpoint", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: {
				json: metadataBody({ anonymous_registration_endpoint: undefined }),
			},
			[`GET ${AUTH_MD_URL}`]: { text: OVERCLAIMING_AUTH_MD },
		});

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
		});

		expect(discovery.anonymousRegistrationSupported).toBe(false);
		expect(discovery.conflicts.map((conflict) => conflict.field)).toContain(
			"anonymousRegistration",
		);
	});

	it("survives a missing companion document, because metadata is sufficient", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: { json: metadataBody() },
		});

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
		});

		expect(discovery.document).toBeUndefined();
		expect(discovery.effectiveScopes).toEqual(["repo:read", "issues:write"]);
	});
});

describe("metadata parsing", () => {
	it("rejects metadata with no authorization server", () => {
		expect(() =>
			parseProtectedResourceMetadata(
				metadataBody({ authorization_servers: [] }),
			),
		).toThrowError(
			expect.objectContaining({ code: "AUTHMD_METADATA_INVALID" }),
		);
	});

	it("rejects a non-https resource", () => {
		expect(() =>
			parseProtectedResourceMetadata(
				metadataBody({ resource: "http://api.example.test/" }),
			),
		).toThrowError(
			expect.objectContaining({ code: "AUTHMD_METADATA_INVALID" }),
		);
	});

	it("rejects a non-JSON metadata response", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: { text: "<html>nope</html>" },
		});

		await expect(
			discoverAuthMd({ port: fixture.port, resource: RESOURCE }),
		).rejects.toMatchObject({ code: "AUTHMD_METADATA_INVALID" });
	});

	it("derives the well-known metadata URL from any resource URL", () => {
		expect(protectedResourceMetadataUrl(`${RESOURCE}/v1/things`)).toBe(
			METADATA_URL,
		);
	});
});

describe("transport guards", () => {
	it("refuses plain HTTP", async () => {
		const fixture = createFetchFixture({});
		await expect(
			requestBounded(fixture.port, "http://api.example.test/x"),
		).rejects.toBeInstanceOf(AuthMdError);
	});

	it("refuses a redirect to another host", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: {
				status: 302,
				headers: { location: "https://evil.example.test/.well-known/x" },
			},
		});

		await expect(
			requestBounded(fixture.port, METADATA_URL),
		).rejects.toMatchObject({ code: "AUTHMD_DISCOVERY_FAILED" });
	});

	it("follows a same-host redirect", async () => {
		const fixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: {
				status: 307,
				headers: { location: `${RESOURCE}/metadata.json` },
			},
			[`GET ${RESOURCE}/metadata.json`]: { json: metadataBody() },
		});

		const response = await requestBounded(fixture.port, METADATA_URL);
		expect(response.url).toBe(`${RESOURCE}/metadata.json`);
	});

	it("enforces the response size bound", async () => {
		const fixture = createFetchFixture(
			{ [`GET ${AUTH_MD_URL}`]: { text: "x".repeat(4096) } },
			{ maxResponseBytes: 512 },
		);

		await expect(
			requestBounded(fixture.port, AUTH_MD_URL),
		).rejects.toMatchObject({ code: "AUTHMD_DISCOVERY_FAILED" });
	});

	it("surfaces a transport failure as AUTHMD_DISCOVERY_FAILED", async () => {
		const port = {
			fetchImpl: (async () => {
				throw new Error("connection reset");
			}) as unknown as typeof fetch,
		};

		await expect(requestBounded(port, METADATA_URL)).rejects.toMatchObject({
			code: "AUTHMD_DISCOVERY_FAILED",
		});
	});
});
