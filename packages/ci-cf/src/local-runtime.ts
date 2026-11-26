import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
	type FileHandle,
	mkdir,
	open,
	readFile,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	createArtifact,
	type PipelineResult,
	PipelineResultSchema,
	parsePipeline,
} from "@hobo/ci/execution";
import {
	LocalHealthSchema,
	LocalNativeStatusSchema,
	type LocalPreparation,
	LocalRunEventSchema,
	type LocalRunReceipt,
	LocalRunReceiptSchema,
	LocalRunStateSchema,
} from "./_generated/readiness_pb.js";
import { localParams, localWorkerName } from "./local-config.js";
import {
	atomicText,
	CI_CF_ROOT,
	readPreparation,
	sha256,
} from "./local-preparation.js";
import { initialLocalState, transitionLocalRun } from "./local-state.js";

const WRANGLER = fileURLToPath(
	new URL("../bin/wrangler.js", import.meta.resolve("wrangler")),
);
const PROXY_ROOT = join(CI_CF_ROOT, "containers/proxy");

function docker(args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const result = spawnSync("docker", args, {
		env,
		encoding: "utf8",
		timeout: 15000,
		maxBuffer: 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`local Docker operation failed: ${result.stderr.trim().slice(0, 1000)}`,
		);
	return result.stdout.trim();
}

export async function freeLocalPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || !(address instanceof Object))
		throw new Error("could not reserve local port");
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

export async function checkedProcess(
	command: string,
	args: string[],
	log: string,
	env: NodeJS.ProcessEnv = process.env,
	timeout = 300000,
	signal?: AbortSignal,
): Promise<void> {
	const fd = openSync(log, "a", 0o600);
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(command, args, {
				env,
				stdio: ["ignore", fd, fd],
				timeout,
				signal,
			});
			child.once("error", reject);
			child.once("exit", (code, signal) =>
				code === 0
					? resolve()
					: reject(
							new Error(`${command} exited ${code ?? signal}; inspect ${log}`),
						),
			);
		});
	} finally {
		closeSync(fd);
	}
}

export async function localRuntimeEnvironment(
	directory: string,
	signal?: AbortSignal,
	selectedHost?: string,
): Promise<NodeJS.ProcessEnv> {
	const endpoint =
		selectedHost ??
		(process.env.DOCKER_CONTEXT ? undefined : process.env.DOCKER_HOST) ??
		docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
	if (process.platform !== "linux" || !endpoint.startsWith("unix://"))
		throw new Error(
			"local CI requires Linux or WSL with a local Unix Docker socket; remote engines are refused",
		);
	const env = { ...process.env, DOCKER_HOST: endpoint, DOCKER_CONTEXT: "" };
	docker(["info", "--format", "{{.ServerVersion}}"], env);
	const image = `hobo-ci-proxy:${sha256((await readFile(join(PROXY_ROOT, "Dockerfile"), "utf8")) + (await readFile(join(PROXY_ROOT, "iptables-compat.sh"), "utf8"))).slice(0, 24)}`;
	const inspect = spawnSync("docker", ["image", "inspect", image], {
		env,
		stdio: "ignore",
		timeout: 15000,
	});
	if (inspect.status !== 0)
		await checkedProcess(
			"docker",
			["build", "-t", image, PROXY_ROOT],
			join(directory, "proxy-build.log"),
			env,
			300000,
			signal,
		);
	return {
		...env,
		WRANGLER_SEND_METRICS: "false",
		WRANGLER_DOCKER_BIN: join(PROXY_ROOT, "docker-local.sh"),
		HOBO_CI_DOCKER_BIN: "docker",
		HOBO_CI_PROXY_IMAGE: image,
		MINIFLARE_CONTAINER_EGRESS_IMAGE: image,
		WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
		XDG_CONFIG_HOME: join(directory, "config"),
	};
}

export function ownedContainers(
	preparationId: string,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const prefix = `workerd-${localWorkerName(preparationId)}-`;
	return docker(["ps", "-a", "--format", "{{.Names}}"], env)
		.split("\n")
		.filter((name) => name.startsWith(prefix));
}

