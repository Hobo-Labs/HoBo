import { unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openAppKey, signControllerMetadata } from "./bootstrap-crypto.mts";
import { createContentsClient } from "./contents.mts";
import { createController } from "./controller.mts";
import { loadPreparedController, prepareController } from "./prepare.mts";
import { createRequestPump } from "./run-loop.mts";
import { verifyGithubApp } from "./verify-app.mts";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error("missing controller configuration");
	return value;
}
function config() {
	const runnerTemp = required("RUNNER_TEMP"),
		workspace = required("GITHUB_WORKSPACE"),
		runId = Number(required("GITHUB_RUN_ID")),
		runAttempt = Number(required("GITHUB_RUN_ATTEMPT")),
		sourceSha = required("GITHUB_SHA"),
		localPublicKeyBase64 = required("HOBO_BOOTSTRAP_SIGNING_PUBLIC_KEY");
	if (
		!isAbsolute(runnerTemp) ||
		!isAbsolute(workspace) ||
		process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
		process.env.GITHUB_REF !== "refs/heads/ops/ci-runner-bootstrap-5636332" ||
		process.env.GITHUB_REPOSITORY !== "Hobo-Labs/HoBo" ||
		Number(process.env.GITHUB_REPOSITORY_ID) !== 1274791462
	)
		throw new Error("invalid workflow identity");
	return {
		runnerTemp,
		workspace,
		runId,
		runAttempt,
		sourceSha,
		localPublicKeyBase64,
	};
}
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 2000));
async function run() {
	const cfg = config(),
		prepared = loadPreparedController(cfg),
		branch = required("HOBO_BOOTSTRAP_CONTROL_BRANCH"),
		token = required("GITHUB_TOKEN"),
		lifetime = Number(process.env.HOBO_BOOTSTRAP_LIFETIME_MS ?? "10800000");
	if (!Number.isInteger(lifetime) || lifetime < 1000 || lifetime > 10800000)
		throw new Error("invalid controller lifetime");
	const started = Date.now(),
		stopAt = started + lifetime,
		contents = createContentsClient({ token, branch, runId: cfg.runId });
	let appKey: Buffer | undefined;
	let controller: ReturnType<typeof createController> | undefined;
	try {
		let input: string | undefined;
		const bootstrapUntil = Math.min(stopAt, started + 600000);
		while (Date.now() < bootstrapUntil) {
			try {
				input = await contents.get("sealed-key");
			} catch {}
			if (input !== undefined) break;
			await delay();
		}
		if (input === undefined) throw new Error("sealed App key not received");
		appKey = openAppKey({
			envelope: JSON.parse(input),
			controllerPrivateKey: prepared.privateKey,
			localPublicKey: prepared.localPublicKey,
			expected: cfg,
		});
		const verified = await verifyGithubApp({ appPrivateKey: appKey });
		const signed = JSON.stringify(
			signControllerMetadata({
				...cfg,
				installationId: verified.installationId,
				localPublicKey: prepared.localPublicKey,
				controllerPrivateKey: prepared.privateKey,
			}),
		);
		let metadataPublished = false;
		while (Date.now() < stopAt && !metadataPublished) {
			try {
				await contents.publish("metadata", undefined, signed);
				metadataPublished = true;
			} catch {
				await delay();
			}
		}
		if (!metadataPublished) throw new Error("metadata publication failed");
		controller = createController({
			dbPath: join(prepared.root, "journal.sqlite"),
			appPrivateKey: appKey,
			controllerPrivateKey: prepared.privateKey,
			controllerPublicKey: prepared.publicKey,
			workerPublicKey: prepared.localPublicKey,
			installationId: verified.installationId,
			runId: cfg.runId,
			runAttempt: cfg.runAttempt,
			sourceSha: cfg.sourceSha,
			trustSignedLocalAuthority: true,
		});
		const pump = createRequestPump({ contents, controller });
		while (Date.now() < stopAt) {
			try {
				await pump.step();
			} catch {}
			await delay();
		}
	} finally {
		try {
			controller?.close();
		} finally {
			appKey?.fill(0);
			try {
				unlinkSync(join(prepared.root, "controller-private.pem"));
			} catch {}
		}
	}
}
const mode = process.argv[2];
try {
	if (mode === "prepare") prepareController(config());
	else if (mode === "run") await run();
	else throw new Error("invalid controller mode");
} catch {
	console.error("HoBo bootstrap controller could not complete");
	process.exitCode = 1;
}
