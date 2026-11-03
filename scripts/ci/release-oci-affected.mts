#!/usr/bin/env node
/**
 * Print the release OCI image ids whose build inputs changed, as a JSON array.
 * HOBO_CHECK_BASE selects the diff base (default: origin/main); the diff is
 * BASE...HEAD. An empty array means the PR build job should be skipped.
 * `--all` prints every manifest image for manual release validation.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import {
	loadReleaseOciManifest,
	type ReleaseOciImage,
	type ReleaseOciManifest,
} from "../lib/release-oci-contract.mts";

const RELEASE_IMAGE_ORDER = [
	"hobo-sdk",
	"hobo-codegen",
	"hobo-code",
	"hobo-cli",
	"hobo-mcp",
	"hobo-ci-serve",
	"hobo-site",
] as const;

const SHARED_INPUTS = new Set([
	"mise.toml",
	"mise.lock",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"tsconfig.base.json",
	"turbo.json",
	"release/oci-images.json",
	"scripts/ci/build-release-oci-image.mts",
	"scripts/ci/stage-release-oci-app.mts",
	"scripts/ci/release-oci-affected.mts",
	"scripts/lib/release-oci-contract.mts",
]);

const HOBO_CODE_INPUTS = [
	"packages/bindles/",
	"packages/capability-profiles/",
	"packages/ci/",
	"packages/code/",
	"packages/connectivity/",
	"packages/contracts/",
	"packages/core/",
	"packages/data/",
	"packages/dispatcher/",
	"packages/evals/",
	"packages/fuzz/",
	"packages/identity/",
	"packages/manifest-capability/",
	"packages/manifest-request/",
	"packages/patterns/",
	"packages/policy/",
	"packages/replay/",
	"packages/rift/",
	"packages/runtimes/runtime-local/",
	"packages/stations/",
	"packages/status-page/",
	"packages/storage-sqlite/",
] as const;

const HOBO_SDK_INPUTS = [
	"packages/bindings/",
	"packages/bindles/",
	"packages/capability-profiles/",
	"packages/claims/",
	"packages/cli/",
	"packages/cloud/",
	"packages/componentize/",
	"packages/contract-harness/",
	"packages/contracts/",
	"packages/core/",
	"packages/data/",
	"packages/events/",
	"packages/identity/",
	"packages/manifest-capability/",
	"packages/manifest-declaration/",
	"packages/manifest-plan/",
	"packages/manifest-request/",
	"packages/patterns/",
	"packages/policy/",
	"packages/runtime/",
	"packages/runtimes/runtime-local/",
	"packages/storage-sqlite/",
	"packages/wit/",
] as const;

const HOBO_CLI_INPUTS = [
	"packages/adapters/adapter-opensesame/",
	"packages/auth-md/",
	"packages/bindings/",
	"packages/bindles/",
	"packages/broker/",
	"packages/camps/",
	"packages/capability-profiles/",
	"packages/ci-gh-actions/",
	"packages/ci/",
	"packages/claims/",
	"packages/cli/",
	"packages/cloud/",
	"packages/componentize/",
	"packages/conformance/",
	"packages/connectivity/",
	"packages/contracts/",
	"packages/control-api/",
	"packages/core/",
	"packages/data/",
	"packages/dispatcher/",
	"packages/evals/",
	"packages/events/",
	"packages/fuzz/",
	"packages/hobo/",
	"packages/iac/iac-pulumi/",
	"packages/identity/",
	"packages/kv-redis-compatible/",
	"packages/management/",
	"packages/manifest-capability/",
	"packages/manifest-declaration/",
	"packages/manifest-plan/",
	"packages/manifest-request/",
	"packages/mcp/",
	"packages/patterns/",
	"packages/policy/",
	"packages/providers/provider-aws/",
	"packages/providers/provider-azure/",
	"packages/providers/provider-cedar/",
	"packages/providers/provider-cloudflare/",
	"packages/providers/provider-digitalocean/",
	"packages/providers/provider-gcp/",
	"packages/providers/provider-hetzner/",
	"packages/providers/provider-hostinger/",
	"packages/providers/provider-kafka/",
	"packages/providers/provider-kubernetes/",
	"packages/providers/provider-lakebed/",
	"packages/providers/provider-neon/",
	"packages/providers/provider-netlify/",
	"packages/providers/provider-opa/",
	"packages/providers/provider-prisma-postgres/",
	"packages/providers/provider-ttl-sh/",
	"packages/providers/provider-upstash/",
	"packages/providers/provider-vercel/",
	"packages/providers/runner-blacksmith/",
	"packages/providers/runner-depot/",
	"packages/providers/runner-github/",
	"packages/recipes/",
	"packages/replay/",
	"packages/rift/",
	"packages/runtime/",
	"packages/runtimes/runtime-cloud-native/",
	"packages/runtimes/runtime-dapr/",
	"packages/runtimes/runtime-local/",
	"packages/runtimes/runtime-oci/",
	"packages/runtimes/runtime-wasm/",
	"packages/stations/",
	"packages/status-page/",
	"packages/storage-sqlite/",
	"packages/trails/",
	"packages/trust/",
	"packages/wit/",
	"packages/yard-world/",
	"packages/yards/",
] as const;

interface ImageInputs {
	readonly [id: string]: readonly string[];
}

const IMAGE_INPUTS: ImageInputs = {
	"hobo-code": HOBO_CODE_INPUTS,
	"hobo-cli": [...HOBO_CLI_INPUTS, "tools/pins/", "external/ts-autocode/"],
	"hobo-codegen": ["packages/core/", "packages/schema-tools/"],
	"hobo-ci-serve": [
		"packages/ci/",
		"packages/ci-gh-actions/",
		"packages/ci-dagger/",
		"packages/ci-cf/",
		"packages/dispatcher/",
	],
	"hobo-site": ["site/"],
	"hobo-sdk": [
		...HOBO_SDK_INPUTS,
		"release/npm-scope-map.json",
		"scripts/ci/npm-publish-scope.mts",
		"scripts/ci/stage-sdk-artifacts.mts",
	],
};

function matchesInput(path: string, input: string): boolean {
	return input.endsWith("/")
		? path.startsWith(input)
		: path === input || path.startsWith(`${input}/`);
}

function imageInputs(image: ReleaseOciImage): readonly string[] {
	return [
		image.dockerfile,
		`${dirname(image.dockerfile)}/`,
		...(IMAGE_INPUTS[image.id] ?? []),
	];
}

function orderedImageIds(manifest: ReleaseOciManifest): string[] {
	const manifestIds = manifest.images.map((image) => image.id);
	return [
		...RELEASE_IMAGE_ORDER.filter((id) => manifestIds.includes(id)),
		...manifestIds.filter(
			// SAFETY: Readonly widening preserves the tuple while allowing arbitrary manifest ids.
			(id) => !(RELEASE_IMAGE_ORDER as readonly string[]).includes(id),
		),
	];
}

export function affectedReleaseOciImages(
	manifest: ReleaseOciManifest,
	changedPaths: readonly string[],
): string[] {
	const changed = changedPaths
		.map((path) => path.trim())
		.filter((path) => path !== "");
	const ordered = orderedImageIds(manifest);
	if (changed.length === 0) return [];
	if (changed.some((path) => SHARED_INPUTS.has(path))) return ordered;
	if (
		changed.some(
			(path) =>
				path.startsWith("packages/ci-gh-actions/deploy/ci-runner/") ||
				path === "scripts/lib/ci-runner-contract.mts" ||
				path === "scripts/ci-runner-preflight.mts",
		)
	) {
		return ordered;
	}

	const selected = new Set(
		manifest.images
			.filter((image) =>
				changed.some((path) =>
					imageInputs(image).some((input) => matchesInput(path, input)),
				),
			)
			.map((image) => image.id),
	);
	if (
		selected.has("hobo-cli") &&
		manifest.images.some((image) => image.id === "hobo-mcp")
	) {
		selected.add("hobo-mcp");
	}
	return ordered.filter((id) => selected.has(id));
}

function changedPaths(root: string): string[] {
	const base = process.env.HOBO_CHECK_BASE ?? "origin/main";
	const result = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(
			`git diff --name-only ${base}...HEAD failed: ${result.stderr || result.error?.message || result.status}`,
		);
	}
	return result.stdout.split("\n");
}

function main(): void {
	const root = join(import.meta.dirname, "..", "..");
	const manifest = loadReleaseOciManifest(root);
	const images = process.argv.includes("--all")
		? orderedImageIds(manifest)
		: affectedReleaseOciImages(manifest, changedPaths(root));
	process.stdout.write(`${JSON.stringify(images)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
