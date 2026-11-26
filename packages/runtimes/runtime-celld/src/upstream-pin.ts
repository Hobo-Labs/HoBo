/** Pinned celld evidence. Do not use latest. Checked 2026-08-14. */
export const CELLD_PIN = {
	project: "denoland/celld",
	license: "Apache-2.0",
	image: "ghcr.io/denoland/celld",
	tag: "v0.2.1",
	indexDigest:
		"sha256:7a4380721b6400073f2a26afe70a828410169f658d31b5ef61383e648ca0c530",
	commit: "ae8fac053d79f971bfcb996054bb43eb2f9b05da",
	checkedAt: "2026-08-14",
	source: "https://github.com/denoland/celld/releases/tag/v0.2.1",
	pinnedRef:
		"ghcr.io/denoland/celld:v0.2.1@sha256:7a4380721b6400073f2a26afe70a828410169f658d31b5ef61383e648ca0c530",
	notes: [
		"No filesystem mode; CAS bucket required (s3:// or gs://).",
		"WASM is a Worker-imported module, not WIT/Component Model.",
		"Peer HTTP has no TLS; operator API is unauthenticated.",
		"Hostile multi-tenant use is unsafe; one fleet per trust boundary.",
		"Alpha; security fixes apply to the latest release only.",
	],
} as const;
