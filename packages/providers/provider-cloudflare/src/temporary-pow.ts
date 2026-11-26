import { createHash } from "node:crypto";

/** Cloudflare temporary-account preview challenge (claim-deployments PoW). */
export type PreviewChallenge = {
	readonly challengeToken: string;
	readonly seed: string;
	readonly k: number;
	readonly g: number;
	readonly s?: number;
	readonly expiresAt?: number;
};

export type PreviewChallengeSolution = {
	readonly challengeToken: string;
	readonly solution: { readonly checkpoints: string };
};

const CHECKPOINT_BYTES = 32;
const MAX_WORK = 64_000_000;

function decodeBase64Url(input: string): Uint8Array {
	const padded = input.replace(/-/gu, "+").replace(/_/gu, "/");
	const pad =
		padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
	const binary = atob(padded + pad);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Solve Cloudflare temporary-account proof-of-work.
 * Sync node:crypto SHA-256 — must finish before challenge expires (~live k*g ≈ 2e6).
 */
export async function solvePreviewChallenge(
	challenge: PreviewChallenge,
): Promise<PreviewChallengeSolution> {
	const { challengeToken, seed, k, g } = challenge;
	const seedBytes = decodeBase64Url(seed);
	if (seedBytes.length !== 32) {
		throw new Error("seed must decode to 32 bytes");
	}
	if (!Number.isInteger(k) || k <= 0) {
		throw new Error("k must be a positive integer");
	}
	if (!Number.isInteger(g) || g <= 0) {
		throw new Error("g must be a positive integer");
	}
	if (k * g > MAX_WORK) {
		throw new Error("k * g must not exceed 64,000,000");
	}

	const checkpoints: Uint8Array[] = [];
	let hash = new Uint8Array(createHash("sha256").update(seedBytes).digest());
	checkpoints.push(hash);
	for (let segment = 0; segment < k; segment++) {
		for (let iteration = 0; iteration < g; iteration++) {
			hash = new Uint8Array(createHash("sha256").update(hash).digest());
		}
		checkpoints.push(hash);
	}

	const flat = new Uint8Array((k + 1) * CHECKPOINT_BYTES);
	for (let i = 0; i < checkpoints.length; i++) {
		const checkpoint = checkpoints[i];
		if (checkpoint === undefined) {
			throw new Error(`checkpoint ${i} missing`);
		}
		flat.set(checkpoint, i * CHECKPOINT_BYTES);
	}

	return {
		challengeToken,
		solution: {
			checkpoints: encodeBase64(flat),
		},
	};
}

/** Verify a solution matches the checkpoint ladder (test helper). */
export async function verifyPreviewChallengeSolution(
	challenge: PreviewChallenge,
	checkpointsBase64: string,
): Promise<boolean> {
	const expected = (await solvePreviewChallenge(challenge)).solution
		.checkpoints;
	return expected === checkpointsBase64;
}
