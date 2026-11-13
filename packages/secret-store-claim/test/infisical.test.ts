import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { type ActionCipher, createOneTimeActionStore } from "@hobo/claims";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachInfisicalCloud,
	claimScopeFor,
	formatSecretStoreBinding,
	provisionSelfHostedInfisical,
	readSecretStoreBinding,
	relayStoreLayout,
	SECRET_STORE_CLAIM_ITEM,
	SecretStoreError,
	updateDeployIdentityTrust,
	verifySelfHostedInfisicalClaim,
} from "../src/index.js";
import {
	RELAY_DEPLOY_SUBJECT,
	RELAY_GITHUB_SUBJECT,
} from "./support/github-subject.js";
import {
	type StubInfisical,
	startStubInfisical,
} from "./support/stub-infisical.js";

// A real AES-GCM cipher, so a sealed value is not readable in storage.
function testCipher(): ActionCipher {
	const key = randomBytes(32);
	return {
		seal(plaintext) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const sealed = Buffer.concat([
				cipher.update(plaintext, "utf8"),
				cipher.final(),
			]);
			return [iv, cipher.getAuthTag(), sealed]
				.map((b) => b.toString("base64"))
				.join(".");
		},
		open(sealed) {
			const [iv, tag, data] = sealed
				.split(".")
				.map((part) => Buffer.from(part, "base64"));
			if (!iv || !tag || !data) throw new Error("sealed value malformed");
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(data), decipher.final()]).toString(
				"utf8",
			);
		},
	};
}

const PASSWORD = "stub-generated-password-0123456789abcdef";
const NOW = new Date("2026-11-12T10:00:00.000Z");
const layout = relayStoreLayout({
	vercelTeamSlug: "hobo-team",
	vercelTeamId: "team_fixture",
	vercelProjectId: "prj_fixture",
	github: RELAY_GITHUB_SUBJECT,
});
const scope = claimScopeFor("ci-vercel", {});

let stub: StubInfisical;
beforeEach(async () => {
	stub = await startStubInfisical();
});
afterEach(async () => {
	await stub.close();
});

