import { describe, expect, it } from "vitest";

import type { RotationPort } from "../src/index.js";
import {
	discoverAuthMd,
	isMaterialLocator,
	registerAnonymousAgent,
	reRegisterAfterRevocation,
	revokeAgentPrincipal,
} from "../src/index.js";
import {
	AUTH_MD_URL,
	binding,
	createFetchFixture,
	FAKE_KEY_MATERIAL,
	METADATA_URL,
	metadataBody,
	OVERCLAIMING_AUTH_MD,
	REGISTRATION_URL,
	RESOURCE,
	scopes,
} from "./fixtures.js";

const registrationBody = (overrides: Record<string, unknown> = {}) => ({
	registration_ref: "reg_01H8XABCDEF",
	granted_scopes: ["repo:read"],
	private_key: FAKE_KEY_MATERIAL,
	issued_at: "2026-08-08T12:00:00.000Z",
	expires_at: "2026-08-08T13:00:00.000Z",
	claim_endpoint: `${RESOURCE}/agent/claim`,
	...overrides,
});

async function discover(
	routes: Record<string, unknown> = {},
	metadataOverrides: Record<string, unknown> = {},
) {
	const fixture = createFetchFixture({
		[`GET ${METADATA_URL}`]: { json: metadataBody(metadataOverrides) },
		[`GET ${AUTH_MD_URL}`]: { text: OVERCLAIMING_AUTH_MD },
		...(routes as Record<string, never>),
	});
	const discovery = await discoverAuthMd({
		port: fixture.port,
		resource: RESOURCE,
	});
	return { fixture, discovery };
}

describe("anonymous agent registration", () => {
	it("returns a pre-claim registration with an opaque key locator", async () => {
		const { fixture, discovery } = await discover({
			[`POST ${REGISTRATION_URL}`]: { json: registrationBody() },
		});

		const registration = await registerAnonymousAgent({
			port: fixture.port,
			discovery,
			binding: binding(),
			requestedScopes: scopes("repo:read"),
		});

		expect(registration.phase).toBe("pre-claim");
		expect(registration.registrationRef).toBe("reg_01H8XABCDEF");
		expect(registration.preClaimScopes).toEqual(["repo:read"]);
		expect(isMaterialLocator(registration.keyMaterial.locator)).toBe(true);
		expect(registration.keyMaterial.locator).not.toContain(FAKE_KEY_MATERIAL);
		expect(registration.claimEndpoint).toBe(`${RESOURCE}/agent/claim`);
	});

	it("sends the four-part binding with the registration request", async () => {
		const { fixture, discovery } = await discover({
			[`POST ${REGISTRATION_URL}`]: { json: registrationBody() },
		});

		await registerAnonymousAgent({
			port: fixture.port,
			discovery,
			binding: binding(),
			requestedScopes: scopes("repo:read"),
		});

		const call = fixture.calls.find((entry) => entry.key.startsWith("POST "))
			?.body as Record<string, unknown>;
		expect(call).toMatchObject({
			session_id: "session-1",
			tenant_id: "tenant-acme",
			project_id: "project-bo",
			audience: "https://api.example.test/",
			service: `${RESOURCE}/`,
		});
	});

	it("refuses registration when only the prose advertises it", async () => {
		const { fixture, discovery } = await discover(
			{ [`POST ${REGISTRATION_URL}`]: { json: registrationBody() } },
			{ anonymous_registration_endpoint: undefined },
		);

		await expect(
			registerAnonymousAgent({
				port: fixture.port,
				discovery,
				binding: binding(),
				requestedScopes: scopes("repo:read"),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_REGISTRATION_UNSUPPORTED" });
	});

	it("refuses scopes the metadata does not support, even if the prose lists them", async () => {
		const { fixture, discovery } = await discover({
			[`POST ${REGISTRATION_URL}`]: { json: registrationBody() },
		});

		await expect(
			registerAnonymousAgent({
				port: fixture.port,
				discovery,
				binding: binding(),
				requestedScopes: scopes("admin:all"),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_SCOPE_WIDENING_DENIED" });
	});

	it("refuses a grant wider than what was requested", async () => {
		const { fixture, discovery } = await discover({
			[`POST ${REGISTRATION_URL}`]: {
				json: registrationBody({
					granted_scopes: ["repo:read", "issues:write"],
				}),
			},
		});

		await expect(
			registerAnonymousAgent({
				port: fixture.port,
				discovery,
				binding: binding(),
				requestedScopes: scopes("repo:read"),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_SCOPE_WIDENING_DENIED" });
	});

	it("refuses a binding that names a different service", async () => {
		const { fixture, discovery } = await discover({
			[`POST ${REGISTRATION_URL}`]: { json: registrationBody() },
		});

		await expect(
			registerAnonymousAgent({
				port: fixture.port,
				discovery,
				binding: binding({ service: "https://other.example.test/" }),
				requestedScopes: scopes("repo:read"),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_REGISTRATION_UNSUPPORTED" });
	});

	it("re-registers after revocation under a brand new reference", async () => {
		const { fixture, discovery } = await discover({
			[`POST ${REGISTRATION_URL}`]: { json: registrationBody() },
		});
		const first = await registerAnonymousAgent({
			port: fixture.port,
			discovery,
			binding: binding(),
			requestedScopes: scopes("repo:read"),
		});

		const port: RotationPort = {
			id: "rotation:fixture",
			async rotate() {
				return { material: "unused" };
			},
			async revoke() {
				return { revokedAt: "2026-08-08T12:20:00.000Z" };
			},
		};
		const revoked = await revokeAgentPrincipal({
			port,
			principal: first,
			keyMaterial: first.keyMaterial,
		});

		const replacementFixture = createFetchFixture({
			[`GET ${METADATA_URL}`]: { json: metadataBody() },
			[`POST ${REGISTRATION_URL}`]: {
				json: registrationBody({ registration_ref: "reg_02NEW" }),
			},
		});
		const replacementDiscovery = await discoverAuthMd({
			port: replacementFixture.port,
			resource: RESOURCE,
		});
		const replacement = await reRegisterAfterRevocation({
			revoked,
			registration: {
				port: replacementFixture.port,
				discovery: replacementDiscovery,
				binding: binding(),
				requestedScopes: scopes("repo:read"),
			},
		});

		expect(replacement.registrationRef).toBe("reg_02NEW");
		expect(replacement.registrationRef).not.toBe(revoked.registrationRef);
		expect(replacement.phase).toBe("pre-claim");
	});

	it("refuses a registration response with no key material", async () => {
		const { fixture, discovery } = await discover({
			[`POST ${REGISTRATION_URL}`]: {
				json: registrationBody({ private_key: undefined }),
			},
		});

		await expect(
			registerAnonymousAgent({
				port: fixture.port,
				discovery,
				binding: binding(),
				requestedScopes: scopes("repo:read"),
			}),
		).rejects.toMatchObject({ code: "AUTHMD_METADATA_INVALID" });
	});
});
