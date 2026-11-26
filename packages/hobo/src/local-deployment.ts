import { fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import type { CommandModule } from "@hobo/cli";
import { collectStream } from "@hobo/cloud";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import {
	type LocalDeploymentLaunch,
	LocalDeploymentLaunchSchema,
	LocalDeploymentLifecycleEventSchema,
	type LocalDeploymentReceipt,
	LocalDeploymentReceiptSchema,
} from "./_generated/composition_pb.js";
import { isJsonObject, isJsonString } from "./json.js";
import { fingerprintLocalDeployment } from "./local-deployment-fingerprint.js";
import { acquireLocalDeploymentLock } from "./local-deployment-lock.js";

const RECEIPT_FILE = "local-deployment.json";
const TOKEN_FILE = "local-deployment.token";
// public-contract: persistent local deployment receipt schema shared by worker and control client.
export const LOCAL_DEPLOYMENT_SCHEMA = "hobo.local-deployment/v1";

function directory(projectDir: string) {
	return join(resolve(projectDir), ".hobo");
}

async function atomicPrivateFile(path: string, value: string) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function readLocalDeployment(
	projectDir: string,
): Promise<LocalDeploymentReceipt | undefined> {
	const path = join(directory(projectDir), RECEIPT_FILE);
	if (!existsSync(path)) return undefined;
	const receipt = fromJson(
		LocalDeploymentReceiptSchema,
		JSON.parse(await readFile(path, "utf8")),
	);
	const control = new URL(receipt.controlUrl);
	if (
		receipt.schemaVersion !== LOCAL_DEPLOYMENT_SCHEMA ||
		receipt.projectDir !== resolve(projectDir) ||
		!receipt.leaseId ||
		receipt.pid <= 0 ||
		control.protocol !== "http:" ||
		control.hostname !== "127.0.0.1" ||
		control.pathname !== `/lease/${receipt.leaseId}` ||
		control.username ||
		control.password ||
		control.search ||
		control.hash
	)
		throw new Error("Invalid local deployment receipt");
	return receipt;
}

async function controlRequest(
	receipt: LocalDeploymentReceipt,
	shutdown = false,
): Promise<void> {
	const token = await readFile(
		join(directory(receipt.projectDir), TOKEN_FILE),
		"utf8",
	);
	const response = await fetch(
		`${receipt.controlUrl}${shutdown ? "/shutdown" : ""}`,
		{
			method: shutdown ? "POST" : "GET",
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (!response.ok)
		throw new Error(
			`Local deployment control failed (HTTP ${response.status})`,
		);
	const body: unknown = await response.json();
	if (
		!isJsonObject(body) ||
		body.leaseId !== receipt.leaseId ||
		body.pid !== receipt.pid ||
		body.primaryUrl !== receipt.primaryUrl ||
		body.projectDir !== receipt.projectDir
	)
		throw new Error(
			"Local deployment control identity did not match its receipt",
		);
}

export async function recordLocalDeployment(
	receipt: LocalDeploymentReceipt,
	event: "deployment.LocalStarted" | "deployment.LocalStopped",
	reason: string,
) {
	const store = createRuntimeLocalEventStore({
		dataDir: join(directory(receipt.projectDir), "local-deployment-events"),
	});
	try {
		const stream = `local:${createHash("sha256").update(receipt.projectDir).digest("hex")}`;
		const history = await collectStream(store, stream);
		const value = toJson(
			LocalDeploymentLifecycleEventSchema,
			create(LocalDeploymentLifecycleEventSchema, { receipt, reason }),
		);
		if (!isJsonObject(value))
			throw new Error("Local deployment receipt serialization failed");
		await store.append(stream, [{ type: event, data: value }], {
			expectedSeq: history.at(-1)?.seq ?? 0,
			actor: { kind: "service", id: "hobo.local-deployment" },
			tenant: "local",
		});
	} finally {
		store.close();
	}
}

export async function clearLocalDeployment(
	receipt: LocalDeploymentReceipt,
	reason: string,
) {
	const current = await readLocalDeployment(receipt.projectDir);
	if (current?.leaseId !== receipt.leaseId) return;
	await recordLocalDeployment(receipt, "deployment.LocalStopped", reason);
	await rm(join(directory(receipt.projectDir), RECEIPT_FILE), { force: true });
	await rm(join(directory(receipt.projectDir), TOKEN_FILE), { force: true });
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH")
			return false;
		throw error;
	}
}

export async function startLocalDeployment(
	input: Omit<
		LocalDeploymentLaunch,
		"$typeName" | "$unknown" | "leaseId" | "contentFingerprint"
	>,
): Promise<{ receipt: LocalDeploymentReceipt; reused: boolean }> {
	const projectDir = resolve(input.projectDir);
	const dir = directory(projectDir);
	await mkdir(dir, { recursive: true });
	const releaseLock = acquireLocalDeploymentLock(dir);
	try {
		const contentFingerprint = await fingerprintLocalDeployment(
			projectDir,
			input.hoboHome,
		);
		const existing = await readLocalDeployment(projectDir);
		if (existing) {
			let healthy = false;
			try {
				await controlRequest(existing);
				healthy = true;
			} catch (error) {
				if (processAlive(existing.pid)) throw error;
				await clearLocalDeployment(existing, "process-exited");
			}
			if (healthy) {
				const bindings = [
					"componentHost",
					"campId",
					"providerId",
					"brokerId",
					"bindleName",
				] as const;
				const changed = bindings.filter((key) => existing[key] !== input[key]);
				if (changed.length > 0 || existing.hoboHome !== resolve(input.hoboHome))
					throw new Error(
						`An existing deployment uses different placement bindings (${changed.length > 0 ? changed.join(", ") : "hoboHome"}); run hobo down before changing targets`,
					);
				if (input.ttlSeconds > 0 && !existing.expiresAt)
					throw new Error(
						"An existing permanent deployment must be stopped before requesting a temporary lease",
					);
				if (existing.contentFingerprint === contentFingerprint)
					return { receipt: existing, reused: true };
				await controlRequest(existing, true);
			}
		}
		const token = randomBytes(32).toString("base64url");
		const config = create(LocalDeploymentLaunchSchema, {
			...input,
			projectDir,
			hoboHome: resolve(input.hoboHome),
			leaseId: randomUUID(),
			contentFingerprint,
		});
		const js = new URL("./local-deployment-worker.js", import.meta.url);
		const worker = existsSync(fileURLToPath(js))
			? js
			: new URL("./local-deployment-worker.ts", import.meta.url);
		const child = fork(worker, [], {
			cwd: projectDir,
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			execArgv: ["--import", import.meta.resolve("tsx")],
			env: { ...process.env, HOBO_LOCAL_CONTROL_TOKEN: token },
		});
		try {
			const receipt = await new Promise<LocalDeploymentReceipt>(
				(resolveReady, reject) => {
					const timer = setTimeout(
						() =>
							reject(
								new Error(
									"Local deployment did not become ready before the startup deadline",
								),
							),
						120_000,
					);
					const finish = () => clearTimeout(timer);
					child.once("error", (error) => {
						finish();
						reject(error);
					});
					child.once("exit", (code, signal) => {
						finish();
						reject(
							new Error(
								`Local deployment exited before readiness (${code ?? signal})`,
							),
						);
					});
					child.on("message", (message) => {
						if (!isJsonObject(message)) return;
						if (message.type === "error") {
							finish();
							reject(
								new Error(
									isJsonString(message.message)
										? message.message
										: "Local deployment failed",
								),
							);
							return;
						}
						if (message.type !== "ready" || !isJsonObject(message.receipt))
							return;
						try {
							const result = fromJson(
								LocalDeploymentReceiptSchema,
								message.receipt,
							);
							if (
								result.leaseId !== config.leaseId ||
								result.pid !== child.pid ||
								result.projectDir !== projectDir ||
								result.contentFingerprint !== contentFingerprint
							)
								throw new Error("Worker readiness identity mismatch");
							finish();
							resolveReady(result);
						} catch (error) {
							finish();
							reject(error);
						}
					});
					child.send({
						type: "start",
						launch: toJson(LocalDeploymentLaunchSchema, config),
					});
				},
			);
			await atomicPrivateFile(join(dir, TOKEN_FILE), token);
			await atomicPrivateFile(
				join(dir, RECEIPT_FILE),
				JSON.stringify(toJson(LocalDeploymentReceiptSchema, receipt)),
			);
			await recordLocalDeployment(receipt, "deployment.LocalStarted", "up");
			await controlRequest(receipt);
			child.send({ type: "committed" });
			child.disconnect();
			child.unref();
			return { receipt, reused: false };
		} catch (error) {
			child.kill("SIGTERM");
			throw error;
		}
	} finally {
		releaseLock();
	}
}

export function createLocalDeploymentDownCommand(
	fallback?: CommandModule,
): CommandModule {
	return {
		implemented: true,
		async run(input) {
			const projectDir = input.context.projectDir ?? input.context.cwd;
			const receipt = await readLocalDeployment(projectDir);
			if (!receipt)
				return fallback
					? fallback.run(input)
					: {
							ok: true,
							status: "not_deployed",
							code: "HOBO_OK",
							message: "No local deployment is running",
							data: { command: "down" },
						};
			// `down --what-if`: name what would stop, stop nothing.
			if (input.flags.whatIf)
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `hobo down --what-if would stop local deployment ${receipt.bindleName}`,
					data: {
						command: "down",
						whatIf: true,
						deploymentId: receipt.leaseId,
						wouldDestroy: [receipt.bindleName],
					},
				};
			try {
				await controlRequest(receipt, true);
			} catch (error) {
				if (processAlive(receipt.pid)) throw error;
				await clearLocalDeployment(receipt, "process-exited");
			}
			return {
				ok: true,
				status: "destroyed",
				code: "HOBO_OK",
				message: `Stopped local deployment ${receipt.bindleName}`,
				data: {
					command: "down",
					deploymentId: receipt.leaseId,
					primaryUrl: receipt.primaryUrl,
				},
			};
		},
	};
}