describe("a self-hosted Infisical, bootstrapped and handed over by claim", () => {
	it("bootstraps, makes the relay's layout, and seals the owner's sign-in", async () => {
		const store = createOneTimeActionStore(testCipher());
		const { binding, bundle } = await provisionSelfHostedInfisical({
			siteUrl: stub.url,
			ownerEmail: "owner@hobo.invalid",
			organization: "hobo",
			layout,
			deploymentRef: "ci-vercel",
			store,
			scope,
			now: NOW,
			generatePassword: () => PASSWORD,
			allowLoopback: true,
		});

		expect(stub.bootstrapped()).toBe(true);
		expect(stub.folders).toEqual([
			{
				projectId: binding.projectId,
				environment: "prod",
				name: "hobo-ci-relay",
			},
		]);
		const relay = stub.identities.find((i) => i.name === "hobo-ci-relay");
		const deploy = stub.identities.find((i) => i.name === "hobo-ci-deploy");
		expect(relay?.role).toBe("viewer");
		expect(deploy?.role).toBe("viewer");
		// The deploy credential lives in a project the relay identity is not in.
		expect(deploy?.projectId).toBe(binding.deployProjectId);
		expect(relay?.projectId).toBe(binding.projectId);
		expect(binding.deployProjectId).not.toBe(binding.projectId);
		expect(relay?.oidc).toMatchObject({
			boundIssuer: "https://oidc.vercel.com/hobo-team",
			boundSubject: "owner:hobo-team:project:hobo-ci:environment:production",
			boundClaims: { owner_id: "team_fixture", project_id: "prj_fixture" },
		});
		// The subject GitHub issues for the repository (immutable form), never
		// the legacy repo:owner/name one, and its ids pinned as claims.
		expect(deploy?.oidc).toMatchObject({
			boundIssuer: "https://token.actions.githubusercontent.com",
			boundAudiences: "https://github.com/Hobo-Labs",
			boundSubject: RELAY_DEPLOY_SUBJECT,
			boundClaims: {
				repository_id: "1274791462",
				repository_owner_id: "344805935",
			},
		});
		expect(binding.deployOidcSubject).toBe(RELAY_DEPLOY_SUBJECT);

		expect(binding).toMatchObject({
			kind: "infisical-self-hosted",
			endpoint: stub.url,
			environment: "prod",
			secretPath: "/hobo-ci-relay",
			relayIdentityId: relay?.id,
			deployIdentityId: deploy?.id,
			vercelTeamId: "team_fixture",
			claimState: "pending",
		});
		const [item] = bundle.items;
		expect(item?.id).toBe(SECRET_STORE_CLAIM_ITEM);
		expect(item?.mode).toBe("credential-exchange");
		expect(item?.creatorAuthorityAfterClaim).toBe("absent");

		// Refs only: no password or token anywhere a log, event or file could show.
		const visible = JSON.stringify({ binding, bundle });
		expect(visible).not.toContain(PASSWORD);
		expect(visible).not.toContain("stub-admin-token");
		expect(formatSecretStoreBinding(binding)).not.toContain(PASSWORD);

		// `hobo claim open secret-store` redeems the sign-in, once.
		const opened = await store.redeem({
			id: item?.oneTimeActionRef ?? "",
			...scope,
			audience: item?.providerId ?? "",
			now: NOW.getTime() + 1000,
		});
		const signIn = new URL(opened.value);
		expect(signIn.origin).toBe(stub.url);
		expect(new URLSearchParams(signIn.hash.slice(1)).get("password")).toBe(
			PASSWORD,
		);
		await expect(
			store.redeem({
				id: item?.oneTimeActionRef ?? "",
				...scope,
				audience: item?.providerId ?? "",
				now: NOW.getTime() + 2000,
			}),
		).rejects.toMatchObject({ code: "ONE_TIME_ACTION_REPLAYED" });
		// Another audience cannot redeem the owner's action.
		await expect(
			store.redeem({
				id: item?.oneTimeActionRef ?? "",
				...scope,
				audience: "cloudflare-temporary",
				now: NOW.getTime() + 2000,
			}),
		).rejects.toMatchObject({ code: "ONE_TIME_ACTION_EXPIRED" });
	});

	it("finalize revokes HoBo's bootstrap identity and sees its token refused", async () => {
		const store = createOneTimeActionStore(testCipher());
		const { bundle } = await provisionSelfHostedInfisical({
			siteUrl: stub.url,
			ownerEmail: "owner@hobo.invalid",
			organization: "hobo",
			layout,
			deploymentRef: "ci-vercel",
			store,
			scope,
			now: NOW,
			generatePassword: () => PASSWORD,
			allowLoopback: true,
		});
		const [item] = bundle.items;
		if (!item) throw new Error("no claim item");
		const before = stub.identities.length;
		const result = await verifySelfHostedInfisicalClaim({
			item,
			store,
			scope,
			nowMs: NOW.getTime() + 60_000,
		});
		expect(result.verified).toBe(true);
		expect(result.evidenceRef).toMatch(/bootstrap-token-refused-401$/u);
		expect(stub.identities).toHaveLength(before - 1);
		expect(
			stub.identities.some((i) => i.name === "Instance Admin Identity"),
		).toBe(false);
		// The revocation material is gone: a second finalize cannot reuse it.
		expect(
			await verifySelfHostedInfisicalClaim({
				item,
				store,
				scope,
				nowMs: NOW.getTime() + 120_000,
			}),
		).toEqual({
			verified: false,
			evidenceRef: "revocation-material-unavailable",
		});
	});

	it("refuses an instance that was already bootstrapped, naming no secret", async () => {
		const store = createOneTimeActionStore(testCipher());
		const run = () =>
			provisionSelfHostedInfisical({
				siteUrl: stub.url,
				ownerEmail: "owner@hobo.invalid",
				organization: "hobo",
				layout,
				deploymentRef: "ci-vercel",
				store,
				scope,
				now: NOW,
				generatePassword: () => PASSWORD,
				allowLoopback: true,
			});
		await run();
		const error = await run().catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(SecretStoreError);
		expect(error).toMatchObject({ code: "SECRET_STORE_PROVIDER_FAILED" });
		expect(String(error)).not.toContain(PASSWORD);
	});

	it("refuses a site URL that carries credentials", async () => {
		const store = createOneTimeActionStore(testCipher());
		await expect(
			provisionSelfHostedInfisical({
				siteUrl: "https://admin:fixture@secrets.example.invalid",
				ownerEmail: "owner@hobo.invalid",
				organization: "hobo",
				layout,
				deploymentRef: "ci-vercel",
				store,
				scope,
				now: NOW,
			}),
		).rejects.toMatchObject({ code: "SECRET_STORE_INVALID" });
		expect(stub.bodies).toHaveLength(0);
	});
});

