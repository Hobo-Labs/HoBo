import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createController, toResponse } from "./controller.mts";
import {
	type BridgePayload,
	type BridgeRequest,
	fingerprint,
	openResponse,
	REPOSITORY_ID,
	type SealedResponse,
	sealResponse,
	signRequest,
	VERSION,
	validateScope,
	verifyRequest,
} from "./protocol.mts";

const key = () =>
	generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
const worker = key(),
	controller = key(),
	app = key(),
	attacker = key();
const identity = {
	installationId: 8123,
	runId: 12345,
	runAttempt: 2,
	sourceSha: "a".repeat(40),
	workerPublicKey: worker.publicKey,
	controllerPublicKey: controller.publicKey,
};
const baseline = 2_000_000_000_000;
function request(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
	return {
		version: VERSION,
		id: randomBytes(16).toString("hex"),
		issuedAt: baseline,
		notAfter: baseline + 60000,
		installationId: identity.installationId,
		repositoryId: REPOSITORY_ID,
		runId: identity.runId,
		runAttempt: identity.runAttempt,
		sourceSha: identity.sourceSha,
		workerKey: fingerprint(worker.publicKey),
		controllerKey: fingerprint(controller.publicKey),
		method: "GET",
		path: "/repos/Hobo-Labs/HoBo/actions/runs?status=queued&per_page=50",
		body: null,
		ifNoneMatch: null,
		capability: null,
		...overrides,
	};
}
function jit(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
	return request({
		method: "POST",
		path: "/repos/Hobo-Labs/HoBo/actions/runners/generate-jitconfig",
		body: JSON.stringify({
			name: "hobo-lease_abc",
			runner_group_id: 1,
			labels: ["hobo"],
			work_folder: "_hobo_work",
		}),
		capability: "A".repeat(32),
		...overrides,
	});
}
function fake() {
	let effectCount = 0,
		tokenCount = 0,
		clock = baseline,
		failEffect = false,
		expireOnIdentity = false,
		privateRepo = false;
	const calls: {
		url: string;
		method: string | undefined;
		body: BodyInit | null | undefined;
	}[] = [];
	async function fetchImpl(url: string, init: RequestInit) {
		calls.push({ url, method: init.method, body: init.body });
		if (url.endsWith("/access_tokens")) {
			tokenCount++;
			const body = JSON.parse(z.string().parse(init.body));
			assert.deepEqual(body.repository_ids, [REPOSITORY_ID]);
			assert.deepEqual(body.permissions, {
				actions: "write",
				administration: "write",
				contents: "read",
				metadata: "read",
			});
			assert.match(
				new Headers(init.headers).get("Authorization") ?? "",
				/^Bearer [A-Za-z0-9_.-]+$/,
			);
			return Response.json({
				token: "test-only-installation-token",
				expires_at: new Date(clock + 3600000).toISOString(),
			});
		}
		if (url === `https://api.github.com/repos/Hobo-Labs/HoBo`) {
			if (expireOnIdentity) clock = baseline + 60000;
			return Response.json({
				id: REPOSITORY_ID,
				full_name: "Hobo-Labs/HoBo",
				private: privateRepo,
			});
		}
		if (init.method === "DELETE" && /\/actions\/runners\/[0-9]+$/.test(url))
			return new Response(null, { status: 204 });
		if (init.method === "POST" && url.endsWith("/force-cancel"))
			return new Response(null, { status: 202 });
		if (init.method === "POST" && url.endsWith("/rerun-failed-jobs"))
			return new Response(null, { status: 201 });
		if (url.endsWith("/generate-jitconfig")) {
			effectCount++;
			if (failEffect) throw new Error("test-only-sensitive-upstream-message");
			return Response.json(
				{ runner: { id: 7 }, encoded_jit_config: "test-only-jit" },
				{
					status: 201,
					headers: { etag: 'W/"test"', "x-ratelimit-remaining": "777" },
				},
			);
		}
		return Response.json(
			{ workflow_runs: [] },
			{ headers: { etag: 'W/"test"', "x-ratelimit-remaining": "777" } },
		);
	}
	return {
		fetchImpl,
		calls,
		get effects() {
			return effectCount;
		},
		get tokens() {
			return tokenCount;
		},
		clock: () => clock,
		setExpire() {
			expireOnIdentity = true;
		},
		setFailure() {
			failEffect = true;
		},
		setPrivate() {
			privateRepo = true;
		},
		advanceClock(ms: number) {
			clock += ms;
		},
	};
}
function harness(opts = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "hobo-bootstrap-fixture-"));
	const io = fake();
	const base = {
		dbPath: join(tmp, "state.sqlite"),
		appPrivateKey: app.privateKey,
		controllerPrivateKey: controller.privateKey,
		...identity,
		fetchImpl: io.fetchImpl,
		clock: io.clock,
		...opts,
	};
	const instance = createController(base);
	return {
		io,
		base,
		instance,
		close() {
			instance.close();
			rmSync(tmp, { recursive: true, force: true });
		},
	};
}
const envelope = (q: BridgeRequest) => signRequest(q, worker.privateKey);
const unseal = (q: BridgeRequest, s: SealedResponse) =>
	openResponse(q, s, {
		workerPrivateKey: worker.privateKey,
		controllerPublicKey: controller.publicKey,
	});
