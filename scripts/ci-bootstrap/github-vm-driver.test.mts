import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
	GithubVmDockerDriverOptions,
	GithubMethod,
	DeliveryMessage,
	NativeRun,
	ReadyArtifact,
	VmSpec,
} from "./github-vm-driver.mts";
import type { ContainerSpec, WorkerIdentity } from "./vm-delivery.mts";
import {
	WorkflowDispatchSchema,
	captureRunnerStartArgv,
	createGithubVmDockerDriver,
} from "./github-vm-driver.mts";
import {
	DeliveryEnvelopeSchema,
	openDelivery,
	sealDelivery,
	signStart,
	verifyStart,
} from "./vm-delivery.mts";

const signing = generateKeyPairSync("rsa", { modulusLength: 3072 }),
	worker = generateKeyPairSync("rsa", { modulusLength: 3072 }),
	foreign = generateKeyPairSync("rsa", { modulusLength: 3072 });
const leaseId = "12345678-1234-4234-9234-123456789abc";
const name = "hobo-" + leaseId,
	sourceSha = "a".repeat(40),
	imageDigest = "sha256:" + "b".repeat(64),
	imageId = "sha256:" + "c".repeat(64);
const identity: WorkerIdentity = {
	repositoryId: 1274791462,
	leaseId,
	runId: 101,
	runAttempt: 1,
	sourceSha,
	imageDigest,
};
const container: ContainerSpec = {
	env: {
		NODE_OPTIONS: "--max-old-space-size=3072",
		HOBO_CI_JOB_MEMORY_MB: "6144",
		HOBO_CI_RELAY_ORIGIN: "http://127.0.0.1",
		HOBO_CI_RUNNER_SHA256: "d".repeat(64),
		HOBO_CI_RUNNER_URL:
			"https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-x64-2.338.2.tar.gz",
	},
	memoryMb: 6144,
	runAsUser: "1000:1000",
};
const expectedStartArgv = ["sh", "-ec", "fixed trusted runner start"];
function item<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) throw new Error("missing fixture value");
	return value;
}
function present<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing fixture value");
	return value;
}
type FixtureResponseBody =
	| NativeRun
	| { id: number; full_name: string; private: boolean }
	| { workflow_runs: NativeRun[] };