async function stopOwnedContainers(
	preparationId: string,
	env: NodeJS.ProcessEnv,
): Promise<string[]> {
	const observed = new Set<string>();
	for (let attempt = 0; attempt < 3; attempt++) {
		for (const name of ownedContainers(preparationId, env)) {
			observed.add(name);
			docker(["rm", "-f", name], env);
		}
		await delay(150);
	}
	if (ownedContainers(preparationId, env).length)
		throw new Error("owned containers remain after shutdown");
	return [...observed];
}

function liveGroup(pid: number): boolean {
	const result = spawnSync("ps", ["-eo", "pgid=,stat="], {
		encoding: "utf8",
		timeout: 5000,
	});
	if (result.error || result.status !== 0)
		throw new Error("cannot verify runtime process shutdown");
	return result.stdout.split("\n").some((line) => {
		const [group, state] = line.trim().split(/\s+/);
		return Number(group) === pid && !state?.startsWith("Z");
	});
}

async function stopProcessGroup(pid: number): Promise<void> {
	try {
		process.kill(-pid, "SIGTERM");
	} catch (error) {
		if (!(error instanceof Error) || !isGone(error)) throw error;
		return;
	}
	for (let i = 0; i < 30; i++) {
		await delay(100);
		try {
			if (!liveGroup(pid)) return;
		} catch (error) {
			if (error instanceof Error && isGone(error)) return;
			throw error;
		}
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error) || !isGone(error)) throw error;
	}
	for (let i = 0; i < 30; i++) {
		if (!liveGroup(pid)) return;
		await delay(100);
	}
	throw new Error("runtime processes remain after shutdown");
}

function isGone(error: Error): boolean {
	return error instanceof Error && "code" in error && error.code === "ESRCH";
}

export async function localRequest(
	directory: string,
	preparation: LocalPreparation,
	path: string,
	method = "GET",
): Promise<Response> {
	const token = (
		await readFile(join(directory, "access-token"), "utf8")
	).trim();
	return fetch(`http://127.0.0.1:${preparation.port}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}` },
		redirect: "error",
		signal: AbortSignal.timeout(5000),
	});
}

async function responseText(
	response: Response,
	max = 32 * 1024 * 1024,
): Promise<string> {
	if (!response.body) throw new Error("empty runtime response");
	const reader = response.body.getReader();
	let total = 0;
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > max) throw new Error("runtime response exceeds bound");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function verifyLocalResult(
	json: string,
	preparation: LocalPreparation,
): Promise<PipelineResult> {
	const pipeline = parsePipeline(preparation.pipelineJson);
	const result = fromJsonString(PipelineResultSchema, json);
	if (
		result.id !== pipeline.id ||
		result.backend !== "cf" ||
		!["succeeded", "failed", "cancelled", "timed_out", "uncertain"].includes(
			result.status,
		) ||
		result.steps.length > pipeline.steps.length
	)
		throw new Error("result does not match the admitted pipeline");
	let outputBytes = 0;
	for (const [index, step] of result.steps.entries()) {
		const size =
			new TextEncoder().encode(step.stdout).byteLength +
			new TextEncoder().encode(step.stderr).byteLength;
		outputBytes += size;
		if (size > 196608 || outputBytes > 2 * 1024 * 1024)
			throw new Error("invalid result output bound");
		if (
			step.id !== pipeline.steps[index]?.id ||
			step.exitCode < 0 ||
			step.exitCode > 255
		)
			throw new Error("invalid ordered step result");
		if (index < result.steps.length - 1 && step.exitCode !== 0)
			throw new Error("work continued after a failed command");
	}
	if (
		result.status === "succeeded" &&
		(result.steps.length !== pipeline.steps.length ||
			result.steps.some((step) => step.exitCode !== 0) ||
			result.artifacts.length !== pipeline.artifactPaths.length)
	)
		throw new Error("incomplete pipeline cannot pass");
	let artifactBytes = 0;
	for (const [index, artifact] of result.artifacts.entries()) {
		artifactBytes += artifact.data.byteLength;
		if (artifactBytes > 4 * 1024 * 1024)
			throw new Error("invalid aggregate artifact bound");
		const checked = await createArtifact(artifact.path, artifact.data);
		if (
			artifact.path !== pipeline.artifactPaths[index] ||
			checked.sha256 !== artifact.sha256
		)
			throw new Error("artifact integrity mismatch");
	}
	return result;
}