describe("an Infisical Cloud organization the owner already has", () => {
	it("provisions the same layout with the owner's own token and needs no claim", async () => {
		// The stub stands in for the owner's org: bootstrap only to mint a token.
		const response = await fetch(`${stub.url}/api/v1/admin/bootstrap`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: "o@hobo.invalid",
				password: PASSWORD,
				organization: "o",
			}),
		});
		const minted: { identity: { credentials: { token: string } } } =
			await response.json();
		const binding = await attachInfisicalCloud({
			siteUrl: stub.url,
			ownerAccessToken: minted.identity.credentials.token,
			layout,
			deploymentRef: "ci-vercel",
			now: NOW,
			allowLoopback: true,
		});
		expect(binding.kind).toBe("infisical-cloud-attach");
		expect(binding.claimState).toBe("claimed");
		expect(
			readSecretStoreBinding(formatSecretStoreBinding(binding), {
				allowLoopback: true,
			}),
		).toEqual(binding);
	});
});

describe("re-running connect against an existing store", () => {
	it("replaces the deploy identity's OIDC trust in place, creating nothing", async () => {
		const store = createOneTimeActionStore(testCipher());
		const stale = relayStoreLayout({
			vercelTeamSlug: "hobo-team",
			vercelTeamId: "team_fixture",
			vercelProjectId: "prj_fixture",
			github: RELAY_GITHUB_SUBJECT,
			branch: "legacy-branch",
		});
		const { binding } = await provisionSelfHostedInfisical({
			siteUrl: stub.url,
			ownerEmail: "owner@hobo.invalid",
			organization: "hobo",
			layout: stale,
			deploymentRef: "ci-vercel",
			store,
			scope,
			now: NOW,
			generatePassword: () => PASSWORD,
			allowLoopback: true,
		});
		const before = {
			projects: stub.projects.length,
			identities: stub.identities.length,
		};
		await updateDeployIdentityTrust({
			siteUrl: stub.url,
			ownerAccessToken: stub.adminToken(),
			deployIdentityId: binding.deployIdentityId,
			trust: layout.deployTrust,
		});
		expect({
			projects: stub.projects.length,
			identities: stub.identities.length,
		}).toEqual(before);
		const deploy = stub.identities.find(
			(identity) => identity.id === binding.deployIdentityId,
		);
		expect(deploy?.oidc?.boundSubject).toBe(RELAY_DEPLOY_SUBJECT);
		expect(stub.patches).toEqual([binding.deployIdentityId]);
	});

	it("fails typed, naming no token, when the identity has no OIDC Auth to update", async () => {
		const store = createOneTimeActionStore(testCipher());
		await provisionSelfHostedInfisical({
			siteUrl: stub.url,
			ownerEmail: "owner@hobo.invalid",
			organization: "hobo",
			layout,
			deploymentRef: "ci-vercel",
			store,
			scope,
			now: NOW,
			generatePassword: () => PASSWORD,
			allowLoopback: true,
		});
		const error = await updateDeployIdentityTrust({
			siteUrl: stub.url,
			ownerAccessToken: stub.adminToken(),
			deployIdentityId: "missing-identity",
			trust: layout.deployTrust,
		}).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "SECRET_STORE_PROVIDER_FAILED" });
		expect(String(error)).toContain("not-found");
		expect(String(error)).not.toContain(stub.adminToken());
	});
});