function response(status: number, body?: FixtureResponseBody): Response {
	return new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function fixture(
	t: TestContext,
	overrides: Partial<GithubVmDockerDriverOptions> = {},
) {
	const root = mkdtempSync(join(tmpdir(), "hobo-vm-driver-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let now = 1_000_000;
	const calls: {
		path: string;
		method: GithubMethod;
		body: string | undefined;
	}[] = [];
	const deliveries: DeliveryMessage[] = [];
	const run: NativeRun = {
		id: 101,
		run_attempt: 1,
		head_sha: sourceSha,
		head_branch: "ops/bootstrap-source",
		workflow_id: 99,
		event: "workflow_dispatch",
		display_title: "hobo-bootstrap-worker-" + leaseId,
		repository: { id: 1274791462 },
		status: "in_progress",
		conclusion: null,
	};
	let complete = false,
		missingProof = false,
		wrongArtifact = false,
		failDispatch = false,
		failPublish = false,
		finishCancel = true;
	const ready: ReadyArtifact = {
		version: 1,
		kind: "hobo-worker-ready",
		...identity,
		publicKey: worker.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		preflight: { ok: true, imageId, architecture: "x64" },
	};
	const stateFile = join(root, "state.json");
	const options: GithubVmDockerDriverOptions = {
		github: {
			async request(_installation, path, method = "GET", body) {
				calls.push({ path, method, body });
				if (path === "/repos/Hobo-Labs/HoBo")
					return response(200, {
						id: 1274791462,
						full_name: "Hobo-Labs/HoBo",
						private: false,
					});
				if (method === "POST" && path.endsWith("/dispatches")) {
					if (failDispatch) throw new Error("simulated lost acknowledgement");
					return response(204);
				}
				if (method === "POST" && path.endsWith("/cancel")) {
					if (finishCancel) {
						run.status = "completed";
						run.conclusion = "cancelled";
					}
					return response(202);
				}
				if (path.includes("/actions/workflows/99/runs?"))
					return response(200, { workflow_runs: [run] });
				if (
					path.endsWith("/actions/runs/101") ||
					path.endsWith("/actions/runs/101/attempts/1")
				)
					return response(200, run);
				throw new Error("unexpected fixture operation");
			},
		},
		installationId: 55,
		workflowId: 99,
		sourceRef: "ops/bootstrap-source",
		sourceSha,
		controlBranch: "ops/mailbox",
		imageRef: "ttl.sh/hobo-image@" + imageDigest,
		imageDigest,
		imageId,
		localImage: "hobo-ci-operator:local",
		stateFile,
		signingPrivateKey: signing.privateKey,
		expectedStartArgv,
		clock: () => now,
		wait: async (ms) => {
			now += ms;
		},
		pollMs: 1000,
		readyTimeoutMs: 3000,
		cancelTimeoutMs: 2000,
		async readArtifact({ runId, runAttempt: _runAttempt, name: artifactName }) {
			if (
				artifactName.includes("-complete-") &&
				(missingProof || (!complete && run.status !== "completed"))
			)
				return null;
			const value = artifactName.includes("-ready-")
				? ready
				: {
						version: 1,
						kind: "hobo-worker-complete",
						...identity,
						exitCode: 0,
						oomKilled: false,
						runnerExited: true,
					};
			return {
				artifact: {
					id: 11,
					name: artifactName,
					expired: false,
					digest: "sha256:" + "e".repeat(64),
					workflow_run: {
						id: runId,
						head_sha: wrongArtifact ? "f".repeat(40) : sourceSha,
					},
				},
				value,
			};
		},
		async writeDelivery(value) {
			deliveries.push(value);
			if (failPublish)
				throw new Error("simulated publication acknowledgement loss");
		},
		async inspectPinnedImage() {
			return { id: imageId, repoTags: ["hobo-ci-operator:local"], labels: {} };
		},
		async probePinnedImage() {
			return { exitCode: 0 };
		},
		deadlineForLease: async () => null,
		...overrides,
	};
	const driver = createGithubVmDockerDriver(options);
	const spec: VmSpec = {
		name,
		image: options.localImage,
		timeoutMs: 1800000,
		command: ["sleep", "infinity"],
		...container,
		env: {
			...container.env,
			HOBO_CI_HOST_JOB_DIRECTORY: "/private/local/host/path",
		},
		volumes: [
			{
				source: "/private/local/host/path",
				target: "/opt/actions-runner/_hobo_work",
			},
		],
	};
	return {
		driver,
		spec,
		options,
		calls,
		deliveries,
		run,
		ready,
		stateFile,
		clock: () => now,
		setNow(v: number) {
			now = v;
		},
		complete() {
			complete = true;
		},
		failDispatch() {
			failDispatch = true;
		},
		failPublish(v = true) {
			failPublish = v;
		},
		wrongArtifact() {
			wrongArtifact = true;
		},
		missingProof() {
			missingProof = true;
		},
		finishCancel(v: boolean) {
			finishCancel = v;
		},
	};
}

test("delivery is encrypted to only the worker and bound to identity, signer, start marker and expiry", () => {
	let now = 1_000_000;
	const envelope = sealDelivery({
		jitConfig: "credential-base64",
		container,
		identity,
		workerPublicKey: worker.publicKey,
		signingPrivateKey: signing.privateKey,
		notAfter: now + 60000,
		clock: () => now,
	});
	assert(!JSON.stringify(envelope).includes("credential-base64"));
	assert.equal(
		openDelivery({
			envelope,
			identity,
			workerPrivateKey: worker.privateKey,
			signingPublicKey: signing.publicKey,
			clock: () => now,
		}).jitConfig,
		"credential-base64",
	);
	assert.throws(
		() =>
			openDelivery({
				envelope,
				identity: { ...identity, runAttempt: 2 },
				workerPrivateKey: worker.privateKey,
				signingPublicKey: signing.publicKey,
				clock: () => now,
			}),
		/identity/,
	);
	assert.throws(
		() =>
			openDelivery({
				envelope,
				identity,
				workerPrivateKey: worker.privateKey,
				signingPublicKey: foreign.publicKey,
				clock: () => now,
			}),
		/signature/,
	);
	assert.throws(
		() =>
			openDelivery({
				envelope: { ...envelope, ciphertext: "AA" },
				identity,
				workerPrivateKey: worker.privateKey,
				signingPublicKey: signing.publicKey,
				clock: () => now,
			}),
		/signature/,
	);
	const start = signStart({
		envelope,
		identity,
		signingPrivateKey: signing.privateKey,
		notAfter: now + 50000,
		clock: () => now,
	});
	assert(
		verifyStart({
			start,
			envelope,
			identity,
			signingPublicKey: signing.publicKey,
			clock: () => now,
		}),
	);
	now += 60001;
	assert.throws(
		() =>
			openDelivery({
				envelope,
				identity,
				workerPrivateKey: worker.privateKey,
				signingPublicKey: signing.publicKey,
				clock: () => now,
			}),
		/expired/,
	);
});

test("delivery refuses additional environment, host paths, wrong user and overlong validity", () => {
	const input = {
		jitConfig: "credential",
		container,
		identity,
		workerPublicKey: worker.publicKey,
		signingPrivateKey: signing.privateKey,
		notAfter: 1060000,
		clock: () => 1000000,
	};
	assert.throws(
		() =>
			sealDelivery({
				...input,
				container: {
					...container,
					env: { ...container.env, GH_TOKEN: "secret" },
				},
			}),
		/Unrecognized|envelope/,
	);
	assert.throws(
		() =>
			sealDelivery({ ...input, container: { ...container, runAsUser: "0:0" } }),
		/Invalid|container/,
	);
	assert.throws(() => sealDelivery({ ...input, notAfter: 2000000 }), /expired/);
});

test("native VM lifecycle dispatches once, gates exact image proof, sends only encrypted JIT and exact start", async (t) => {
	const f = fixture(t);
	const handle = await f.driver.create(f.spec);
	assert.match(handle.containerId, /^[0-9a-f]{64}$/);
	await f.driver.start(name, handle.containerId);
	const dispatch = WorkflowDispatchSchema.parse(
		JSON.parse(
			present(
				present(f.calls.find((c) => c.path.endsWith("/dispatches"))).body,
			),
		),
	);
	assert.equal(dispatch.inputs.role, "worker");
	assert.equal(dispatch.inputs.lease_id, leaseId);
	assert.equal(dispatch.inputs.image_ref, f.options.imageRef);
	assert.equal(dispatch.inputs.timeout_minutes, "30");
	assert(!JSON.stringify(dispatch).includes("/private/local"));
	await f.driver.writeSecret(
		name,
		handle.containerId,
		"/tmp/hobo-ci-jit",
		"one-use-jit",
	);
	await f.driver.execDetached(name, handle.containerId, expectedStartArgv);
	assert.equal(f.deliveries.length, 2);
	assert(!JSON.stringify(f.deliveries).includes("one-use-jit"));
	assert(!JSON.stringify(f.deliveries).includes("/private/local"));
	const value = openDelivery({
		envelope: DeliveryEnvelopeSchema.parse(item(f.deliveries, 0).value),
		identity,
		workerPrivateKey: worker.privateKey,
		signingPublicKey: signing.publicKey,
		clock: f.clock,
	});
	assert.equal(value.jitConfig, "one-use-jit");
	assert.deepEqual(value.container, container);
	assert(
		verifyStart({
			start: item(f.deliveries, 1).value,
			envelope: DeliveryEnvelopeSchema.parse(item(f.deliveries, 0).value),
			identity,
			signingPublicKey: signing.publicKey,
			clock: f.clock,
		}),
	);
	assert(await f.driver.isRunning(name, handle.containerId));
	assert.equal(
		await f.driver.exists(
			name,
			handle.containerId,
			"/tmp/hobo-ci-runner-exited",
		),
		false,
	);
	f.complete();
	assert(await f.driver.isRunning(name, handle.containerId));
	assert.equal(
		await f.driver.exists(
			name,
			handle.containerId,
			"/tmp/hobo-ci-runner-exited",
		),
		true,
	);
	f.run.status = "completed";
	f.run.conclusion = "success";
	assert.deepEqual(await f.driver.exitState(name, handle.containerId), {
		exitCode: 0,
		oomKilled: false,
	});
	await f.driver.remove(name, handle.containerId);
	assert.deepEqual(await f.driver.list("hobo.ci/isolated=1"), []);
});

test("lost dispatch acknowledgement persists intent and restart never dispatches a second VM", async (t) => {
	const f = fixture(t);
	f.failDispatch();
	await assert.rejects(f.driver.create(f.spec), /lost acknowledgement/);
	assert.equal(f.calls.filter((c) => c.path.endsWith("/dispatches")).length, 1);
	const restarted = createGithubVmDockerDriver(f.options);
	const handle = await restarted.create(f.spec);
	assert(handle.containerId);
	assert.equal(f.calls.filter((c) => c.path.endsWith("/dispatches")).length, 1);
});

test("lost delivery acknowledgement reuses identical envelope and refuses replacement JIT", async (t) => {
	const f = fixture(t);
	const h = await f.driver.create(f.spec);
	f.failPublish();
	await assert.rejects(
		f.driver.writeSecret(name, h.containerId, "/tmp/hobo-ci-jit", "first-jit"),
		/acknowledgement/,
	);
	f.failPublish(false);
	await f.driver.writeSecret(
		name,
		h.containerId,
		"/tmp/hobo-ci-jit",
		"first-jit",
	);
	assert.deepEqual(item(f.deliveries, 0), item(f.deliveries, 1));
	await assert.rejects(
		f.driver.writeSecret(
			name,
			h.containerId,
			"/tmp/hobo-ci-jit",
			"replacement-jit",
		),
		/different JIT/,
	);
	assert(!readFileSync(f.stateFile, "utf8").includes("first-jit"));
});

test("wrong source or independently failed preflight cannot lead to JIT delivery", async (t) => {
	const f = fixture(t);
	f.wrongArtifact();
	await assert.rejects(f.driver.create(f.spec), /artifact identity/);
	assert.equal(f.deliveries.length, 0);
	const g = fixture(t);
	g.ready.preflight.imageId = "sha256:" + "0".repeat(64);
	await assert.rejects(g.driver.create(g.spec), /image preflight/);
	assert.equal(g.deliveries.length, 0);
});

test("unknown or expired local budget lease prevents credential publication", async (t) => {
	const f = fixture(t, { deadlineForLease: async () => undefined });
	const h = await f.driver.create(f.spec);
	await assert.rejects(
		f.driver.writeSecret(name, h.containerId, "/tmp/hobo-ci-jit", "credential"),
		/unknown local VM lease/,
	);
	assert.equal(f.deliveries.length, 0);
	const g = fixture(t, {
		deadlineForLease: async () => new Date(900000).toISOString(),
	});
	const j = await g.driver.create(g.spec);
	await assert.rejects(
		g.driver.writeSecret(name, j.containerId, "/tmp/hobo-ci-jit", "credential"),
		/expired/,
	);
	assert.equal(g.deliveries.length, 0);
});

test("native success without completion artifact remains unknown and arbitrary commands are refused", async (t) => {
	const f = fixture(t);
	const h = await f.driver.create(f.spec);
	await assert.rejects(
		f.driver.exec(name, h.containerId, ["sh", "-c", "do something"]),
		/unsupported worker/,
	);
	f.run.status = "completed";
	f.run.conclusion = "success";
	f.missingProof();
	await assert.rejects(
		f.driver.exitState(name, h.containerId),
		/proof unavailable/,
	);
	await assert.rejects(
		f.driver.exists(name, h.containerId, "/tmp/hobo-ci-runner-exited"),
		/proof unavailable/,
	);
});

test("cancel acknowledgement does not confirm cleanup until native run completes", async (t) => {
	const f = fixture(t);
	const h = await f.driver.create(f.spec);
	f.finishCancel(false);
	await assert.rejects(
		f.driver.stop(name, h.containerId),
		/cancellation unconfirmed/,
	);
	await assert.rejects(
		f.driver.remove(name, h.containerId),
		/cleanup unconfirmed/,
	);
	f.finishCancel(true);
	await f.driver.stop(name, h.containerId);
	await f.driver.remove(name, h.containerId);
	assert.deepEqual(await f.driver.list("hobo.ci/isolated=1"), []);
});

test("capture helper never starts a process and exact shipped argv may be supplied", async () => {
	let secretWrites = 0;
	const captured = await captureRunnerStartArgv(
		async (docker, name, id, credential) => {
			await docker.writeSecret(name, id, "/tmp/hobo-ci-jit", credential);
			secretWrites++;
			await docker.execDetached(name, id, expectedStartArgv);
		},
	);
	assert.deepEqual(captured, expectedStartArgv);
	assert.equal(secretWrites, 1);
});

test("remote memory cap and duplicate native identities refuse dispatch or further effects", async (t) => {
	const f = fixture(t);
	const memoryMb = 8192;
	await assert.rejects(
		f.driver.create({
			...f.spec,
			memoryMb,
			env: { ...f.spec.env, HOBO_CI_JOB_MEMORY_MB: String(memoryMb) },
		}),
		/memory limit/,
	);
	assert.equal(f.calls.length, 0);
	const g = fixture(t);
	const original = g.options.github.request;
	g.options.github.request = async (...args) =>
		args[1].includes("/actions/workflows/99/runs?")
			? response(200, { workflow_runs: [g.run, { ...g.run, id: 102 }] })
			: original(...args);
	await assert.rejects(g.driver.create(g.spec), /ambiguous duplicate/);
	assert.equal(g.deliveries.length, 0);
});

test("zero-price bootstrap refuses private or wrong repository before any dispatch", async (t) => {
	for (const repo of [
		{ id: 1274791462, full_name: "Hobo-Labs/HoBo", private: true },
		{ id: 2, full_name: "Hobo-Labs/HoBo", private: false },
	]) {
		const f = fixture(t);
		const original = f.options.github.request;
		f.options.github.request = async (...args) =>
			args[1] === "/repos/Hobo-Labs/HoBo"
				? response(200, repo)
				: original(...args);
		await assert.rejects(f.driver.create(f.spec), /verified public repository/);
		assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
	}
});

test("historical completed worker cleans up after manual rerun without cancelling its replacement", async (t) => {
	const f = fixture(t);
	const h = await f.driver.create(f.spec);
	f.run.status = "completed";
	f.run.conclusion = "success";
	const replacement: NativeRun = {
		...f.run,
		run_attempt: 2,
		status: "in_progress",
		conclusion: null,
	};
	const original = f.options.github.request;
	f.options.github.request = async (...args) =>
		args[1] === "/repos/Hobo-Labs/HoBo/actions/runs/101"
			? response(200, replacement)
			: original(...args);
	assert.equal(await f.driver.isRunning(name, h.containerId), false);
	assert.deepEqual(await f.driver.exitState(name, h.containerId), {
		exitCode: 0,
		oomKilled: false,
	});
	await f.driver.stop(name, h.containerId);
	await f.driver.remove(name, h.containerId);
	assert.equal(f.calls.filter((c) => c.path.endsWith("/cancel")).length, 0);
	assert(f.calls.some((c) => c.path.endsWith("/attempts/1")));
	assert.deepEqual(await f.driver.list("hobo.ci/isolated=1"), []);
});

test("inconsistent replacement attempt refuses run-level cancellation", async (t) => {
	const f = fixture(t);
	const h = await f.driver.create(f.spec);
	const replacement: NativeRun = { ...f.run, run_attempt: 2 };
	const original = f.options.github.request;
	f.options.github.request = async (...args) =>
		args[1] === "/repos/Hobo-Labs/HoBo/actions/runs/101"
			? response(200, replacement)
			: original(...args);
	await assert.rejects(f.driver.stop(name, h.containerId), /attempt changed/);
	assert.equal(f.calls.filter((c) => c.path.endsWith("/cancel")).length, 0);
});
