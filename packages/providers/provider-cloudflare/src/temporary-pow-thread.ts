/**
 * The temporary-account proof of work on a worker thread, so a CLI or a
 * server keeps answering while Cloudflare's `k * g` sequential SHA-256 steps
 * run (about two million live, a few seconds). Same ladder as
 * `solvePreviewChallenge`, which stays the in-thread reference; the tests
 * pin the two to the same checkpoints.
 *
 * The thread runs inline source (`eval: true`) using only `node:crypto`, so
 * it works from compiled output and from TypeScript under a test runner
 * alike, with no module path to resolve.
 */
import { Worker } from "node:worker_threads";
import { TemporaryAccountError } from "./temporary-account-errors.js";
import type {
	PreviewChallenge,
	PreviewChallengeSolution,
} from "./temporary-pow.js";

const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { seed, k, g } = workerData;
const padded = seed.replace(/-/g, "+").replace(/_/g, "/");
const bytes = Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
if (bytes.length !== 32) throw new Error("seed must decode to 32 bytes");
const out = Buffer.alloc((k + 1) * 32);
let hash = createHash("sha256").update(bytes).digest();
hash.copy(out, 0);
for (let segment = 0; segment < k; segment++) {
	for (let iteration = 0; iteration < g; iteration++)
		hash = createHash("sha256").update(hash).digest();
	hash.copy(out, (segment + 1) * 32);
}
parentPort.postMessage(out.toString("base64"));
`;

const MAX_WORK = 64_000_000;

export async function solvePreviewChallengeOffThread(
	challenge: PreviewChallenge,
	options: Readonly<{ timeoutMs?: number }> = {},
): Promise<PreviewChallengeSolution> {
	const { challengeToken, seed, k, g } = challenge;
	if (
		!Number.isInteger(k) ||
		!Number.isInteger(g) ||
		k <= 0 ||
		g <= 0 ||
		k * g > MAX_WORK
	)
		throw new TemporaryAccountError(
			"WORK_BUDGET_EXCEEDED",
			"the proof-of-work parameters are outside Cloudflare's bound",
			{ reason: "PROOF_OF_WORK_INVALID" },
		);
	const worker = new Worker(SOURCE, { eval: true, workerData: { seed, k, g } });
	try {
		const checkpoints = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("proof of work timed out")),
				options.timeoutMs ?? 120_000,
			);
			worker.once("message", (value: string) => {
				clearTimeout(timer);
				resolve(value);
			});
			worker.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		return { challengeToken, solution: { checkpoints } };
	} catch (cause) {
		throw new TemporaryAccountError(
			"PROVIDER_UNAVAILABLE",
			"the proof of work did not finish on its worker thread",
			{
				reason: "PROOF_OF_WORK_FAILED",
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			},
		);
	} finally {
		await worker.terminate();
	}
}
