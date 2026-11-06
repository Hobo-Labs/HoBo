import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createController } from "./controller.mts";
import { REPOSITORY_ID, sealResponse } from "./protocol.mts";
import { createSpoolGithubTransport } from "./transport.mts";

const key = () =>
	generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
const worker = key(),
	controller = key(),
	app = key();
const repo = "Hobo-Labs/HoBo";
const installationId = 8123,
	runId = 12345,
	runAttempt = 1,
	sourceSha = "a".repeat(40);
function setup(timeoutMs = 5000) {
	const root = mkdtempSync(join(tmpdir(), "hobo-spool-fixture-"));
	const privateKeyPath = join(root, "private.pem"),
		controllerPublicKeyPath = join(root, "controller.pem");
	writeFileSync(privateKeyPath, worker.privateKey, { mode: 0o600 });
	writeFileSync(controllerPublicKeyPath, controller.publicKey, { mode: 0o600 });
	const opts = {
		directory: join(root, "spool"),
		installationId,
		repository: repo,
		privateKeyPath,
		controllerPublicKeyPath,
		runId,
		runAttempt,
		sourceSha,
		deadlineForRunner: async (name: string) =>
			name === "hobo-lease_abc" ? Date.now() + 60_000 : undefined,
		pollMs: 25,
		timeoutMs,
	};
	return {
		root,
		opts,
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function fakeFetch() {
	return async (url: string, _init: RequestInit) => {
		if (url.endsWith("/access_tokens"))
			return Response.json({
				token: "fixture-token",
				expires_at: new Date(Date.now() + 3600000).toISOString(),
			});
		if (url === `https://api.github.com/repos/${repo}`)
			return Response.json({
				id: REPOSITORY_ID,
				full_name: repo,
				private: false,
			});
		return Response.json(
			{ runner: { id: 7 }, encoded_jit_config: "fixture-private-jit" },
			{ status: 201, headers: { etag: 'W/"fixture"' } },
		);
	};
}
const body = JSON.stringify({
	name: "hobo-lease_abc",
	runner_group_id: 1,
	labels: ["hobo"],
	work_folder: "_hobo_work",
});
test("local spool roundtrip preserves JIT response but never writes plaintext response", async () => {
	const h = setup();
	const c = createController({
		dbPath: join(h.root, "journal.sqlite"),
		appPrivateKey: app.privateKey,
		controllerPrivateKey: controller.privateKey,
		controllerPublicKey: controller.publicKey,
		workerPublicKey: worker.publicKey,
		installationId,
		runId,
		runAttempt,
		sourceSha,
		trustSignedLocalAuthority: true,
		fetchImpl: fakeFetch(),
	});
	let tick,
		busy = false;
	try {
		const t = createSpoolGithubTransport(h.opts);
		tick = setInterval(async () => {
			if (busy) return;
			const dir = join(h.opts.directory, "requests");
			if (!readdirSync(dir).length) return;
			busy = true;
			try {
				const name = readdirSync(dir).find((n) =>
					/^[a-f0-9]{32}\.json$/.test(n),
				);
				if (!name) return;
				const env = JSON.parse(readFileSync(join(dir, name), "utf8"));
				const sealed = await c.handle(env);
				const wire = JSON.stringify(sealed);
				assert(!wire.includes("fixture-private-jit"));
				writeFileSync(join(h.opts.directory, "responses", name), wire, {
					mode: 0o600,
				});
			} finally {
				busy = false;
			}
		}, 25);
		const response = await t.request(
			installationId,
			`/repos/${repo}/actions/runners/generate-jitconfig`,
			"POST",
			body,
		);
		assert.equal(response.status, 201);
		assert.equal(response.headers.get("etag"), 'W/"fixture"');
		assert.equal(
			(await response.json()).encoded_jit_config,
			"fixture-private-jit",
		);
	} finally {
		clearInterval(tick);
		c.close();
		h.close();
	}
});
test("JIT requires an existing live lease and binds its exact queue deadline", async () => {
	const h = setup();
	try {
		const t = createSpoolGithubTransport({
			...h.opts,
			deadlineForRunner: async () => undefined,
		});
		await assert.rejects(
			t.request(
				installationId,
				`/repos/${repo}/actions/runners/generate-jitconfig`,
				"POST",
				body,
			),
			/lease unavailable/,
		);
		assert.deepEqual(readdirSync(join(h.opts.directory, "requests")), []);
		const t2 = createSpoolGithubTransport({
			...h.opts,
			deadlineForRunner: async () => Date.now() - 1,
		});
		await assert.rejects(
			t2.request(
				installationId,
				`/repos/${repo}/actions/runners/generate-jitconfig`,
				"POST",
				body,
			),
			/deadline expired/,
		);
	} finally {
		h.close();
	}
});
test("JIT bridge rejects a missing deadline without publishing a request", async () => {
	const h = setup();
	try {
		const transport = createSpoolGithubTransport({
			...h.opts,
			deadlineForRunner: async () => null,
		});
		await assert.rejects(
			transport.request(
				installationId,
				`/repos/${repo}/actions/runners/generate-jitconfig`,
				"POST",
				body,
			),
			/lease unavailable/,
		);
		assert.deepEqual(readdirSync(join(h.opts.directory, "requests")), []);
	} finally {
		h.close();
	}
});
test("unanswered request becomes a durable abandoned marker and is not retried", async () => {
	const h = setup(75);
	try {
		const t = createSpoolGithubTransport(h.opts);
		await assert.rejects(
			t.request(installationId, `/repos/${repo}/actions/runs`),
			/uncertain/,
		);
		const files = readdirSync(join(h.opts.directory, "requests"));
		assert.equal(files.length, 1);
		const first = files[0];
		assert.ok(first);
		assert.deepEqual(readdirSync(join(h.opts.directory, "abandoned")), [
			first.slice(0, -5),
		]);
	} finally {
		h.close();
	}
});
test("forged response from unpinned controller is rejected", async () => {
	const h = setup();
	const attacker = key();
	let tick;
	try {
		const t = createSpoolGithubTransport(h.opts);
		tick = setInterval(() => {
			const dir = join(h.opts.directory, "requests");
			const file = readdirSync(dir).find((n) => /^[a-f0-9]{32}\.json$/.test(n));
			if (!file) return;
			const q = JSON.parse(readFileSync(join(dir, file), "utf8")).request;
			const forged = sealResponse(
				{ ...q, controllerKey: awaitFingerprint(attacker.publicKey) },
				{ outcome: "http", status: 200, headers: {}, body: "e30=" },
				{
					workerPublicKey: worker.publicKey,
					controllerPrivateKey: attacker.privateKey,
				},
			);
			writeFileSync(
				join(h.opts.directory, "responses", file),
				JSON.stringify(forged),
			);
		}, 25);
		await assert.rejects(
			t.request(installationId, `/repos/${repo}/actions/runs`),
			/uncertain/,
		);
		assert.equal(readdirSync(join(h.opts.directory, "abandoned")).length, 1);
	} finally {
		clearInterval(tick);
		h.close();
	}
});

import { fingerprint as awaitFingerprint } from "./protocol.mts";

test("a live lease queue deadline is embedded in the authenticated JIT request", async () => {
	const h = setup();
	const deadline = Date.now() + 2000;
	const c = createController({
		dbPath: join(h.root, "journal.sqlite"),
		appPrivateKey: app.privateKey,
		controllerPrivateKey: controller.privateKey,
		controllerPublicKey: controller.publicKey,
		workerPublicKey: worker.publicKey,
		installationId,
		runId,
		runAttempt,
		sourceSha,
		trustSignedLocalAuthority: true,
		fetchImpl: fakeFetch(),
	});
	let tick,
		busy = false;
	try {
		const t = createSpoolGithubTransport({
			...h.opts,
			deadlineForRunner: async () => new Date(deadline).toISOString(),
		});
		tick = setInterval(async () => {
			if (busy) return;
			const dir = join(h.opts.directory, "requests"),
				file = readdirSync(dir).find((n) => /^[a-f0-9]{32}\.json$/.test(n));
			if (!file) return;
			busy = true;
			try {
				const env = JSON.parse(readFileSync(join(dir, file), "utf8"));
				assert.equal(env.request.notAfter, deadline);
				const sealed = await c.handle(env);
				writeFileSync(
					join(h.opts.directory, "responses", file),
					JSON.stringify(sealed),
				);
			} finally {
				busy = false;
			}
		}, 25);
		assert.equal(
			(
				await t.request(
					installationId,
					`/repos/${repo}/actions/runners/generate-jitconfig`,
					"POST",
					body,
				)
			).status,
			201,
		);
	} finally {
		clearInterval(tick);
		c.close();
		h.close();
	}
});
