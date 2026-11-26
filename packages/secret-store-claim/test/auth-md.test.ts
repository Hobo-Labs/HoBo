import { Buffer } from "node:buffer";
import type { JsonValue } from "@bufbuild/protobuf";
import { parseScopes, parseSessionBinding } from "@hobo/auth-md";
import { createOneTimeActionStore } from "@hobo/claims";
import { describe, expect, it } from "vitest";
import {
	AUTH_MD_PROVIDER_ID,
	claimScopeFor,
	probeAuthMdStore,
	provisionAuthMdStore,
} from "../src/index.js";

// A made-up store that publishes auth.md; nothing here reaches a network.
const RESOURCE = "https://secrets.example.test";
const CLAIM_PAGE = `${RESOURCE}/claim/FAKE-CLAIM-CODE-0000`;
const NOW = new Date("2026-11-12T10:00:00.000Z");
const passthrough = {
	seal: (value: string) => Buffer.from(value).toString("base64"),
	open: (value: string) => Buffer.from(value, "base64").toString("utf8"),
};

function fakeStore(options: { readonly anonymous: boolean }) {
	const calls: string[] = [];
	const json = (status: number, body: JsonValue) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	const fetchImpl: typeof fetch = async (input, init) => {
		const url =
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.href
					: input;
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push(`${method} ${url}`);
		if (url === `${RESOURCE}/.well-known/oauth-protected-resource`)
			return json(200, {
				resource: `${RESOURCE}/`,
				authorization_servers: ["https://auth.example.test/"],
				scopes_supported: ["secrets:write"],
				bearer_methods_supported: ["header"],
				...(options.anonymous
					? { anonymous_registration_endpoint: `${RESOURCE}/agent/register` }
					: undefined),
			});
		if (url === `${RESOURCE}/auth.md`) return new Response("", { status: 404 });
		if (url === `${RESOURCE}/agent/register` && method === "POST")
			return json(200, {
				registration_ref: "reg-0001",
				granted_scopes: ["secrets:write"],
				private_key: "fixture-agent-key-not-a-real-credential",
				issued_at: NOW.toISOString(),
				claim_endpoint: `${RESOURCE}/agent/claim`,
			});
		if (url === `${RESOURCE}/agent/claim` && method === "POST")
			return json(200, {
				claim_url: CLAIM_PAGE,
				poll_token: "fixture-poll-token-not-a-real-credential",
				poll_endpoint: `${RESOURCE}/agent/claim/poll`,
				expires_at: "2026-11-13T10:00:00Z",
			});
		return json(404, { error: "not_found" });
	};
	return { port: { fetchImpl }, calls };
}

const binding = parseSessionBinding({
	sessionId: "ci-vercel",
	tenantId: "default",
	projectId: "ci-vercel",
	audience: `${RESOURCE}/`,
	service: `${RESOURCE}/`,
});

describe("any store that publishes auth.md", () => {
	it("is unavailable when its metadata advertises no anonymous registration", async () => {
		const { port } = fakeStore({ anonymous: false });
		const probe = await probeAuthMdStore({ port, resource: RESOURCE });
		expect(probe.evidence).toEqual({
			kind: "auth-md",
			available: false,
			detail: "auth.md metadata advertises no anonymous registration",
		});
	});

	it("is unavailable when nothing answers", async () => {
		const probe = await probeAuthMdStore({
			port: { fetchImpl: async () => new Response("", { status: 404 }) },
			resource: RESOURCE,
		});
		expect(probe.evidence.available).toBe(false);
		expect(probe.evidence.detail).toMatch(/^no usable auth\.md metadata/u);
	});

	it("registers anonymously and seals the human claim link", async () => {
		const { port } = fakeStore({ anonymous: true });
		const probe = await probeAuthMdStore({
			port,
			resource: RESOURCE,
			requiredScopes: parseScopes(["secrets:write"]),
		});
		expect(probe.evidence.available).toBe(true);
		if (!probe.discovery) throw new Error("no discovery");
		const store = createOneTimeActionStore(passthrough);
		const scope = claimScopeFor("ci-vercel", {});
		const { registration, bundle } = await provisionAuthMdStore({
			port,
			discovery: probe.discovery,
			binding,
			requestedScopes: parseScopes(["secrets:write"]),
			deploymentRef: "ci-vercel",
			store,
			scope,
			now: NOW,
		});
		expect(registration.registrationRef).toBe("reg-0001");
		const [item] = bundle.items;
		expect(item).toMatchObject({
			providerId: AUTH_MD_PROVIDER_ID,
			mode: "account-claim",
			deadline: Date.parse("2026-11-13T10:00:00Z"),
			verificationRef: "authmd-registration:reg-0001",
		});
		expect(JSON.stringify(bundle)).not.toContain("FAKE-CLAIM-CODE");
		const opened = await store.redeem({
			id: item?.oneTimeActionRef ?? "",
			...scope,
			audience: AUTH_MD_PROVIDER_ID,
			now: NOW.getTime() + 1000,
		});
		expect(opened.value).toBe(CLAIM_PAGE);
	});
});
