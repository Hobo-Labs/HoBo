import { generateKeyPairSync } from "node:crypto";
import { verifyJwtWithJwks } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	CD_SVID_SIGNING_KEY,
	ownerCdSvidIssuer,
} from "../src/cd-svid-issuer.js";

const origin = "https://cd.example.test";

describe("owner-backed CD agent issuer", () => {
	it("verifies a token across separately opened replicas and restarts", async () => {
		const material = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.privateKey.export({ format: "pem", type: "pkcs8" })
			.toString();
		const read = async (name: string) =>
			name === CD_SVID_SIGNING_KEY ? material : undefined;
		const first = await ownerCdSvidIssuer(read, origin);
		const restarted = await ownerCdSvidIssuer(read, origin);
		const token = await first.issuer.signJwtSvid({
			sub: "spiffe://test/reconciler/one",
			aud: "test-agent",
			tenant: "test",
			parentPrincipal: { kind: "service", id: "test" },
			codeVersion: { digest: "test", version: "test" },
			scope: [],
			iat: 100,
			nbf: 100,
			exp: 200,
		});
		const verified = await verifyJwtWithJwks(token, restarted.issuer.jwks(), {
			issuer: origin,
			audience: "test-agent",
			now: 150,
		});
		expect(verified.claims.sub).toBe("spiffe://test/reconciler/one");
		expect(first.issuer.activeKeyId).toBe(restarted.issuer.activeKeyId);
		expect(JSON.stringify(restarted.issuer.jwks())).not.toContain(material);
		first.close();
		expect(() =>
			first.issuer.kms.sign(first.issuer.activeKeyId, "fixture"),
		).toThrow("CD signing key unavailable");
		expect(first.issuer.kms.hasKey(first.issuer.activeKeyId)).toBe(false);
		expect(restarted.issuer.kms.hasKey(restarted.issuer.activeKeyId)).toBe(
			true,
		);
		restarted.close();
	});

	it("refuses missing or invalid material and cannot generate a replacement on a replica", async () => {
		await expect(
			ownerCdSvidIssuer(async () => undefined, origin),
		).rejects.toThrow("CD signing key unavailable");
		await expect(
			ownerCdSvidIssuer(async () => "invalid synthetic key", origin),
		).rejects.toThrow();
		const material = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.privateKey.export({ format: "pem", type: "pkcs8" })
			.toString();
		const issuer = await ownerCdSvidIssuer(async () => material, origin);
		expect(() => issuer.issuer.rotateSigningKey("other")).toThrow(
			/owner store/,
		);
		issuer.close();
	});

	it("refuses public startup when the owner store cannot establish the issuer", async () => {
		const { openCdRuntime } = await import("../src/cd-runtime.js");
		for (const readSecret of [undefined, async () => "invalid synthetic key"]) {
			const opened = await openCdRuntime({
				env: {},
				home: "/unused",
				cwd: "/unused",
				simulate: false,
				publicOrigin: origin,
				...(readSecret ? { readSecret } : undefined),
			});
			expect(opened.ok).toBe(false);
			if (!opened.ok) {
				expect(opened.reasons[0]?.code).toBe("cd-svid-issuer-unavailable");
				expect(JSON.stringify(opened.reasons)).not.toContain(
					"invalid synthetic key",
				);
			}
		}
	});
});
