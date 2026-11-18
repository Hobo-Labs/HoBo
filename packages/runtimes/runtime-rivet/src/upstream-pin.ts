/**
 * Pinned Rivet artifacts. Do not use latest, rc, or unpinned digests.
 * Checked 2026-11-16 against npm and Docker Hub.
 */
export const RIVETKIT_PIN = {
	packageName: "rivetkit",
	version: "3.0.0",
	license: "Apache-2.0",
	enginesNode: ">=22.0.0",
	integrity:
		"sha512-xUa0+hD3rjvuIzzZU3Y9j6PbD1tG88+pseiwHclDejdCGMm33mLR10fuHUN82Ly45pcBigE5Nn6M1RXkHjdJJg==",
	checkedAt: "2026-11-16",
	source: "https://registry.npmjs.org/rivetkit/3.0.0",
} as const;

export const RIVET_ENGINE_PIN = {
	image: "rivetdev/engine",
	tag: "3.0.0",
	indexDigest:
		"sha256:5ae3c24275eeff87ad1962f4d66fcdb85786fc1397feeeb55afc2ca1f7ccf6f2",
	checkedAt: "2026-11-16",
	source: "https://hub.docker.com/v2/repositories/rivetdev/engine/tags/3.0.0",
} as const;

export function rivetEngineImageRef(): string {
	return `${RIVET_ENGINE_PIN.image}:${RIVET_ENGINE_PIN.tag}@${RIVET_ENGINE_PIN.indexDigest}`;
}
