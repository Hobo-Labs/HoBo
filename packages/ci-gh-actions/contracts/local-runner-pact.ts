import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import {
	MatchersV3 as M,
	PactV3,
	Verifier,
	type VerifierOptions,
} from "@pact-foundation/pact";
import { z } from "zod";
import { claimRunnerJit } from "../src/bootstrap.js";
import { createHostedRelayRuntime } from "../src/hosted-runtime.js";
import { createRelayHandler } from "../src/http-handler.js";
import { createNodeRelayHandler } from "../src/node-http.js";
import { harness, persist, queued, reserve, SECRET } from "../test/fixtures.js";

export const consumer = "HoboCiLocalWorkflowAcceptance";
export const provider = "HoboCiLocalRelay";
const exampleLease = "00000000-0000-4000-8000-000000000001";
const claimPath = `/v1/leases/${exampleLease}/jit`;
const responseHeaders = {
	"Content-Type": "application/json",
	"Cache-Control": "no-store",
};
const claimStates = [
	"available",
	"disabled",
	"expired",
	"revoked",
	"wrong-host",
	"claimed",
	"completed",
	"bad-jit",
	"identity-repository",
	"identity-attempt",
	"identity-sha",
	"identity-workflow",
	"host-completed",
	"original-revoked",
] as const;
const admissionStates = [
	"available",
	"busy",
	"duplicate",
	"disabled",
	"expired",
	"public",
	"fork",
	"pull-request",
	"revoked",
] as const;
export const scenarios = [
	...admissionStates.map((state) => `admission:${state}`),
	...claimStates.map((state) => `claim:${state}`),
	"claim:invalid-identity",
	"claim:unknown-lease",
	"webhook:unsigned",
	"webhook:invalid-signature",
	"webhook:malformed",
	"http:health",
	"http:unknown-route",
	"webhook:provider-unavailable",
];
const signature = (body: string) =>
	`sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
type WebhookHeaders = {
	"Content-Type": string;
	"x-github-event": string;
	"x-github-delivery": string;
	"x-hub-signature-256"?: string;
};
/**
 * What the relay answers a signed delivery over HTTP. It commits the delivery
 * to its inbox and decides admission on its worker tick, so the answer says
 * only whether the delivery was taken: `ignored` when no connection binds the
 * repository. The admission outcome of each state is verified after the tick,
 * in `admissionOutcome` below.
 */
const intake = (state: (typeof admissionStates)[number]) =>
	state === "revoked" ? "ignored" : "accepted";

export async function generateLocalRunnerPact(
	directory: string,
): Promise<string> {
	await mkdir(directory, { recursive: true });
	const pact = new PactV3({
		consumer,
		provider,
		dir: directory,
		logLevel: "error",
	});
	for (const state of admissionStates) {
		const body = queued(state === "busy" ? 2 : 1);
		const expected = intake(state);
		const headers = {
			"Content-Type": "application/json",
			"x-github-event": "workflow_job",
			"x-github-delivery": `admission-${state}`,
			"x-hub-signature-256": signature(JSON.stringify(body)),
		};
		pact
			.given(`admission:${state}`)
			.uponReceiving(`admission:${state}`)
			.withRequest({ method: "POST", path: "/github/webhooks", headers, body })
			.willRespondWith({
				status: 202,
				headers: responseHeaders,
				body: { status: expected },
			});
		await pact.executeTest(async (mock) => {
			const response = await fetch(`${mock.url}/github/webhooks`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			assert.equal(response.status, 202);
			assert.deepEqual(await response.json(), { status: expected });
		});
	}
	for (const state of [...claimStates, "invalid-identity", "unknown-lease"]) {
		const status = state === "available" ? 200 : 403;
		const token =
			state === "invalid-identity" || state === "unknown-lease"
				? "invalid"
				: "valid";
		pact
			.given(`claim:${state}`)
			.uponReceiving(`claim:${state}`)
			.withRequest({
				method: "POST",
				path:
					state === "unknown-lease"
						? claimPath
						: M.fromProviderState("/v1/leases/${leaseId}/jit", claimPath),
				headers: { Authorization: `Bearer ${token}` },
			})
			.willRespondWith({
				status,
				headers: responseHeaders,
				body:
					status === 200
						? { encodedJitConfig: "c2VjcmV0" }
						: { error: "claim rejected" },
			});
		await pact.executeTest(async (mock) => {
			if (status === 200)
				assert.equal(
					await claimRunnerJit(new URL(mock.url), exampleLease, token),
					"c2VjcmV0",
				);
			else
				await assert.rejects(
					claimRunnerJit(new URL(mock.url), exampleLease, token),
					/bootstrap request failed \(403\)/,
				);
		});
	}
	for (const name of ["unsigned", "invalid-signature", "malformed"] as const) {
		const body = name === "malformed" ? { invalid: true } : queued();
		const headers: WebhookHeaders = {
			"Content-Type": "application/json",
			"x-github-event": "workflow_job",
			"x-github-delivery": `webhook-${name}`,
		};
		if (name !== "unsigned")
			headers["x-hub-signature-256"] =
				name === "invalid-signature"
					? `sha256=${"0".repeat(64)}`
					: signature(JSON.stringify(body));
		const status = name === "malformed" ? 400 : 401;
		const error =
			name === "unsigned"
				? "signature required"
				: name === "malformed"
					? "webhook event mismatch"
					: "webhook rejected";
		pact
			.given("relay:serving")
			.uponReceiving(`webhook:${name}`)
			.withRequest({ method: "POST", path: "/github/webhooks", headers, body })
			.willRespondWith({ status, headers: responseHeaders, body: { error } });
		await pact.executeTest(async (mock) => {
			const response = await fetch(`${mock.url}/github/webhooks`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			assert.equal(response.status, status);
			assert.deepEqual(await response.json(), { error });
		});
	}
	for (const [name, route, status, body] of [
		[
			"health",
			"/healthz",
			200,
			{ ok: true, engines: { "gh-actions": { ok: true } } },
		],
		["unknown-route", "/account-secrets", 404, { error: "not found" }],
	] as const) {
		pact
			.given("relay:serving")
			.uponReceiving(`http:${name}`)
			.withRequest({ method: "GET", path: route })
			.willRespondWith({ status, headers: responseHeaders, body });
		await pact.executeTest(async (mock) => {
			const response = await fetch(`${mock.url}${route}`);
			assert.equal(response.status, status);
			assert.deepEqual(await response.json(), body);
		});
	}
	const unavailableBody = queued();
	const unavailableHeaders = {
		"Content-Type": "application/json",
		"x-github-event": "workflow_job",
		"x-github-delivery": "webhook-provider-unavailable",
		"x-hub-signature-256": signature(JSON.stringify(unavailableBody)),
	};
	pact
		.given("admission:api-unavailable")
		.uponReceiving("webhook:provider-unavailable")
		.withRequest({
			method: "POST",
			path: "/github/webhooks",
			headers: unavailableHeaders,
			body: unavailableBody,
		})
		// GitHub being unreachable does not lose the delivery: it is committed
		// and the worker retries it.
		.willRespondWith({
			status: 202,
			headers: responseHeaders,
			body: { status: "accepted" },
		});
	await pact.executeTest(async (mock) => {
		const response = await fetch(`${mock.url}/github/webhooks`, {
			method: "POST",
			headers: unavailableHeaders,
			body: JSON.stringify(unavailableBody),
		});
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { status: "accepted" });
	});
	const file = join(directory, `${consumer}-${provider}.json`);
	const parsed = z
		.object({ interactions: z.array(z.object({ description: z.string() })) })
		.parse(JSON.parse(await readFile(file, "utf8")));
	assert.deepEqual(
		parsed.interactions.map((item) => item.description).sort(),
		[...scenarios].sort(),
		"every scenario must generate exactly one interaction",
	);
	return file;
}

export async function verifyLocalRunnerPact(
	options: Omit<
		VerifierOptions,
		"providerBaseUrl" | "stateHandlers" | "requestFilter"
	>,
	fault = false,
): Promise<void> {
	const serve = (h: ReturnType<typeof harness>) => {
		const runtime = createHostedRelayRuntime({
			store: h.ledger,
			github: h.api,
			identity: h.relay.options.identity,
			webhookSecret: SECRET,
			control: async () => undefined,
			now: () => h.clock.now,
		});
		return {
			h,
			runtime,
			handle: createRelayHandler({
				application: runtime,
				webhookSecret: SECRET,
				now: () => h.clock.now,
			}),
		};
	};
	let current = serve(harness());
	const adapt = createNodeRelayHandler({
		origin: "https://relay.example",
		handle: (request) => current.handle(request),
	});
	const server = createServer((request, response) => {
		if (fault && request.url === "/healthz") {
			response.setHeader("Content-Type", "application/json");
			response.setHeader("Cache-Control", "no-store");
			response.end('{"ok":false}');
			return;
		}
		void adapt(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = z.object({ port: z.number() }).parse(server.address());
	const stateHandlers: NonNullable<VerifierOptions["stateHandlers"]> = {};
	// Pact logs a state handler that throws and carries on; collect them so an
	// interaction cannot pass against a state that was never arranged or checked.
	const stateFailures: string[] = [];
	const strictly =
		<T>(name: string, step: () => Promise<T>) =>
		async () => {
			try {
				return await step();
			} catch (error) {
				stateFailures.push(
					`${name}: ${error instanceof Error ? error.message : "failed"}`,
				);
				throw error;
			}
		};
	const setup = async (name: string) => {
		assert.deepEqual(current.h.api.violations, []);
		current.h.store.close();
		current.h.ledger.close();
		current = serve(harness());
		const h = current.h;
		const account = h.configuration.accounts[0];
		const offer = account?.offers[0];
		assert.ok(account && offer);
		account.budgetMicros = 0;
		Object.assign(offer, {
			provider: "local",
			backend: "gh-actions",
			providerAccountId: "owned-dev-machine",
			runsOn: "hobo-local-host",
			freeMinutes: 0,
			priceMicrosPerMinute: 0,
			budgetMicros: 0,
		});
		h.api.hostLabel = "hobo-local-host";
		const [phase, state] = name.split(":");
		if (name === "claim:revoked")
			h.configuration.connections[0]?.allowedRefs.push("refs/heads/release");
		let leaseId = exampleLease;
		if (phase === "claim" && state !== "unknown-lease") {
			const lease = await reserve(h);
			leaseId = lease.id;
			await h.relay.dispatchPending();
			if (state === "claimed" || state === "completed") {
				await h.relay.claim(lease.id, "valid");
				if (state === "completed") {
					h.api.host.status = "completed";
					await h.relay.reconcile(lease.id, 22);
				}
			}
		}
		if (state === "busy") await reserve(h);
		if (state === "duplicate") await reserve(h);
		if (state === "api-unavailable")
			h.api.request = async () => {
				throw new Error("fixture GitHub API unavailable");
			};
		// The relay reads policy from its store: a policy change is stored.
		if (state === "disabled") {
			offer.enabled = false;
			persist(h);
		}
		// The offer's evidence is valid until 2026-10-27; time passes it.
		if (state === "expired") h.clock.now = "2026-10-27T00:00:01Z";
		if (state === "public") h.api.original.repository.private = false;
		if (state === "fork") h.api.original.head_repository.id = 999;
		if (state === "pull-request") h.api.original.event = "pull_request";
		if (state === "revoked") {
			if (phase === "claim") {
				// The store refuses to remove a connection while its lease is
				// active; an allowlist can only be narrowed. What can be revoked
				// under a dispatched host is the trust in the workflow's branch.
				const connection = h.configuration.connections[0];
				assert.ok(connection);
				connection.allowedRefs.splice(0, Infinity, "refs/heads/release");
			} else h.configuration.connections.length = 0;
			persist(h);
		}
		if (state === "wrong-host") h.api.hostLabel = "ubuntu-24.04";
		if (state === "bad-jit") h.api.invalidJit = true;
		if (state === "identity-repository") h.identityClaims.repository_id = "999";
		if (state === "identity-attempt") h.identityClaims.run_attempt = "2";
		if (state === "identity-sha")
			h.identityClaims.workflow_sha = "b".repeat(40);
		if (state === "identity-workflow")
			h.identityClaims.workflow_ref = `org/repo/.github/workflows/untrusted.yml@${h.identityClaims.workflow_sha}`;
		if (state === "host-completed") h.api.host.status = "completed";
		if (state === "original-revoked") h.api.original.event = "pull_request";
		return { leaseId };
	};
	/**
	 * The admission decision of each state, read from the relay's store after
	 * its worker tick has processed the delivery the interaction just sent.
	 */
	const admissionOutcome = async (state: string) => {
		const { h, runtime } = current;
		// The tick dispatches what it reserves; the provider fixture records the lease.
		h.api.strictLeaseId = false;
		if (state === "api-unavailable") {
			await assert.rejects(runtime.tick(), /inbox deliveries failed/);
			assert.deepEqual(h.store.all(), []);
			assert.equal(
				await h.ledger.hasWebhook("webhook-provider-unavailable"),
				true,
			);
			return;
		}
		await runtime.tick();
		const leases = h.store.all();
		const pending = h.store.pendingJobs().map((job) => job.id);
		if (state === "available" || state === "duplicate") {
			assert.deepEqual(
				leases.map((lease) => [lease.jobId, lease.provider, lease.state]),
				[[1, "local", "dispatched"]],
			);
			assert.deepEqual(pending, []);
		} else if (state === "busy") {
			// The one workstation is taken by job 1; job 2 waits in the journal.
			assert.deepEqual(
				leases.map((lease) => lease.jobId),
				[1],
			);
			assert.deepEqual(pending, [2]);
		} else if (state === "disabled" || state === "expired") {
			assert.deepEqual(leases, []);
			assert.deepEqual(pending, [1]);
		} else {
			// public, fork, pull-request, revoked: no demand is recorded at all.
			assert.deepEqual(leases, []);
			assert.deepEqual(pending, []);
		}
	};
	for (const name of [
		...admissionStates.map((state) => `admission:${state}`),
		...claimStates.map((state) => `claim:${state}`),
		"claim:invalid-identity",
		"claim:unknown-lease",
		"admission:api-unavailable",
	])
		stateHandlers[name] = name.startsWith("admission:")
			? {
					setup: strictly(`${name} setup`, () => setup(name)),
					teardown: strictly(`${name} outcome`, () =>
						admissionOutcome(name.slice("admission:".length)),
					),
				}
			: strictly(`${name} setup`, () => setup(name));
	stateHandlers["relay:serving"] = strictly("relay:serving setup", () =>
		setup("relay:serving"),
	);
	try {
		await new Verifier({
			...options,
			providerBaseUrl: `http://127.0.0.1:${port}`,
			logLevel: "error",
			failIfNoPactsFound: true,
			stateHandlers,
			requestFilter(
				request: IncomingMessage & { path: string; body: object },
				_response: ServerResponse,
				next: () => void,
			) {
				// Pact reserializes JSON. Sign the replay bytes with the fixture secret;
				// missing and deliberately invalid signatures remain untouched.
				const header = request.headers["x-hub-signature-256"];
				if (
					request.path === "/github/webhooks" &&
					header &&
					header !== `sha256=${"0".repeat(64)}`
				)
					request.headers["x-hub-signature-256"] = signature(
						JSON.stringify(request.body),
					);
				next();
			},
		}).verifyProvider();
		assert.deepEqual(stateFailures, []);
		assert.deepEqual(current.h.api.violations, []);
	} finally {
		await new Promise<void>((done, reject) =>
			server.close((error) => (error ? reject(error) : done())),
		);
		current.h.store.close();
		current.h.ledger.close();
	}
}
