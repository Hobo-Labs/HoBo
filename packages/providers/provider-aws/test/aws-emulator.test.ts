/** Opt-in contract checks against the AWS-published AWS Emulator binary. */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type {
	HttpTransport,
	ResolveRequest,
	TransportRequest,
} from "@hobo/core";
import type { AwsCredentials } from "@hobo/core/aws-sigv4";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	AWS_DYNAMODB_PRODUCT_ID,
	AWS_S3_PRODUCT_ID,
	awsResolverRegistry,
} from "../src/index.js";

interface Startup {
	readonly endpoint_url: string;
	readonly ca_file: string;
}

function waitForStartup(child: ChildProcess): Promise<Startup> {
	return new Promise((resolve, reject) => {
		if (child.stdout === null) throw new Error("emulator stdout is missing");
		const lines = createInterface({ input: child.stdout });
		const timer = setTimeout(
			() => finish(new Error("AWS Emulator startup timed out")),
			30_000,
		);
		function finish(error?: Error, startup?: Startup) {
			clearTimeout(timer);
			lines.close();
			child.stdout?.resume();
			child.off("error", failed);
			child.off("exit", exited);
			if (error) reject(error);
			else if (startup) resolve(startup);
		}
		function failed(error: Error) {
			finish(error);
		}
		function exited(code: number | null) {
			finish(new Error(`AWS Emulator exited before startup (code ${code})`));
		}
		child.once("error", failed);
		child.once("exit", exited);
		lines.on("line", (line) => {
			try {
				const record: {
					fields?: {
						message?: string;
						endpoint_url?: string;
						ca_file?: string;
					};
				} = JSON.parse(line);
				const entry = record.fields;
				if (!entry) return;
				if (entry.message !== "emulator server information") return;
				if (!entry.endpoint_url || !entry.ca_file) {
					finish(new Error("AWS Emulator startup omitted endpoint or CA"));
					return;
				}
				finish(undefined, {
					endpoint_url: entry.endpoint_url,
					ca_file: entry.ca_file,
				});
			} catch {
				// Other log lines need not be JSON; only the startup record matters.
			}
		});
	});
}

function credentialsFromFile(contents: string): AwsCredentials {
	const id = /^aws_access_key_id\s*=\s*(\S+)\s*$/mu.exec(contents)?.[1];
	const secret = /^aws_secret_access_key\s*=\s*(\S+)\s*$/mu.exec(contents)?.[1];
	if (!id || !secret)
		throw new Error("AWS Emulator credentials file is invalid");
	return { accessKeyId: id, secretAccessKey: secret };
}

async function stop(child: ChildProcess): Promise<void> {
	if (
		child.pid === undefined ||
		child.exitCode !== null ||
		child.signalCode !== null
	)
		return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await exited;
}

async function startAwsEmulator() {
	const child = spawn(
		process.env.HOBO_AWS_EMULATOR_BIN ?? "aws-emulator",
		[
			"--bind",
			"127.0.0.1",
			"--port",
			"0",
			"--auth",
			"on",
			"--telemetry",
			"off",
			"--idle-timeout",
			"120",
		],
		{
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, RUST_LOG: "info" },
		},
	);
	try {
		const startup = await waitForStartup(child);
		const endpoint = new URL(startup.endpoint_url);
		if (
			endpoint.protocol !== "https:" ||
			endpoint.hostname !== "127.0.0.1" ||
			!endpoint.port
		) {
			throw new Error(
				"AWS Emulator did not start on an HTTPS loopback endpoint",
			);
		}
		const [ca, credentials] = await Promise.all([
			readFile(startup.ca_file),
			readFile(
				join(dirname(startup.ca_file), "emulator_credentials"),
				"utf8",
			).then(credentialsFromFile),
		]);
		const calls: TransportRequest[] = [];
		const transport: HttpTransport = (call) =>
			new Promise((resolve, reject) => {
				calls.push(call);
				const source = new URL(call.url);
				const request = httpsRequest(
					{
						hostname: endpoint.hostname,
						port: endpoint.port,
						// Retain the signed AWS Host header while validating the local CA
						// against the localhost name on the emulator's certificate.
						servername: "localhost",
						path: `${source.pathname}${source.search}`,
						method: call.method,
						headers: call.headers,
						ca,
						timeout: call.timeoutMs,
					},
					(response) => {
						const chunks: Buffer[] = [];
						let size = 0;
						response.on("data", (chunk: Buffer) => {
							size += chunk.length;
							if (size > call.maxResponseBytes)
								request.destroy(new Error("emulator response exceeded limit"));
							else chunks.push(chunk);
						});
						response.on("error", reject);
						response.on("end", () =>
							resolve({
								status: response.statusCode ?? 0,
								headers: Object.fromEntries(
									Object.entries(response.headers).map(([key, value]) => [
										key,
										Array.isArray(value) ? value.join(", ") : (value ?? ""),
									]),
								),
								body: Buffer.concat(chunks).toString("utf8"),
							}),
						);
					},
				);
				request.on("error", reject);
				request.on("timeout", () =>
					request.destroy(new Error("emulator request timed out")),
				);
				request.end(call.body);
			});
		return { calls, credentials, transport, close: () => stop(child) };
	} catch (error) {
		await stop(child);
		throw error;
	}
}