const unsealHttp = (q: BridgeRequest, s: SealedResponse) => {
	const payload = unseal(q, s);
	assert.equal(payload.outcome, "http");
	return payload;
};

test("signed request binds repo, installation, run attempt, source and both keys", () => {
	const q = request();
	assert.equal(
		verifyRequest(envelope(q), { ...identity, now: baseline }).id,
		q.id,
	);
	assert.throws(() =>
		verifyRequest(envelope({ ...q, path: "/repos/other/repo/actions/runs" }), {
			...identity,
			now: baseline,
		}),
	);
	assert.throws(() =>
		verifyRequest(envelope(q), { ...identity, runAttempt: 3, now: baseline }),
	);
	const forged = envelope(q);
	forged.request.path = "/repos/Hobo-Labs/HoBo/actions/runs/22";
	assert.throws(() => verifyRequest(forged, { ...identity, now: baseline }));
	assert.throws(() =>
		verifyRequest(envelope(q), { ...identity, now: q.notAfter }),
	);
	assert.throws(() => signRequest(q, attacker.privateKey));
});

test("scope rejects traversal, unapproved operations and query ambiguity", () => {
	for (const path of [
		"/repos/Hobo-Labs/HoBo/actions/%2f..%2fruns",
		"/repos/Hobo-Labs/HoBo/actions/runs?status=queued&status=completed",
		"/repos/Hobo-Labs/HoBo/actions/workflows/evil/dispatches",
		"/repos/Other/HoBo/actions/runs",
		"//evil.invalid/repos/Hobo-Labs/HoBo/actions/runs",
	])
		assert.throws(() => validateScope(request({ path })));
	assert.throws(() => validateScope(jit({ capability: null })));
	assert.throws(() =>
		validateScope(
			jit({
				body: JSON.stringify({
					name: "hobo-a",
					runner_group_id: 1,
					labels: ["hobo", "evil"],
					work_folder: "_hobo_work",
				}),
			}),
		),
	);
});

test("sealed response authenticates controller and is bound to exact request", () => {
	const q = request();
	const payload: BridgePayload = {
		outcome: "http",
		status: 200,
		body: "e30=",
		headers: { etag: 'W/"abc"' },
	};
	const s = sealResponse(q, payload, {
		workerPublicKey: worker.publicKey,
		controllerPrivateKey: controller.privateKey,
	});
	assert.deepEqual(unseal(q, s), payload);
	assert.throws(() => unseal({ ...q, id: randomBytes(16).toString("hex") }, s));
	const forged = { ...s, ciphertext: s.ciphertext.slice(0, -2) + "aa" };
	assert.throws(() => unseal(q, forged));
	const attackerSeal = sealResponse(
		{ ...q, controllerKey: fingerprint(attacker.publicKey) },
		payload,
		{
			workerPublicKey: worker.publicKey,
			controllerPrivateKey: attacker.privateKey,
		},
	);
	assert.throws(() => unseal(q, attackerSeal));
});

test("controller refuses effects without an explicit trusted local authority", async () => {
	const h = harness();
	try {
		const q = jit();
		assert.deepEqual(unseal(q, await h.instance.handle(envelope(q))), {
			outcome: "uncertain",
		});
		assert.equal(h.io.effects, 0);
		assert.equal(h.io.tokens, 0);
	} finally {
		h.close();
	}
});

