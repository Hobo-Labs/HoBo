import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	CLOUDFLARE_PRIVACY_URL,
	CLOUDFLARE_TERMS_URL,
	createInMemoryConsentLedger,
	createInMemoryOneTimeActionVault,
	createInMemorySecretCustody,
	provisionTemporaryAccountYard,
	solvePreviewChallenge,
	solvePreviewChallengeOffThread,
	type TemporaryAccountHttpRequest,
	type TemporaryAccountTransportPort,
	uploadTemporaryAccountWorker,
	workerUploadBody,
} from "../src/index.js";

// Obviously fake material; nothing here reaches Cloudflare.
const FAKE_TOKEN = "FAKE-cf-temporary-api-token-DO-NOT-USE-0000000000";
const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const EXPIRES = NOW + 60 * 60_000;
const ACCOUNT = "fake0000000040008000cloudflareacct";

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json };
/** The `result` of a Cloudflare v4 envelope. */
type CloudflareResult = { readonly [key: string]: Json };

function stub(): TemporaryAccountTransportPort & {
	readonly requests: TemporaryAccountHttpRequest[];
} {
	const requests: TemporaryAccountHttpRequest[] = [];
	const ok = (result: CloudflareResult) => ({
		status: 200,
		headers: {},
		body: JSON.stringify({ success: true, result, errors: [], messages: [] }),
	});
	return {
		requests,
		async send(request) {
			requests.push(request);
			const path = new URL(request.url).pathname;
			if (path.endsWith("/previews/challenge"))
				return ok({
					challengeToken: "FAKE-CHALLENGE-TOKEN",
					seed: Buffer.alloc(32, 7).toString("base64url"),
					k: 2,
					g: 3,
				});
			if (path.endsWith("/provisioning/previews"))
				return ok({
					account: {
						id: ACCOUNT,
						apiToken: FAKE_TOKEN,
						expiresAt: new Date(EXPIRES).toISOString(),
					},
					claim: {
						url: "https://dash.cloudflare.com/claim-preview?claimToken=FAKE-CLAIM-0000000000",
						expiresAt: new Date(EXPIRES).toISOString(),
					},
				});
			if (path.endsWith("/scripts/hobo-config-test"))
				return ok({ id: "hobo-config-test" });
			if (path.endsWith("/scripts/hobo-config-test/subdomain"))
				return ok({ enabled: true });
			if (path.endsWith("/workers/subdomain"))
				return ok({ subdomain: "hobo-test" });
			return { status: 404, headers: {}, body: "{}" };
		},
	};
}

const upload = {
	scriptName: "hobo-config-test",
	mainModule: "index.js",
	modules: [
		{
			name: "index.js",
			source: 'export { ConfigStore } from "./store.js";\nexport default {};',
		},
		{ name: "store.js", source: "export class ConfigStore {}" },
	],
	compatibilityDate: "2026-07-01",
	durableObject: {
		binding: "CONFIG_STORE",
		className: "ConfigStore",
		migrationTag: "v1",
	},
	plainText: { HOBO_CONFIG_BINDING: '{"storeId":"x"}' },
};

async function account(transport = stub()) {
	const custody = createInMemorySecretCustody();
	const receipt = await provisionTemporaryAccountYard({
		transport,
		custody,
		consentLedger: createInMemoryConsentLedger({ nowMs: () => NOW }),
		actionVault: createInMemoryOneTimeActionVault(),
		consent: {
			subjectRef: "hobo-owner-test",
			termsUrl: CLOUDFLARE_TERMS_URL,
			privacyUrl: CLOUDFLARE_PRIVACY_URL,
			acceptedAtMs: NOW - 1000,
			acceptanceMethod: "cli-confirmation",
		},
		audienceRef: "hobo-test",
		nowMs: NOW,
		solveChallenge: solvePreviewChallengeOffThread,
	});
	return { transport, custody, receipt };
}

describe("a Worker with a Durable Object on a temporary account", () => {
	it("solves the proof of work off the main thread to the same checkpoints", async () => {
		const challenge = {
			challengeToken: "FAKE",
			seed: Buffer.alloc(32, 9).toString("base64url"),
			k: 3,
			g: 5,
		};
		expect(await solvePreviewChallengeOffThread(challenge)).toEqual(
			await solvePreviewChallenge(challenge),
		);
		await expect(
			solvePreviewChallengeOffThread({ ...challenge, k: 64_000_001, g: 1 }),
		).rejects.toMatchObject({ code: "WORK_BUDGET_EXCEEDED" });
	});

	it("uploads the modules with the namespace binding and a SQLite-class migration, with the account's own token", async () => {
		const { transport, custody, receipt } = await account();
		const deployed = await uploadTemporaryAccountWorker({
			transport,
			custody,
			receipt,
			upload,
			nowMs: NOW + 1000,
		});
		expect(deployed.workersDevUrl).toBe(
			"https://hobo-config-test.hobo-test.workers.dev",
		);
		const [put, route, subdomain] = transport.requests.slice(2);
		expect([put?.method, route?.method, subdomain?.method]).toEqual([
			"PUT",
			"POST",
			"GET",
		]);
		expect(put?.url).toBe(
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/hobo-config-test`,
		);
		expect(put?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
		expect(put?.headers["content-type"]).toMatch(
			/^multipart\/form-data; boundary=[0-9a-f]{32}$/u,
		);
		const { metadata } = workerUploadBody(upload, "fixedboundary");
		expect(JSON.parse(metadata)).toEqual({
			main_module: "index.js",
			compatibility_date: "2026-07-01",
			bindings: [
				{
					type: "durable_object_namespace",
					name: "CONFIG_STORE",
					class_name: "ConfigStore",
				},
				{
					type: "plain_text",
					name: "HOBO_CONFIG_BINDING",
					text: '{"storeId":"x"}',
				},
			],
			migrations: { new_tag: "v1", new_sqlite_classes: ["ConfigStore"] },
		});
		expect(put?.body).toContain('name="store.js"; filename="store.js"');
		expect(put?.body).toContain("Content-Type: application/javascript+module");
	});

	it("cannot upload once the token is destroyed or the lease has run out", async () => {
		const { transport, custody, receipt } = await account();
		await expect(
			uploadTemporaryAccountWorker({
				transport,
				custody,
				receipt,
				upload,
				nowMs: EXPIRES + 1,
			}),
		).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
		await custody.destroy(receipt.apiTokenRef);
		await expect(
			uploadTemporaryAccountWorker({
				transport,
				custody,
				receipt,
				upload,
				nowMs: NOW + 1,
			}),
		).rejects.toMatchObject({ code: "SECRET_CUSTODY_UNAVAILABLE" });
	});

	it("refuses malformed uploads before any request", async () => {
		for (const bad of [
			{ ...upload, scriptName: "Not_A_Label" },
			{ ...upload, mainModule: "missing.js" },
			{ ...upload, plainText: { CONFIG_STORE: "shadow" } },
			{
				...upload,
				durableObject: { ...upload.durableObject, migrationTag: "latest" },
			},
		])
			expect(() => workerUploadBody(bad)).toThrow(/./u);
	});
});
