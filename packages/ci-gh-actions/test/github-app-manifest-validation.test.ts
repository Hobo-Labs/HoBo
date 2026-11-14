import { createVerify, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { verifyConvertedGithubApp } from "../src/github-app-manifest-validation.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const origin = "https://ci.hobo.test";
function app() {
	return {
		id: 42,
		slug: "hobo-ci",
		owner: { id: 123, type: "User" },
		external_url: origin,
		permissions: {
			actions: "write",
			administration: "write",
			contents: "write",
			workflows: "write",
			metadata: "read",
			pull_requests: "write",
			members: "read",
		},
		events: ["workflow_job", "workflow_run"],
	};
}
function hook() {
	return {
		url: `${origin}/github/webhooks`,
		content_type: "json",
		insecure_ssl: "0",
	};
}
type FixtureObject =
	| ReturnType<typeof app>
	| ReturnType<typeof hook>
	| (Omit<ReturnType<typeof app>, "permissions"> & { permissions: undefined });
function fixture(
	metadata: FixtureObject = app(),
	live: FixtureObject = app(),
	config: FixtureObject = hook(),
) {
	const calls: string[] = [];
	return {
		calls,
		run: () =>
			verifyConvertedGithubApp({
				appId: 42,
				pem: privateKey,
				metadata,
				expectedOrigin: origin,
				expectedOwnerId: 123,
				now: () => 2_000_000,
				fetch: async (url, init) => {
					const path = String(url);
					calls.push(path);
					expect(init?.redirect).toBe("error");
					const token = new Headers(init?.headers)
						.get("authorization")
						?.slice(7);
					if (!token) throw new Error("missing signed token");
					const parts = token.split(".");
					const payload = JSON.parse(
						Buffer.from(parts[1] ?? "", "base64url").toString(),
					);
					expect(payload).toEqual({ iat: 1940, exp: 2540, iss: "42" });
					expect(
						createVerify("RSA-SHA256")
							.update(`${parts[0]}.${parts[1]}`)
							.verify(publicKey, Buffer.from(parts[2] ?? "", "base64url")),
					).toBe(true);
					if (path === "https://api.github.com/app") return Response.json(live);
					if (path === "https://api.github.com/app/hook/config")
						return Response.json(config);
					throw new Error("unexpected GitHub URL");
				},
			}),
	};
}

it("verifies the converted owner, signed App identity, reviewed manifest and webhook", async () => {
	const f = fixture();
	await expect(f.run()).resolves.toBeUndefined();
	expect(f.calls).toEqual([
		"https://api.github.com/app",
		"https://api.github.com/app/hook/config",
	]);
});

it("rejects malformed or escalated conversion metadata before network access", async () => {
	for (const invalid of [
		{ ...app(), owner: { id: 124, type: "User" } },
		{ ...app(), id: 43 },
		{ ...app(), external_url: "https://attacker.test" },
		{ ...app(), external_url: `${origin}/?redirect=1` },
		{ ...app(), events: ["workflow_job"] },
		{ ...app(), events: ["workflow_job", "workflow_run", "push"] },
		{ ...app(), permissions: { ...app().permissions, secrets: "write" } },
		{ ...app(), permissions: { ...app().permissions, administration: "read" } },
		{ ...app(), permissions: undefined },
	]) {
		const f = fixture(invalid);
		await expect(f.run()).rejects.toThrow();
		expect(f.calls).toEqual([]);
	}
});

it("rejects changed App identity, permissions, events or webhook configuration", async () => {
	for (const [live, config] of [
		[{ ...app(), slug: "another-app" }, hook()],
		[{ ...app(), owner: { id: 124, type: "User" } }, hook()],
		[
			{ ...app(), permissions: { ...app().permissions, members: "write" } },
			hook(),
		],
		[
			{ ...app(), events: ["workflow_run", "workflow_job", "workflow_job"] },
			hook(),
		],
		[app(), { ...hook(), url: "https://attacker.test/github/webhooks" }],
		[app(), { ...hook(), url: `${origin}/github/webhooks?token=1` }],
		[app(), { ...hook(), insecure_ssl: "1" }],
		[app(), { ...hook(), content_type: "form" }],
	])
		await expect(fixture(app(), live, config).run()).rejects.toThrow();
});

it("fails closed on invalid signing keys and GitHub verification errors", async () => {
	await expect(
		verifyConvertedGithubApp({
			appId: 42,
			pem: "invalid-key",
			metadata: app(),
			expectedOrigin: origin,
			expectedOwnerId: 123,
		}),
	).rejects.toThrow();
	let calls = 0;
	await expect(
		verifyConvertedGithubApp({
			appId: 42,
			pem: privateKey,
			metadata: app(),
			expectedOrigin: origin,
			expectedOwnerId: 123,
			fetch: async () => {
				calls++;
				return new Response(null, { status: 401 });
			},
		}),
	).rejects.toThrow("GitHub App verification failed");
	expect(calls).toBe(1);
});

it("accepts an App owned by an organization, matched by the organization's id", async () => {
	const org = { ...app(), owner: { id: 123, type: "Organization" } };
	await expect(fixture(org, org).run()).resolves.toBeUndefined();
});

it("refuses an organization-owned App whose id is not the one that asked", async () => {
	const other = { ...app(), owner: { id: 999, type: "Organization" } };
	await expect(fixture(other, other).run()).rejects.toThrow(
		"does not match reviewed configuration",
	);
});

it("holds the owner type when the caller pins it", async () => {
	const org = { ...app(), owner: { id: 123, type: "Organization" } };
	await expect(
		verifyConvertedGithubApp({
			appId: 42,
			pem: privateKey,
			metadata: org,
			expectedOrigin: origin,
			expectedOwnerId: 123,
			expectedOwnerType: "User",
			now: () => 2_000_000,
			fetch: async () => new Response("{}"),
		}),
	).rejects.toThrow("does not match reviewed configuration");
});
