import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	LocalDeploymentLaunchSchema,
	type LocalDeploymentReceipt,
	LocalDeploymentReceiptSchema,
} from "./_generated/composition_pb.js";
import { normalizeComponentHostKind } from "./bare-metal-yard.js";
import { isJsonObject, isJsonString } from "./json.js";
import {
	clearLocalDeployment,
	LOCAL_DEPLOYMENT_SCHEMA,
} from "./local-deployment.js";
import { serveProjectOnLocalYard } from "./wasm-host.js";

const token = process.env.HOBO_LOCAL_CONTROL_TOKEN;
delete process.env.HOBO_LOCAL_CONTROL_TOKEN;
let receipt: LocalDeploymentReceipt | undefined;
let closeServe: (() => Promise<void>) | undefined;
let control: Server | undefined;
let closing: Promise<void> | undefined;
let committed = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
let awaitingCommit: ReturnType<typeof setTimeout> | undefined;

function stop(reason: string): Promise<void> {
	if (closing) return closing;
	closing = (async () => {
		if (expiry) clearTimeout(expiry);
		if (awaitingCommit) clearTimeout(awaitingCommit);
		await closeServe?.();
		if (receipt) await clearLocalDeployment(receipt, reason);
	})();
	return closing;
}

function authorize(value: string | undefined): boolean {
	if (!token || !value) return false;
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(value);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

process.on("message", (message) => {
	if (!isJsonObject(message)) return;
	if (message.type === "committed") {
		committed = true;
		if (awaitingCommit) clearTimeout(awaitingCommit);
		if (receipt?.expiresAt)
			expiry = setTimeout(
				() => {
					void stop("expired").then(
						() => {
							control?.close();
							process.exit(0);
						},
						() => process.exit(1),
					);
				},
				Math.max(0, Date.parse(receipt.expiresAt) - Date.now()),
			);
		return;
	}
	if (
		message.type !== "start" ||
		!isJsonObject(message.launch) ||
		receipt ||
		closeServe
	)
		return;
	const rawLaunch = message.launch;
	void (async () => {
		if (!token) throw new Error("Local control authority is missing");
		const launch = fromJson(LocalDeploymentLaunchSchema, rawLaunch);
		const served = await serveProjectOnLocalYard({
			projectDir: launch.projectDir,
			hoboHome: launch.hoboHome,
			componentHost: normalizeComponentHostKind(launch.componentHost),
			port: launch.port,
		});
		closeServe = served.close;
		if (served.probe.status < 100 || served.probe.status >= 500)
			throw new Error(
				`Local HTTP server failed its readiness probe (HTTP ${served.probe.status})`,
			);
		control = createServer((request, response) => {
			if (!authorize(request.headers.authorization)) {
				response.writeHead(401).end();
				return;
			}
			const path = `/lease/${launch.leaseId}`;
			if (
				request.method === "GET" &&
				request.url === path &&
				receipt &&
				!closing
			) {
				response.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						leaseId: receipt.leaseId,
						pid: receipt.pid,
						primaryUrl: receipt.primaryUrl,
						projectDir: receipt.projectDir,
					}),
				);
				return;
			}
			if (
				request.method !== "POST" ||
				request.url !== `${path}/shutdown` ||
				!receipt
			) {
				response.writeHead(404).end();
				return;
			}
			const identity = {
				leaseId: receipt.leaseId,
				pid: receipt.pid,
				primaryUrl: receipt.primaryUrl,
				projectDir: receipt.projectDir,
			};
			void stop("down").then(
				() => {
					response
						.writeHead(200, { "content-type": "application/json" })
						.end(JSON.stringify(identity));
					control?.close(() => process.exit(0));
				},
				() => {
					response.writeHead(500).end();
				},
			);
		});
		await new Promise<void>((resolve, reject) => {
			control?.once("error", reject);
			control?.listen(0, "127.0.0.1", resolve);
		});
		const address = control.address();
		if (!address || isJsonString(address))
			throw new Error("Local control server did not bind");
		const now = new Date();
		receipt = create(LocalDeploymentReceiptSchema, {
			schemaVersion: LOCAL_DEPLOYMENT_SCHEMA,
			projectDir: launch.projectDir,
			hoboHome: launch.hoboHome,
			pid: process.pid,
			primaryUrl: served.primaryUrl,
			controlUrl: `http://127.0.0.1:${address.port}/lease/${launch.leaseId}`,
			leaseId: launch.leaseId,
			contentFingerprint: launch.contentFingerprint,
			startedAt: now.toISOString(),
			bindleName: launch.bindleName,
			componentHost: launch.componentHost,
			brokerId: launch.brokerId,
			campId: launch.campId,
			providerId: launch.providerId,
			port: Number(new URL(served.primaryUrl).port),
			probeStatus: served.probe.status,
			expiresAt:
				launch.ttlSeconds > 0
					? new Date(now.getTime() + launch.ttlSeconds * 1000).toISOString()
					: "",
		});
		awaitingCommit = setTimeout(() => {
			if (!committed)
				void stop("startup-abandoned").finally(() => process.exit(1));
		}, 30_000);
		process.send?.({
			type: "ready",
			receipt: toJson(LocalDeploymentReceiptSchema, receipt),
		});
	})().catch(async (error) => {
		process.send?.({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
		await stop("startup-failed").catch(() => undefined);
		process.exit(1);
	});
});
process.on("disconnect", () => {
	if (!committed) void stop("startup-abandoned").finally(() => process.exit(1));
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		void stop("signal").then(
			() => {
				control?.close();
				process.exit(0);
			},
			() => process.exit(1),
		);
	});
