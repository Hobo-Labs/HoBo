import { generateKeyPairSync, verify } from "node:crypto";
import { expect, it } from "vitest";
import {
	discloseSensitive,
	discoverAuthMd,
	exchangeAgentAccessToken,
	parseScopes,
	parseSessionBinding,
	registerAnonymousAgent,
	requestJson,
} from "../src/index.js";
import { createSelfHostedHttpsFixture } from "./https-fixture.js";

it.each([
	"EdDSA",
	"ES256",
	"RS256",
])("uses real %s proof-of-possession for a protected self-hosted resource", async (algorithm) => {
	const { privateKey, publicKey } =
		algorithm === "EdDSA"
			? generateKeyPairSync("ed25519")
			: algorithm === "ES256"
				? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
				: generateKeyPairSync("rsa", { modulusLength: 2048 });
	const privatePem = privateKey
		.export({ type: "pkcs8", format: "pem" })
		.toString();
	let origin = "";
	let mode = "good";
	const assertions = new Set<string>();
	const bodies: string[] = [];
	const fixture = await createSelfHostedHttpsFixture((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/metadata/resource") {
			res.end(
				JSON.stringify({
					resource: `${origin}/`,
					authorization_servers: [`${origin}/`],
					scopes_supported: ["repo:read", "repo:write"],
					anonymous_registration_endpoint: `${origin}/register`,
				}),
			);
			return;
		}
		if (req.url === "/.well-known/oauth-authorization-server") {
			res.end(
				JSON.stringify({
					issuer: `${origin}/`,
					token_endpoint: `${origin}/token`,
					token_endpoint_auth_methods_supported: ["private_key_jwt"],
					token_endpoint_auth_signing_alg_values_supported: [algorithm],
				}),
			);
			return;
		}
		if (req.url === "/protected") {
			if (req.headers.authorization !== "Bearer actual-access-token") {
				res.statusCode = 401;
				res.end("{}");
				return;
			}
			res.end(JSON.stringify({ authenticated: true }));
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += String(chunk);
		});
		req.on("end", () => {
			bodies.push(body);
			if (req.url === "/register") {
				res.end(
					JSON.stringify({
						registration_ref: "registered-agent",
						granted_scopes: ["repo:read"],
						private_key: privatePem,
						issued_at: new Date().toISOString(),
						expires_at: new Date(Date.now() + 3600000).toISOString(),
						rotation_endpoint: `${origin}/rotate`,
						revocation_endpoint: `${origin}/revoke`,
					}),
				);
				return;
			}
			if (req.url !== "/token") {
				res.statusCode = 404;
				res.end("{}");
				return;
			}
			if (mode === "redirect") {
				res.statusCode = 307;
				res.setHeader("location", "/protected");
				res.end();
				return;
			}
			const form = new URLSearchParams(body);
			expect(form.get("grant_type")).toBe("client_credentials");
			expect(form.get("client_id")).toBe("registered-agent");
			expect(form.get("client_assertion_type")).toBe(
				"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
			);
			expect(form.get("scope")).toBe("repo:read");
			const assertion = form.get("client_assertion") ?? "";
			const [header, payload, signature] = assertion.split(".");
			const claims = JSON.parse(
				Buffer.from(payload ?? "", "base64url").toString(),
			);
			expect(
				JSON.parse(Buffer.from(header ?? "", "base64url").toString()),
			).toMatchObject({ alg: algorithm, typ: "JWT" });
			expect(
				verify(
					algorithm === "EdDSA" ? null : "sha256",
					Buffer.from(`${header}.${payload}`),
					{ key: publicKey, dsaEncoding: "ieee-p1363" },
					Buffer.from(signature ?? "", "base64url"),
				),
			).toBe(true);
			expect(claims).toMatchObject({
				iss: "registered-agent",
				sub: "registered-agent",
				aud: `${origin}/token`,
				tenant_id: "tenant-a",
				project_id: "project-a",
				session_id: "session-a",
				audience: "api-a",
				service: `${origin}/`,
				resource: `${origin}/`,
			});
			expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
			expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
			expect(assertions.has(claims.jti)).toBe(false);
			assertions.add(claims.jti);
			res.end(
				JSON.stringify({
					access_token: "actual-access-token",
					token_type: "Bearer",
					expires_in: mode === "expiry" ? 0 : 120,
					scope: mode === "widen" ? "repo:write" : "repo:read",
					audience: mode === "audience" ? "wrong" : "api-a",
					resource: `${origin}/`,
					session_id: mode === "session" ? "wrong" : "session-a",
					tenant_id: mode === "tenant" ? "wrong" : "tenant-a",
					project_id: mode === "project" ? "wrong" : "project-a",
					service: mode === "service" ? "https://other.invalid/" : `${origin}/`,
				}),
			);
		});
	});
	origin = fixture.origin;
	try {
		const discovery = await discoverAuthMd({
			port: fixture.port,
			resource: origin,
			metadataUrl: `${origin}/metadata/resource`,
			includeDocument: false,
		});
		const registration = await registerAnonymousAgent({
			port: fixture.port,
			discovery,
			binding: parseSessionBinding({
				sessionId: "session-a",
				tenantId: "tenant-a",
				projectId: "project-a",
				audience: "api-a",
				service: origin,
			}),
			requestedScopes: parseScopes(["repo:read"]),
		});
		expect(registration.rotationEndpoint).toBe(`${origin}/rotate`);
		expect(registration.revocationEndpoint).toBe(`${origin}/revoke`);
		const token = await exchangeAgentAccessToken({
			port: fixture.port,
			discovery,
			registration,
		});
		expect(JSON.stringify(token)).not.toContain("actual-access-token");
		expect(JSON.stringify(token)).not.toContain(privatePem);
		expect(
			await requestJson(fixture.port, `${origin}/protected`, {
				headers: {
					authorization: `Bearer ${discloseSensitive(token.accessToken)}`,
				},
			}),
		).toEqual({ authenticated: true });
		expect(
			bodies
				.filter((body) => new URLSearchParams(body).has("client_assertion"))
				.every((body) => !body.includes("PRIVATE KEY")),
		).toBe(true);
		mode = "widen";
		await expect(
			exchangeAgentAccessToken({ port: fixture.port, discovery, registration }),
		).rejects.toMatchObject({ code: "AUTHMD_SCOPE_WIDENING_DENIED" });
		mode = "audience";
		await expect(
			exchangeAgentAccessToken({ port: fixture.port, discovery, registration }),
		).rejects.toMatchObject({ code: "AUTHMD_ASSERTION_INVALID" });
		for (const dimension of ["session", "tenant", "project", "service"]) {
			mode = dimension;
			await expect(
				exchangeAgentAccessToken({
					port: fixture.port,
					discovery,
					registration,
				}),
			).rejects.toMatchObject({ code: "AUTHMD_ASSERTION_INVALID" });
		}
		mode = "expiry";
		await expect(
			exchangeAgentAccessToken({ port: fixture.port, discovery, registration }),
		).rejects.toMatchObject({ code: "AUTHMD_ASSERTION_INVALID" });
		mode = "redirect";
		await expect(
			exchangeAgentAccessToken({ port: fixture.port, discovery, registration }),
		).rejects.toMatchObject({ code: "AUTHMD_DISCOVERY_FAILED" });
		await expect(
			discoverAuthMd({
				port: fixture.port,
				resource: origin,
				metadataUrl: "https://other.invalid/metadata",
				includeDocument: false,
			}),
		).rejects.toMatchObject({ code: "AUTHMD_METADATA_INVALID" });
	} finally {
		await fixture.close();
	}
});
