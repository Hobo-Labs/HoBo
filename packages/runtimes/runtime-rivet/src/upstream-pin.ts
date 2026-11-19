export const RIVETKIT_PIN = {
	packageName: "rivetkit",
	version: "2.3.10",
	license: "Apache-2.0",
	enginesNode: ">=22.0.0",
	integrity:
		"sha512-E+H0lBc3O8dK9Pj7W2XW3VwrCnfpwYYm5LlsZyHrmk5bCrJIBdnEFdZXn5nsYMz0waCfP1ieyP6d1tdvBG76Dg==",
	checkedAt: "2026-08-13",
	source: "https://registry.npmjs.org/rivetkit/2.3.10",
} as const;

export const RIVET_ENGINE_PIN = {
	image: "rivetdev/engine",
	tag: "2.3.10",
	indexDigest:
		"sha256:efaaa24ecdae3c0b608a45f9d9efdecf36e4159ab6d3443e5f3c410bcfb45467",
	checkedAt: "2026-08-13",
	source: "https://hub.docker.com/v2/repositories/rivetdev/engine/tags/2.3.10",
} as const;

export function rivetEngineImageRef(): string {
	return `${RIVET_ENGINE_PIN.image}:${RIVET_ENGINE_PIN.tag}@${RIVET_ENGINE_PIN.indexDigest}`;
}