/** Owns one native runtime, stops admission before cleanup, and never treats a trigger as a passing check. */
export async function runLocal(
	directory: string,
	resumeId?: string,
	signal?: AbortSignal,
): Promise<LocalRunReceipt> {
	const preparation = await readPreparation(directory);
	const id = resumeId ?? randomUUID();
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid workflow ID");
	const receiptPath = join(directory, `run-${id}.json`);
	const old = resumeId
		? fromJsonString(LocalRunReceiptSchema, await readFile(receiptPath, "utf8"))
		: undefined;
	if (
		old &&
		(old.workflowId !== id ||
			old.preparationId !== preparation.id ||
			old.sourceSha !== preparation.sourceSha ||
			old.pipelineSha256 !== preparation.pipelineSha256)
	)
		throw new Error("resume inputs do not match original admission");
	if (old?.state?.phase === "finished" && old.state.shutdownConfirmed) {
		const saved = old.state;
		const rebuilt = transitionLocalRun(
			create(LocalRunStateSchema, {
				...saved,
				phase: "stopping",
				outcome: "",
				exitCode: 0,
				shutdownConfirmed: false,
			}),
			create(LocalRunEventSchema, {
				kind: saved.shutdownConfirmed ? "shutdown" : "shutdown_failed",
			}),
		);
		if (
			toJsonString(LocalRunStateSchema, rebuilt) !==
			toJsonString(LocalRunStateSchema, saved)
		)
			throw new Error("invalid finished receipt");
		if (saved.outcome === "succeeded") {
			const result = await verifyLocalResult(old.resultJson, preparation);
			if (result.status !== "succeeded")
				throw new Error("invalid success receipt");
		}
		const recordedEnv = {
			...process.env,
			DOCKER_CONTEXT: "",
			DOCKER_HOST: old.dockerHost,
		};
		assertDockerIdentity(recordedEnv, old.dockerId);
		if (ownedContainers(preparation.id, recordedEnv).length)
			throw new Error("finished receipt has surviving containers");
		return old;
	}
	const lock = await acquirePreparationLock(directory, id, resumeId);
	let state = initialLocalState();
	const receipt = create(LocalRunReceiptSchema, {
		workflowId: id,
		preparationId: preparation.id,
		sourceSha: preparation.sourceSha,
		pipelineSha256: preparation.pipelineSha256,
		startedAt: old?.startedAt || new Date().toISOString(),
		state,
	});
	let serverPid: number | undefined;
	let runtimeEnv: NodeJS.ProcessEnv = process.env;
	let processOwnershipVerified = !resumeId;
	const emit = async (kind: string, status = "") => {
		state = transitionLocalRun(
			state,
			create(LocalRunEventSchema, { kind, status }),
		);
		receipt.state = state;
		await atomicText(receiptPath, toJsonString(LocalRunReceiptSchema, receipt));
	};
	try {
		await atomicText(receiptPath, toJsonString(LocalRunReceiptSchema, receipt));
		signal?.throwIfAborted();
		const env = await localRuntimeEnvironment(
			directory,
			signal,
			old?.dockerHost || undefined,
		);
		runtimeEnv = env;
		receipt.dockerHost = env.DOCKER_HOST ?? "";
		receipt.dockerId = docker(["info", "--format", "{{.ID}}"], env);
		if (old?.dockerId && old.dockerId !== receipt.dockerId)
			throw new Error("original Docker daemon identity changed");
		await atomicText(receiptPath, toJsonString(LocalRunReceiptSchema, receipt));
		signal?.throwIfAborted();
		if (resumeId) {
			const stalePid = Number(
				await readFile(join(directory, "server.pid"), "utf8").catch((error) => {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
						return "0";
					throw error;
				}),
			);
			if (!Number.isSafeInteger(stalePid) || stalePid <= 1)
				throw new Error(
					"missing original runtime ownership record; cleanup cannot be confirmed",
				);
			if (stalePid > 1) {
				const command = await readFile(
					`/proc/${stalePid}/cmdline`,
					"utf8",
				).catch((error) => {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
						return "";
					throw error;
				});
				if (
					command &&
					(!command
						.split("\0")
						.includes(join(CI_CF_ROOT, "src/local-server.ts")) ||
						!command.split("\0").includes(directory))
				)
					throw new Error("stale process ownership cannot be verified");
				if (command) {
					serverPid = stalePid;
					await stopProcessGroup(stalePid);
				} else if (liveGroup(stalePid))
					throw new Error(
						"original runtime process group ownership cannot be verified",
					);
			}
			await stopOwnedContainers(preparation.id, env);
			processOwnershipVerified = true;
			throw new Error(
				"interrupted admission is uncertain; cleaned up without replaying commands; start a new run explicitly",
			);
		}
		const fd = openSync(join(directory, "runtime.log"), "a", 0o600);
		const server = spawn(
			process.execPath,
			["--import", "tsx", join(CI_CF_ROOT, "src/local-server.ts"), directory],
			{ cwd: CI_CF_ROOT, env, detached: true, stdio: ["ignore", fd, fd] },
		);
		closeSync(fd);
		let startupError: Error | undefined;
		server.once("error", (error) => {
			startupError = error;
		});
		serverPid = server.pid;
		if (!serverPid) throw new Error("could not start local runtime");
		const startupDeadline = Date.now() + 180000;
		for (;;) {
			if (signal?.aborted) throw signal.reason;
			if (startupError) throw startupError;
			if (server.exitCode !== null || server.signalCode !== null)
				throw new Error(
					"native runtime exited during startup; inspect runtime.log",
				);
			try {
				const response = await localRequest(
					directory,
					preparation,
					"/__hobo/health",
				);
				if (response.ok) {
					const health = fromJsonString(
						LocalHealthSchema,
						await responseText(response, 65536),
					);
					if (
						health.preparationId !== preparation.id ||
						health.sourceSha !== preparation.sourceSha ||
						health.pipelineSha256 !== preparation.pipelineSha256
					)
						throw new Error("dev port belongs to another preparation");
					break;
				}
			} catch (error) {
				if (
					(error instanceof Error ? error.message : String(error)).includes(
						"another preparation",
					)
				)
					throw error;
			}
			if (Date.now() > startupDeadline)
				throw new Error("native runtime startup deadline exceeded");
			await delay(200);
		}
		await emit("ready");
		if (!resumeId) receipt.startedAt = new Date().toISOString();
		await emit("submitted");
		if (!resumeId)
			await checkedProcess(
				process.execPath,
				[
					WRANGLER,
					"workflows",
					"trigger",
					"hobo-ci-cf-local",
					"--local",
					"--port",
					String(preparation.port),
					"--id",
					id,
					"--params",
					JSON.stringify(localParams(preparation.sourceSha, preparation.id)),
					"--config",
					join(directory, "wrangler.jsonc"),
				],
				join(directory, "trigger.log"),
				env,
				15000,
			);
		const deadline =
			Date.parse(receipt.startedAt) +
			parsePipeline(preparation.pipelineJson).timeoutSeconds * 1000;
		for (;;) {
			if (signal?.aborted) {
				await emit("cancelled");
				break;
			}
			if (Date.now() > deadline) {
				await emit("timed_out");
				break;
			}
			const response = await localRequest(
				directory,
				preparation,
				`/__hobo/status/${id}`,
			);
			if (!response.ok) throw new Error("native status query failed");
			const native = fromJsonString(
				LocalNativeStatusSchema,
				await responseText(response, 65536),
			);
			if (["complete", "errored", "terminated"].includes(native.status)) {
				const resultResponse = await localRequest(
					directory,
					preparation,
					`/__hobo/results/${id}`,
				);
				if (resultResponse.ok) {
					const result = await verifyLocalResult(
						await responseText(resultResponse),
						preparation,
					);
					receipt.resultJson = toJsonString(PipelineResultSchema, result);
					await emit("result", result.status);
				}
				receipt.error = native.error;
				await emit("terminal", native.status);
				break;
			}
			await delay(200);
		}
	} catch (error) {
		receipt.error = error instanceof Error ? error.message : String(error);
		await emit(signal?.aborted ? "cancelled" : "fault");
	} finally {
		try {
			if (state.phase !== "stopping") await emit("fault");
			if (state.stopReason)
				await localRequest(
					directory,
					preparation,
					`/__hobo/cancel/${id}`,
					"POST",
				).catch(() => undefined);
			receipt.ownedContainers.push(
				...(await stopResources(
					serverPid,
					preparation.id,
					runtimeEnv,
					receipt.dockerId,
				)),
			);
			assertProcessOwnership(processOwnershipVerified);
			await exportArtifacts(directory, id, receipt.resultJson);
			await emit("shutdown");
		} catch (error) {
			receipt.error += `; cleanup: ${error instanceof Error ? error.message : String(error)}`;
			if (state.phase !== "finished") await emit("shutdown_failed");
		}
		receipt.finishedAt = new Date().toISOString();
		await atomicText(receiptPath, toJsonString(LocalRunReceiptSchema, receipt));
		await lock.close();
	}
	return receipt;
}

