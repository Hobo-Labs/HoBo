import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	ContentsFileSchema,
	type MailboxDocument,
	MailboxDocumentSchema,
} from "./artifact-contracts.mts";
import {
	DeliveryEnvelopeSchema,
	openDelivery,
	StartEnvelopeSchema,
	validateContainer,
	verifyStart,
	WorkerIdentitySchema,
} from "./vm-delivery.mts";

const repository = "Hobo-Labs/HoBo";
function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}
const leaseId = required("HOBO_BOOTSTRAP_LEASE_ID");
const imageRef = required("HOBO_BOOTSTRAP_IMAGE_REF");
const controlBranch = required("HOBO_BOOTSTRAP_CONTROL_BRANCH");
const signingPublicKey = Buffer.from(
	required("HOBO_BOOTSTRAP_SIGNING_PUBLIC_KEY"),
	"base64",
).toString();
const runId = Number(required("GITHUB_RUN_ID"));
const runAttempt = Number(required("GITHUB_RUN_ATTEMPT"));
const sourceSha = required("GITHUB_SHA");
const lifetimeMs = Number(required("HOBO_BOOTSTRAP_LIFETIME_MS"));
const timeoutMinutes = Number(required("HOBO_BOOTSTRAP_TIMEOUT_MINUTES"));
if (
	process.env.GITHUB_REPOSITORY !== repository ||
	process.env.GITHUB_REPOSITORY_ID !== "1274791462" ||
	!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
		leaseId,
	) ||
	!/^ttl\.sh\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(imageRef) ||
	!/^ops\/ci-runner-mailbox-5636332-[a-f0-9]{8}$/.test(controlBranch) ||
	!/^[a-f0-9]{40}$/.test(sourceSha) ||
	!Number.isSafeInteger(runId) ||
	runId <= 0 ||
	!Number.isSafeInteger(runAttempt) ||
	runAttempt <= 0 ||
	!Number.isSafeInteger(lifetimeMs) ||
	lifetimeMs < 60000 ||
	lifetimeMs > 2400000 ||
	!Number.isInteger(timeoutMinutes) ||
	timeoutMinutes !== Math.ceil(lifetimeMs / 60000)
)
	throw new Error("invalid fixed worker identity");
const imageDigest = imageRef.slice(imageRef.indexOf("@") + 1);
const identity = WorkerIdentitySchema.parse({
	repositoryId: 1274791462,
	leaseId,
	runId,
	runAttempt,
	sourceSha,
	imageDigest,
});
const WorkerStateSchema = z.strictObject({
	identity: WorkerIdentitySchema,
	deadline: z.number().int().positive(),
});
const DockerImageSchema = z.object({
	Id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
	Architecture: z.literal("amd64"),
	Config: z.object({ User: z.literal("1000:1000") }),
});
const DockerExitSchema = z.object({
	State: z.object({ OOMKilled: z.boolean() }),
});
const privateDirectory = join(
	required("RUNNER_TEMP"),
	`hobo-bootstrap-${leaseId}`,
);
const publicDirectory = join(
	required("GITHUB_WORKSPACE"),
	".hobo-bootstrap-public",
);
const statePath = join(privateDirectory, "state.json");
const keyPath = join(privateDirectory, "worker-key.pem");
const containerName = `hobo-${leaseId}`;

function execute(
	command: string,
	args: string[],
	stdin?: string,
	capture = false,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		child.stderr.pipe(process.stderr);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (capture) {
				output += chunk.toString();
				if (output.length > 1048576) child.kill("SIGKILL");
			} else process.stdout.write(chunk);
		});
		child.once("error", () => reject(new Error("worker command failed")));
		child.once("close", (code) =>
			code === 0 ? resolve(output) : reject(new Error("worker command failed")),
		);
		child.stdin.end(stdin);
	});
}

