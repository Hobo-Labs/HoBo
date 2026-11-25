import { describe, expect, it } from "vitest";
import {
	AUTH_FLOW_PREFERENCE,
	authMdTargets,
	resolveAuthFlows,
	toAuthDocument,
} from "../src/index.js";
import { example, mustParse } from "./support/example.js";

function manifestWithFlows(flows: string): ReturnType<typeof mustParse> {
	return mustParse(`
schema: hobo.provider-manifest/v1
provider: { id: p, displayName: P }
auth:
  issuer: https://auth.example.com
  flows:
${flows}
`);
}

describe("resolveAuthFlows", () => {
	it("orders flows keyless-first regardless of declaration order", () => {
		expect(resolveAuthFlows(example()).map((f) => [f.id, f.type])).toEqual([
			["workload-federation", "oidc-federation"],
			["agent-registration", "auth-md"],
			["console-oauth", "oauth2-authorization-code"],
			["device", "device-code"],
			["legacy-key", "api-key"],
		]);
	});

	it("names every OAuth grant with the Capability Manifest flow types", () => {
		const grants = [
			"token-exchange",
			"jwt-bearer",
			"client-credentials",
		] as const;
		const manifest = manifestWithFlows(
			grants
				.map(
					(grant) => `    - id: ${grant}
      oauth2: { grant: ${grant}, tokenEndpoint: https://auth.example.com/token }`,
				)
				.join("\n"),
		);
		expect(resolveAuthFlows(manifest).map((f) => f.type)).toEqual([
			"oauth2-xaa",
			"oauth2-obo",
			"oauth2-client-credentials",
		]);
	});

	it("carries scopes and marks static-secret flows", () => {
		const flows = resolveAuthFlows(example());
		expect(flows.find((f) => f.id === "console-oauth")?.scopes).toEqual([
			"compute:deploy",
			"inference:invoke",
		]);
		expect(flows.filter((f) => f.staticSecret).map((f) => f.id)).toEqual([
			"legacy-key",
		]);
	});

	it("sorts an extension flow last and marks it unsupported", () => {
		const manifest = manifestWithFlows(`    - id: custom
      extension: { type: x-saml-bearer, params: { idp: okta } }
    - id: key
      apiKey: { header: Authorization, prefix: Bearer }`);
		const flows = resolveAuthFlows(manifest);
		expect(flows.map((f) => f.id)).toEqual(["key", "custom"]);
		expect(flows[1]?.supported).toBe(false);
		expect(AUTH_FLOW_PREFERENCE).not.toContain("x-saml-bearer");
	});
});

describe("auth.md flows", () => {
	it("derive discovery URLs from the protected resource", () => {
		const flow = example().auth?.flows[2]?.flow;
		if (flow?.case !== "authMd") throw new Error("expected authMd");
		expect(authMdTargets(flow.value)).toEqual({
			resource: "https://api.acme-cloud.example.com",
			protectedResourceMetadataUrl:
				"https://api.acme-cloud.example.com/.well-known/oauth-protected-resource",
			authMdUrl: "https://api.acme-cloud.example.com/auth.md",
		});
	});

	it("honor an explicit document URL", () => {
		const manifest = manifestWithFlows(`    - id: agents
      authMd:
        resource: https://api.example.com
        documentUrl: https://docs.example.com/agents/auth.md`);
		const flow = manifest.auth?.flows[0]?.flow;
		if (flow?.case !== "authMd") throw new Error("expected authMd");
		expect(authMdTargets(flow.value).authMdUrl).toBe(
			"https://docs.example.com/agents/auth.md",
		);
	});
});

describe("toAuthDocument", () => {
	it("is keyless when any brokerable keyless flow exists", () => {
		expect(toAuthDocument(example()).staticSecrets).toBe(false);
	});

	it("declares static secrets when every usable flow needs one", () => {
		const manifest = manifestWithFlows(`    - id: key
      apiKey: { header: X-Api-Key }
    - id: custom
      extension: { type: x-magic }`);
		const document = toAuthDocument(manifest);
		expect(document.staticSecrets).toBe(true);
		expect(document.flows).toEqual([
			{
				id: "key",
				type: "api-key",
				scopes: [],
				supported: true,
				header: "X-Api-Key",
				rotation: "manual",
			},
			{
				id: "custom",
				type: "x-magic",
				scopes: [],
				supported: false,
				params: {},
			},
		]);
	});

	it("always publishes PKCE S256 for authorization-code", () => {
		const flows = toAuthDocument(example()).flows;
		expect(flows).toContainEqual(
			expect.objectContaining({ id: "console-oauth", pkce: "S256" }),
		);
	});
});
