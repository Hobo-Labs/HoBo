import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { toResponse } from "./controller.mts";
import {
	BridgeRequestSchema,
	fingerprint,
	MAX_REQUEST_TTL_MS,
	openResponse,
	REPOSITORY,
	REPOSITORY_ID,
	signRequest,
	VERSION,
	validateScope,
} from "./protocol.mts";

export interface SpoolOptions {
	directory: string;
	installationId: number;
	repository?: string;
	privateKeyPath: string;
	controllerPublicKeyPath: string;
	runId: number;
	runAttempt: number;
	sourceSha: string;
	deadlineForRunner?: (
		runner: string,
	) => Promise<string | number | null | undefined>;
	clock?: () => number;
	pollMs?: number;
	timeoutMs?: number;
}
/** Local authority must live outside untrusted worker VMs and keep its signing key private. */
export function createSpoolGithubTransport({
	directory,
	installationId,
	repository = REPOSITORY,
	privateKeyPath,
	controllerPublicKeyPath,
	runId,
	runAttempt,
	sourceSha,
	deadlineForRunner,
	clock = Date.now,
	pollMs = 200,
	timeoutMs = MAX_REQUEST_TTL_MS,
}: SpoolOptions) {
	if (
		!directory ||
		!privateKeyPath ||
		!controllerPublicKeyPath ||
		repository !== REPOSITORY ||
		!Number.isSafeInteger(installationId) ||
		installationId <= 0 ||
		!Number.isSafeInteger(runId) ||
		runId <= 0 ||
		!Number.isSafeInteger(runAttempt) ||
		runAttempt <= 0 ||
		!Number.isInteger(pollMs) ||
		pollMs < 25 ||
		pollMs > 5000 ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > MAX_REQUEST_TTL_MS
	)
		throw new Error("invalid local bridge configuration");
	const privateKey = readFileSync(privateKeyPath, "utf8"),
		controllerPublicKey = readFileSync(controllerPublicKeyPath, "utf8");
	const requests = join(directory, "requests"),
		responses = join(directory, "responses"),
		abandoned = join(directory, "abandoned");
	for (const dir of [requests, responses, abandoned])
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	const wait = () => new Promise((resolve) => setTimeout(resolve, pollMs));
	return {
		async request(
			targetInstallation: number,
			path: string,
			method = "GET",
			body?: string,
			ifNoneMatch?: string,
		) {
			if (targetInstallation !== installationId)
				throw new Error("installation scope denied");
			let queueDeadline: string | number | null | undefined = null;
			if (
				method === "POST" &&
				path === `/repos/${REPOSITORY}/actions/runners/generate-jitconfig`
			) {
				const runner = z
					.object({ name: z.string() })
					.parse(JSON.parse(z.string().parse(body))).name;
				if (!deadlineForRunner) throw new Error("JIT lease unavailable");
				queueDeadline = await deadlineForRunner(runner);
				if (queueDeadline == null) throw new Error("JIT lease unavailable");
			}
			const issuedAt = clock();
			let notAfter = issuedAt + timeoutMs;
			if (queueDeadline !== null) {
				const deadlineValue = z
					.union([z.number(), z.string()])
					.parse(queueDeadline);
				const numberDeadline = z.number().safeParse(deadlineValue);
				const deadline = numberDeadline.success
					? numberDeadline.data
					: Date.parse(z.string().parse(deadlineValue));
				if (!Number.isSafeInteger(deadline) || deadline <= issuedAt)
					throw new Error("JIT deadline expired");
				notAfter = Math.min(notAfter, deadline);
			}
			const id = randomBytes(16).toString("hex");
			const q = BridgeRequestSchema.parse({
				version: VERSION,
				id,
				issuedAt,
				notAfter,
				installationId,
				repositoryId: REPOSITORY_ID,
				runId,
				runAttempt,
				sourceSha,
				workerKey: fingerprint(privateKey),
				controllerKey: fingerprint(controllerPublicKey),
				method,
				path,
				body: body ?? null,
				ifNoneMatch: ifNoneMatch ?? null,
				capability:
					method === "GET" ? null : randomBytes(32).toString("base64url"),
			});
			validateScope(q);
			const envelope = signRequest(q, privateKey);
			const requestPath = join(requests, `${id}.json`),
				temporary = join(requests, `.${id}.${process.pid}.tmp`),
				responsePath = join(responses, `${id}.json`),
				abandonedPath = join(abandoned, id);
			try {
				writeFileSync(temporary, JSON.stringify(envelope), {
					mode: 0o600,
					flag: "wx",
				});
				renameSync(temporary, requestPath);
				while (clock() < notAfter) {
					if (existsSync(responsePath)) {
						const responseText = readFileSync(responsePath, "utf8");
						if (Buffer.byteLength(responseText) > 12 * 1024 * 1024)
							throw new Error("bridge response too large");
						const payload = openResponse(q, JSON.parse(responseText), {
							workerPrivateKey: privateKey,
							controllerPublicKey,
						});
						if (payload?.outcome !== "http")
							throw new Error("GitHub bridge request outcome uncertain");
						const response = toResponse(payload);
						try {
							unlinkSync(responsePath);
						} catch {}
						return response;
					}
					await wait();
				}
				throw new Error("GitHub bridge request outcome uncertain");
			} catch {
				try {
					writeFileSync(abandonedPath, "abandoned", {
						mode: 0o600,
						flag: "wx",
					});
				} catch {}
				throw new Error("GitHub bridge request outcome uncertain");
			} finally {
				try {
					unlinkSync(temporary);
				} catch {}
			}
		},
	};
}