async function exportArtifacts(
	directory: string,
	id: string,
	json: string,
): Promise<void> {
	if (json) {
		const result = fromJsonString(PipelineResultSchema, json);
		const artifacts = join(directory, `artifacts-${id}`);
		for (const artifact of result.artifacts) {
			const path = join(artifacts, artifact.path);
			await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
			const existing = await readFile(path).catch((error) => {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return undefined;
				throw error;
			});
			if (existing && sha256(existing) !== artifact.sha256)
				throw new Error("exported artifact integrity mismatch");
			if (!existing)
				await writeFile(path, artifact.data, { flag: "wx", mode: 0o600 });
		}
	}
}

async function stopResources(
	pid: number | undefined,
	preparationId: string,
	env: NodeJS.ProcessEnv,
	expectedDockerId: string,
): Promise<string[]> {
	let processFailure: Error | undefined;
	try {
		if (pid) await stopProcessGroup(pid);
	} catch (error) {
		processFailure = new Error(
			error instanceof Error ? error.message : String(error),
		);
	}
	// Always attempt container cleanup, even if the process verifier failed.
	assertDockerIdentity(env, expectedDockerId);
	const containers = await stopOwnedContainers(preparationId, env);
	assertDockerIdentity(env, expectedDockerId);
	if (processFailure) throw processFailure;
	return containers;
}