const emulatorSuite =
	process.env.HOBO_AWS_EMULATOR === "1" ? describe : describe.skip;

emulatorSuite("AWS resolvers with AWS Emulator", () => {
	let emulator: Awaited<ReturnType<typeof startAwsEmulator>>;
	beforeAll(async () => {
		emulator = await startAwsEmulator();
	}, 45_000);
	afterAll(async () => {
		await emulator?.close();
	});

	const products: readonly {
		readonly id: string;
		readonly slot: ResolveRequest["ref"]["slot"];
		readonly name: string;
		readonly desired: ResolveRequest["desired"];
	}[] = [
		{
			id: AWS_DYNAMODB_PRODUCT_ID,
			slot: "kv",
			name: "hobo-emulator-sessions",
			desired: { billingMode: "on-demand", partitionKey: "sessionId" },
		},
		{
			id: AWS_S3_PRODUCT_ID,
			slot: "bucket",
			name: "hobo-emulator-orders",
			desired: { versioning: true, publicAccessBlocked: true },
		},
	];
	for (const product of products) {
		it(`creates, adopts, reads and deletes ${product.id}`, async () => {
			const firstCall = emulator.calls.length;
			const registry = awsResolverRegistry({
				region: "us-east-1",
				nowMs: Date.now,
				resolveCredential: async () => emulator.credentials,
			});
			const resolver = registry.get(product.id);
			if (!resolver) throw new Error("AWS resolver is missing");
			const request: ResolveRequest = {
				ref: {
					slot: product.slot,
					productId: product.id,
					logicalId: product.name,
				},
				desired: product.desired,
				credentialRef: "emulator://credentials",
			};
			const created = await resolver.reconcile(request, emulator.transport);
			expect(created.action).toBe("create");
			const adopted = await resolver.reconcile(request, emulator.transport);
			expect(adopted.action).toBe("adopt");
			expect(adopted.physicalId).toBe(created.physicalId);
			const observed = await resolver.read?.(request, emulator.transport);
			expect(observed?.physicalId).toBe(created.physicalId);
			if (product.id === AWS_S3_PRODUCT_ID) {
				expect(observed?.outputs).toMatchObject({
					versioning: "Enabled",
					publicAccessBlocked: true,
				});
			} else {
				expect(observed?.outputs).toMatchObject({
					billingMode: "PAY_PER_REQUEST",
				});
			}
			const creates = emulator.calls
				.slice(firstCall)
				.filter((call) =>
					product.id === AWS_S3_PRODUCT_ID
						? call.method === "PUT" && new URL(call.url).search === ""
						: call.headers["x-amz-target"]?.endsWith(".CreateTable"),
				);
			expect(creates).toHaveLength(1);
			await resolver.delete(request, emulator.transport);
			// DynamoDB deletion is asynchronous; DELETING is still an observation.
			await expect
				.poll(() => resolver.read?.(request, emulator.transport), {
					timeout: 15_000,
					interval: 200,
				})
				.toBeUndefined();
			await resolver.delete(request, emulator.transport);
		}, 30_000);
	}
});