async function prepare(): Promise<void> {
	await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
	await mkdir(publicDirectory, { recursive: true, mode: 0o755 });
	const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
	await writeFile(
		keyPath,
		keys.privateKey.export({ type: "pkcs8", format: "pem" }),
		{ mode: 0o600 },
	);
	await writeFile(
		statePath,
		JSON.stringify({ identity, deadline: Date.now() + lifetimeMs }),
		{ mode: 0o600 },
	);
	await execute("docker", ["pull", imageRef]);
	const [image] = z
		.tuple([DockerImageSchema])
		.parse(
			JSON.parse(
				await execute(
					"docker",
					["image", "inspect", imageRef],
					undefined,
					true,
				),
			),
		);
	await execute("docker", ["tag", image.Id, "hobo-ci-worker:local"]);
	const imageVersion = (
		await execute(
			"node",
			["--experimental-strip-types", "scripts/ci-runner-image-version.mts"],
			undefined,
			true,
		)
	).trim();
	if (!/^v[a-f0-9]{12}$/.test(imageVersion))
		throw new Error("invalid pinned image version");
	await execute("docker", ["tag", image.Id, `hobo-ci-worker:${imageVersion}`]);
	await execute("docker", [
		"run",
		"--rm",
		"--network",
		"none",
		"-e",
		"HOBO_CI_RUNNER_CONTRACT=live",
		"--mount",
		`type=bind,src=${required("GITHUB_WORKSPACE")},dst=/tmp/contract,readonly`,
		"-w",
		"/tmp/contract",
		imageRef,
		"node",
		"--no-warnings",
		"scripts/ci-runner-preflight.mts",
	]);
	await writeFile(
		join(publicDirectory, "ready.json"),
		JSON.stringify({
			version: 1,
			kind: "hobo-worker-ready",
			...identity,
			publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
			preflight: { ok: true, imageId: image.Id, architecture: "x64" },
		}),
		{ mode: 0o644 },
	);
	console.log("Pinned worker image passed the live runner contract.");
}

class RetryableMailboxError extends Error {}

async function readMailbox(path: string): Promise<MailboxDocument | undefined> {
	const url = `https://api.github.com/repos/${repository}/contents/${path}?ref=${encodeURIComponent(controlBranch)}`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${required("GITHUB_TOKEN")}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		throw new RetryableMailboxError("worker mailbox transport unavailable");
	}
	if (response.status === 404) return undefined;
	if (
		response.status === 429 ||
		response.status >= 500 ||
		(response.status === 403 &&
			response.headers.get("x-ratelimit-remaining") === "0")
	)
		throw new RetryableMailboxError("worker mailbox temporarily unavailable");
	if (!response.ok)
		throw new Error(`worker mailbox read failed HTTP ${response.status}`);
	const result = ContentsFileSchema.parse(await response.json());
	if (result.size > 262144) throw new Error("invalid worker mailbox reply");
	return MailboxDocumentSchema.parse(
		JSON.parse(Buffer.from(result.content, "base64").toString()),
	);
}

