import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	discoverAuthMd,
	parseScopes,
	parseSessionBinding,
	registerAnonymousAgent,
} from "../../src/index.js";
import { createFetchFixture } from "../../test/fixtures.js";

interface PactInteraction {
	readonly description: string;
	readonly providerStates: readonly { readonly name: string }[];
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly body?: Record<string, unknown>;
	};
	readonly response: {
		readonly status: number;
		readonly body: Record<string, unknown>;
	};
}

const contractsRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(contractsRoot, "../pacts/auth-md-protected-resource.pact.json"),
		"utf8",
	),
) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: readonly PactInteraction[];
};

const RESOURCE = "https://api.example.test";
const interactionAt = (index: number): PactInteraction => {
	const interaction = pact.interactions[index];
	if (interaction === undefined) throw new Error(`no interaction ${index}`);
	return interaction;
};

const portFor = (
	metadata: Record<string, unknown>,
	registration?: Record<string, unknown>,
) =>
	createFetchFixture({
		[`GET ${RESOURCE}/.well-known/oauth-protected-resource`]: {
			json: metadata,
		},
		...(registration === undefined
			? {}
			: { [`POST ${RESOURCE}/agent/register`]: { json: registration } }),
	});

const binding = parseSessionBinding({
	sessionId: "session-1",
	tenantId: "tenant-acme",
	projectId: "project-bo",
	audience: "https://api.example.test/",
	service: "https://api.example.test/",
});

describe("AuthMdProtectedResource boundary (consumer contract)", () => {
	it("names the auth-md consumer and the protected-resource provider", () => {
		expect(pact.consumer.name).toBe("@hobo/auth-md");
		expect(pact.provider.name).toBe("AuthMdProtectedResource");
	});

	it("parses the recorded metadata interaction into authoritative discovery", async () => {
		const metadata = interactionAt(0).response.body;
		const fixture = portFor(metadata);

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
			includeDocument: false,
		});

		expect(discovery.effectiveScopes).toEqual(
			metadata.scopes_supported as readonly string[],
		);
		expect(discovery.anonymousRegistrationSupported).toBe(true);
	});

	it("sends exactly the recorded registration request and parses the recorded response", async () => {
		const interaction = interactionAt(1);
		const fixture = portFor(
			interactionAt(0).response.body,
			interaction.response.body,
		);

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
			includeDocument: false,
		});
		const registration = await registerAnonymousAgent({
			port: fixture.port,
			discovery,
			binding,
			requestedScopes: parseScopes(["repo:read"]),
		});

		const sent = fixture.calls.find((call) =>
			call.key.startsWith("POST "),
		)?.body;
		expect(sent).toEqual(interaction.request.body);
		expect(registration.registrationRef).toBe(
			interaction.response.body.registration_ref,
		);
		expect(registration.preClaimScopes).toEqual(
			interaction.response.body.granted_scopes,
		);
	});

	it("honours the recorded refusal state: no advertised endpoint, no registration", async () => {
		const fixture = portFor(interactionAt(2).response.body);

		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: RESOURCE,
			includeDocument: false,
		});

		expect(discovery.anonymousRegistrationSupported).toBe(false);
		await expect(
			registerAnonymousAgent({
				port: fixture.port,
				discovery,
				binding,
				requestedScopes: parseScopes(["repo:read"]),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_REGISTRATION_UNSUPPORTED" });
	});

	it("keeps the contract itself free of real credential material", () => {
		const serialized = JSON.stringify(pact);
		expect(serialized).not.toMatch(/-----BEGIN[^-]*PRIVATE KEY-----/u);
		expect(serialized).toContain("fixture-agent-key-not-a-real-credential");
	});
});
