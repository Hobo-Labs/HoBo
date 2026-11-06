import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
	publicKeySha256Base64,
	signControllerMetadata,
	verifyControllerMetadata,
} from "./bootstrap-crypto.mts";
import { loadPreparedController, prepareController } from "./prepare.mts";
import { APP_ID, REPOSITORY_ID } from "./protocol.mts";
import { verifyGithubApp } from "./verify-app.mts";

const pair = () =>
	generateKeyPairSync("rsa", {
		modulusLength: 3072,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
const local = pair(),
	app = pair(),
	attacker = pair();
const now = 2_000_000_000_000,
	identity = { runId: 17, runAttempt: 1, sourceSha: "a".repeat(40) };
function fake({
	privateRepo = false,
	badApp = false,
	badInstall = false,
	suspended = false,
} = {}) {
	const calls: {
		url: string;
		method: string | undefined;
		body: RequestInit["body"];
	}[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, method: init?.method, body: init?.body });
		if (url === "https://api.github.com/app")
			return Response.json({
				id: badApp ? 1 : APP_ID,
				slug: "hobo-ci-runner-b61dd084",
				owner: { login: "Hobo-Labs" },
				permissions: { actions: "write", administration: "write" },
			});
		if (url.endsWith("/installation"))
			return Response.json({
				id: 20,
				app_id: APP_ID,
				account: { login: "Hobo-Labs" },
				suspended_at: suspended ? "2026-01-01T00:00:00Z" : null,
				permissions: {
					actions: "write",
					administration: badInstall ? "read" : "write",
				},
			});
		if (url.endsWith("/access_tokens")) {
			assert.deepEqual(
				JSON.parse(z.string().parse(init?.body)).repository_ids,
				[REPOSITORY_ID],
			);
			return Response.json({
				token: "fixture-private-token",
				expires_at: new Date(now + 3600000).toISOString(),
			});
		}
		if (
			url ===
			"https://api.github.com/repos/Hobo-Labs/HoBo/actions/runners?per_page=1"
		)
			return Response.json({ runners: [], total_count: 0 });
		if (url === "https://api.github.com/repos/Hobo-Labs/HoBo")
			return Response.json({
				id: REPOSITORY_ID,
				full_name: "Hobo-Labs/HoBo",
				private: privateRepo,
			});
		throw new Error("unexpected");
	};
	return { calls, fetchImpl };
}
test("prepares pinned 3072-bit controller key with private mode and immutable artifact", () => {
	const temp = mkdtempSync(join(tmpdir(), "hobo-prepare-")),
		workspace = mkdtempSync(join(tmpdir(), "hobo-workspace-"));
	try {
		const args = {
			runnerTemp: temp,
			workspace,
			localPublicKeyBase64: Buffer.from(local.publicKey).toString("base64"),
			...identity,
		};
		const meta = prepareController(args);
		assert.equal(meta.kind, "hobo-controller-ready");
		assert.equal(meta.repositoryId, REPOSITORY_ID);
		assert(!JSON.stringify(meta).includes("PRIVATE KEY"));
		const loaded = loadPreparedController(args);
		assert.equal(
			statSync(join(loaded.root, "controller-private.pem")).mode & 0o077,
			0,
		);
		assert.throws(() => loadPreparedController({ ...args, runAttempt: 2 }));
		assert.throws(() => prepareController(args));
	} finally {
		rmSync(temp, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	}
});
test("only matching App, installation permissions, scoped token and public repository pass", async () => {
	const f = fake();
	const opts = {
		appPrivateKey: app.privateKey,
		expectedFingerprint: publicKeySha256Base64(app.privateKey),
		fetchImpl: f.fetchImpl,
		now,
	};
	const result = await verifyGithubApp(opts);
	assert.equal(result.installationId, 20);
	assert.deepEqual(
		f.calls.map((x) => x.method),
		["GET", "GET", "POST", "GET", "GET"],
	);
	for (const variant of [
		{ badApp: true },
		{ badInstall: true },
		{ privateRepo: true },
		{ suspended: true },
	])
		await assert.rejects(
			verifyGithubApp({ ...opts, fetchImpl: fake(variant).fetchImpl }),
		);
	await assert.rejects(
		verifyGithubApp({ ...opts, expectedFingerprint: "wrong" }),
	);
});
test("public controller metadata is authenticated and bound to actual run", () => {
	const controller = pair();
	const value = signControllerMetadata({
		...identity,
		installationId: 20,
		localPublicKey: local.publicKey,
		controllerPrivateKey: controller.privateKey,
		issuedAt: now,
	});
	type VerificationOptions = Parameters<typeof verifyControllerMetadata>[0];
	const verify = (
		metadata: VerificationOptions["metadata"],
		extra: Partial<
			Pick<VerificationOptions, "expected" | "controllerPublicKey">
		> = {},
	) =>
		verifyControllerMetadata({
			metadata,
			expected: identity,
			localPublicKey: local.publicKey,
			controllerPublicKey: controller.publicKey,
			...extra,
		});
	assert.deepEqual(verify(value), { installationId: 20 });
	assert.throws(() => verify({ ...value, installationId: 21 }));
	assert.throws(() =>
		verify(value, { expected: { ...identity, runAttempt: 2 } }),
	);
	assert.throws(() =>
		verify(value, { controllerPublicKey: attacker.publicKey }),
	);
});

test("oversized App metadata cancels the stream before any installation effect", async () => {
	let cancelled = false;
	let calls = 0;
	const fetchImpl: typeof fetch = async () => {
		calls++;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024 + 1));
				},
				cancel() {
					cancelled = true;
				},
			}),
		);
	};
	await assert.rejects(
		verifyGithubApp({
			appPrivateKey: app.privateKey,
			expectedFingerprint: publicKeySha256Base64(app.privateKey),
			fetchImpl,
			now,
		}),
		/App verification failed/,
	);
	assert.equal(calls, 1);
	assert.equal(cancelled, true);
});