async function run(): Promise<void> {
	const state = WorkerStateSchema.parse(
		JSON.parse(await readFile(statePath, "utf8")),
	);
	if (JSON.stringify(state.identity) !== JSON.stringify(identity))
		throw new Error("worker state changed");
	const clock = () => Date.now();
	const pause = () => new Promise((resolve) => setTimeout(resolve, 5000));
	let envelope: MailboxDocument | undefined;
	while (clock() < state.deadline) {
		try {
			envelope = await readMailbox(`workers/${leaseId}/delivery.json`);
		} catch (error) {
			if (!(error instanceof RetryableMailboxError)) throw error;
		}
		if (envelope) break;
		await pause();
	}
	if (!envelope) throw new Error("worker delivery deadline expired");
	const delivery = openDelivery({
		envelope: DeliveryEnvelopeSchema.parse(envelope),
		identity,
		workerPrivateKey: await readFile(keyPath, "utf8"),
		signingPublicKey,
		clock,
	});
	let start: MailboxDocument | undefined;
	while (clock() < Math.min(state.deadline, delivery.notAfter)) {
		try {
			start = await readMailbox(`workers/${leaseId}/start.json`);
		} catch (error) {
			if (!(error instanceof RetryableMailboxError)) throw error;
		}
		if (start) break;
		await pause();
	}
	if (
		!start ||
		!verifyStart({
			start: StartEnvelopeSchema.parse(start),
			envelope: DeliveryEnvelopeSchema.parse(envelope),
			identity,
			signingPublicKey,
			clock,
		})
	)
		throw new Error("worker start was not authorized");
	const spec = validateContainer(delivery.container);
	const jobDirectory = join(required("RUNNER_TEMP"), `hobo-job-${leaseId}`);
	await mkdir(jobDirectory, { mode: 0o755 });
	await execute("sudo", ["chown", "1000:1000", jobDirectory]);
	const args = [
		"create",
		"--rm",
		"--init",
		"--name",
		containerName,
		"--user",
		"1000:1000",
		"--memory",
		`${spec.memoryMb}m`,
		"--memory-swap",
		`${spec.memoryMb}m`,
		"--mount",
		"type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
		"--mount",
		`type=bind,src=${jobDirectory},dst=/opt/actions-runner/_hobo_work`,
		"--group-add",
		(
			await execute(
				"stat",
				["-c", "%g", "/var/run/docker.sock"],
				undefined,
				true,
			)
		).trim(),
	];
	for (const [key, value] of Object.entries(spec.env)) {
		if (value.length > 16384) throw new Error("invalid worker environment");
		args.push("-e", `${key}=${value}`);
	}
	args.push("-e", `HOBO_CI_HOST_JOB_DIRECTORY=${jobDirectory}`);
	args.push(imageRef, "sleep", "infinity");
	let exitCode = 1;
	let runnerExited = false;
	let created = false;
	let terminationEvidenceMissing = false;
	try {
		await execute("docker", args);
		created = true;
		await execute("docker", ["start", containerName]);
		await execute(
			"docker",
			[
				"exec",
				"-i",
				containerName,
				"sh",
				"-ec",
				"umask 077; cat > /tmp/hobo-ci-jit",
			],
			delivery.jitConfig,
		);
		await rm(keyPath, { force: true });
		await execute("docker", [
			"exec",
			containerName,
			"sh",
			"-ec",
			'cd /opt/actions-runner; ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat /tmp/hobo-ci-jit)"; rm -f /tmp/hobo-ci-jit; export ACTIONS_RUNNER_INPUT_JITCONFIG; ./run.sh',
		]);
		runnerExited = true;
		exitCode = 0;
	} finally {
		let oomKilled: boolean | undefined;
		if (created) {
			try {
				const [inspected] = z
					.tuple([DockerExitSchema])
					.parse(
						JSON.parse(
							await execute(
								"docker",
								["inspect", containerName],
								undefined,
								true,
							),
						),
					);
				oomKilled = inspected.State.OOMKilled;
			} catch {
				/* Cleanup still proceeds; absence of native termination evidence fails closed. */
			}
		}
		await execute("docker", ["rm", "-f", containerName]).catch(() => undefined);
		await rm(keyPath, { force: true });
		terminationEvidenceMissing = oomKilled === undefined;
		if (oomKilled !== undefined)
			await writeFile(
				join(publicDirectory, "complete.json"),
				JSON.stringify({
					version: 1,
					kind: "hobo-worker-complete",
					...identity,
					exitCode,
					oomKilled,
					runnerExited,
				}),
				{ mode: 0o644 },
			);
	}
	if (terminationEvidenceMissing)
		throw new Error("native worker termination evidence unavailable");
}

try {
	if (process.argv[2] === "prepare") await prepare();
	else if (process.argv[2] === "run") await run();
	else if (process.argv[2] === "idle") {
		const state = WorkerStateSchema.parse(
			JSON.parse(await readFile(statePath, "utf8")),
		);
		while (Date.now() < state.deadline)
			await new Promise((resolve) => setTimeout(resolve, 1000));
	} else throw new Error("unknown worker operation");
} catch (error) {
	console.error(
		error instanceof Error ? error.message : "worker bootstrap failed",
	);
	process.exitCode = 1;
}