function assertDockerIdentity(env: NodeJS.ProcessEnv, expected: string): void {
	if (
		!env.DOCKER_HOST?.startsWith("unix://") ||
		!expected ||
		docker(["info", "--format", "{{.ID}}"], env) !== expected
	)
		throw new Error("original local Docker daemon cannot be verified");
}

/** Linux flock stays attached to this open file description and releases on crash.
 * Never unlink the inode: doing so would allow a second independent lock. */
export async function acquirePreparationLock(
	directory: string,
	id: string,
	resumeId?: string,
): Promise<FileHandle> {
	const lock = await open(join(directory, "controller.lock"), "a+", 0o600);
	try {
		const result = spawnSync("flock", ["-n", "3"], {
			stdio: ["ignore", "ignore", "pipe", lock.fd],
			timeout: 5000,
		});
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error("another controller still owns this preparation");
		const previous = (await lock.readFile("utf8")).trim();
		if (previous && previous !== resumeId) {
			if (!/^[a-f0-9-]{36}$/.test(previous))
				throw new Error("invalid previous admission record");
			const prior = fromJsonString(
				LocalRunReceiptSchema,
				await readFile(join(directory, `run-${previous}.json`), "utf8"),
			);
			if (prior.state?.phase !== "finished" || !prior.state.shutdownConfirmed)
				throw new Error(
					`previous admission requires --resume ${previous}; refusing to repeat interrupted commands`,
				);
		}
		await lock.truncate(0);
		await lock.writeFile(id);
		await lock.sync();
		return lock;
	} catch (error) {
		await lock.close();
		throw error;
	}
}

function assertProcessOwnership(verified: boolean): void {
	if (!verified)
		throw new Error("original runtime process shutdown cannot be verified");
}