test("scoped mint, durable replay and response headers preserve one JIT effect", async () => {
	const h = harness({ trustSignedLocalAuthority: true });
	try {
		const q = jit();
		const first = await h.instance.handle(envelope(q));
		const second = await h.instance.handle(envelope(q));
		assert.deepEqual(second, first);
		const payload = unsealHttp(q, first);
		assert.equal(payload.status, 201);
		assert.equal(
			JSON.parse(Buffer.from(payload.body, "base64").toString())
				.encoded_jit_config,
			"test-only-jit",
		);
		const response = toResponse(payload);
		assert.equal(response.headers.get("etag"), 'W/"test"');
		assert.equal(response.headers.get("x-ratelimit-remaining"), "777");
		assert.equal(h.io.effects, 1);
		assert.equal(h.io.tokens, 1);
		const dup = envelope({
			...q,
			path: "/repos/Hobo-Labs/HoBo/actions/runs",
			method: "GET",
			body: null,
			capability: null,
		});
		await assert.rejects(h.instance.handle(dup));
	} finally {
		h.close();
	}
});

test("lost mutation acknowledgement is uncertain and never retried", async () => {
	const h = harness({ trustSignedLocalAuthority: true });
	try {
		h.io.setFailure();
		const q = jit();
		assert.deepEqual(unseal(q, await h.instance.handle(envelope(q))), {
			outcome: "uncertain",
		});
		assert.deepEqual(unseal(q, await h.instance.handle(envelope(q))), {
			outcome: "uncertain",
		});
		assert.equal(h.io.effects, 1);
	} finally {
		h.close();
	}
});

test("token acquisition cannot cross lease deadline into JIT registration", async () => {
	const h = harness({ trustSignedLocalAuthority: true });
	try {
		h.io.setExpire();
		const q = jit();
		assert.deepEqual(unseal(q, await h.instance.handle(envelope(q))), {
			outcome: "uncertain",
		});
		assert.equal(h.io.effects, 0);
	} finally {
		h.close();
	}
});

test("a pending/replayed request never invokes mutation after restart", async () => {
	const h = harness({ trustSignedLocalAuthority: true });
	try {
		const q = jit();
		h.io.setFailure();
		const first = await h.instance.handle(envelope(q));
		h.instance.close();
		const reopened = createController(h.base);
		try {
			assert.deepEqual(await reopened.handle(envelope(q)), first);
			assert.equal(h.io.effects, 1);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(h.base.dbPath, { force: true });
		rmSync(join(h.base.dbPath, ".."), { recursive: true, force: true });
	}
});

test("cached token cannot register a runner after repository becomes private", async () => {
	const h = harness({ trustSignedLocalAuthority: true });
	try {
		const read = request();
		assert.equal(
			unsealHttp(read, await h.instance.handle(envelope(read))).status,
			200,
		);
		h.io.setPrivate();
		const q = jit();
		assert.deepEqual(unseal(q, await h.instance.handle(envelope(q))), {
			outcome: "uncertain",
		});
		assert.equal(h.io.tokens, 1);
		assert.equal(h.io.effects, 0);
	} finally {
		h.close();
	}
});

test("private visibility denies new JIT and reruns while allowing runner deletion and cancellation, including token refresh", async () => {
	const h = harness({ trustSignedLocalAuthority: true });
	try {
		const read = request();
		assert.equal(
			unsealHttp(read, await h.instance.handle(envelope(read))).status,
			200,
		);
		h.io.setPrivate();
		h.io.advanceClock(3_300_000);
		const at = baseline + 3_300_000;
		const q = jit({ issuedAt: at, notAfter: at + 60000 });
		assert.deepEqual(unseal(q, await h.instance.handle(envelope(q))), {
			outcome: "uncertain",
		});
		const rerun = request({
			issuedAt: at,
			notAfter: at + 60000,
			method: "POST",
			path: "/repos/Hobo-Labs/HoBo/actions/runs/44/rerun-failed-jobs",
			capability: "A".repeat(32),
		});
		assert.deepEqual(unseal(rerun, await h.instance.handle(envelope(rerun))), {
			outcome: "uncertain",
		});
		const del = request({
			issuedAt: at,
			notAfter: at + 60000,
			method: "DELETE",
			path: "/repos/Hobo-Labs/HoBo/actions/runners/77",
			capability: "A".repeat(32),
		});
		assert.equal(
			unsealHttp(del, await h.instance.handle(envelope(del))).status,
			204,
		);
		const cancel = request({
			issuedAt: at,
			notAfter: at + 60000,
			method: "POST",
			path: "/repos/Hobo-Labs/HoBo/actions/runs/44/force-cancel",
			capability: "A".repeat(32),
		});
		assert.equal(
			unsealHttp(cancel, await h.instance.handle(envelope(cancel))).status,
			202,
		);
		assert.equal(h.io.tokens, 2);
		assert(!h.io.calls.some((c) => c.url.endsWith("/rerun-failed-jobs")));
	} finally {
		h.close();
	}
});
