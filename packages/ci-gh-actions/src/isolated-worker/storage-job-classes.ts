/** Measured / budgeted inode and byte growth per CI job class (worker admission). */
import { depsBuildDockerReserve } from "./deps-build-budget.js";

const DEPS_BUILD_RESERVE = depsBuildDockerReserve();

export type WorkerStorageClassName =
	| "light"
	| "standard"
	| "heavy"
	| "deps_build"
	| "runner_image"
	| "release_trunk";

export type WorkerStorageReserve = Readonly<{
	workRoot: number;
	dockerDataRoot: number;
	workRootBytes: number;
	dockerDataRootBytes: number;
}>;

export const STORAGE_CLASS_RESERVES = {
	light: {
		workRoot: 80_000,
		dockerDataRoot: 50_000,
		workRootBytes: 2 * 1024 * 1024 * 1024,
		dockerDataRootBytes: 1 * 1024 * 1024 * 1024,
	},
	standard: {
		workRoot: 180_000,
		dockerDataRoot: 170_000,
		workRootBytes: 8 * 1024 * 1024 * 1024,
		dockerDataRootBytes: 6 * 1024 * 1024 * 1024,
	},
	heavy: {
		workRoot: 200_000,
		dockerDataRoot: 170_000,
		workRootBytes: 12 * 1024 * 1024 * 1024,
		dockerDataRootBytes: 8 * 1024 * 1024 * 1024,
	},
	deps_build: {
		workRoot: 0,
		dockerDataRoot: DEPS_BUILD_RESERVE.dockerDataRoot,
		workRootBytes: 0,
		dockerDataRootBytes: DEPS_BUILD_RESERVE.dockerDataRootBytes,
	},
	runner_image: {
		workRoot: 40_000,
		dockerDataRoot: 220_000,
		workRootBytes: 4 * 1024 * 1024 * 1024,
		dockerDataRootBytes: 16 * 1024 * 1024 * 1024,
	},
	// Release main-train jobs (pages + npm install + site dist) observed ENOSPC at ~06:03 UTC on 0.0.0.0-alpha.94.
	release_trunk: {
		workRoot: 220_000,
		dockerDataRoot: 200_000,
		workRootBytes: 18 * 1024 * 1024 * 1024,
		dockerDataRootBytes: 14 * 1024 * 1024 * 1024,
	},
} as const satisfies Record<WorkerStorageClassName, WorkerStorageReserve>;

// public-contract: stable grant id for deps image build inode admission
export const DEPS_BUILD_ADMISSION_ID = "__hobo_ci_deps_image_build__";

const JOB_STORAGE_CLASS = {
	"CI fabric contract guard": "light",
	"Secret scan": "light",
	"Pricing release contract (static)": "light",
	"Attest GHCR images": "light",
	"Attest hobo-code GHCR image": "light",
	"CI runner image (mise oci)": "runner_image",
	"CI deps layer (pnpm)": "heavy",
	"PR impact gate": "light",
	"PR impact validation": "heavy",
	"PR affected package lanes": "heavy",
	"PR off-path checks (ts-autocode surface, production packages)": "heavy",
	"Main full gate": "heavy",
	"HoBo Code contract, lint, test + OCI image": "heavy",
	"Release contract + affected OCI images": "heavy",
	"Publish npm + GHCR (tagged release)": "release_trunk",
	"Stage npm package + publish hobo-code GHCR image": "release_trunk",
	"Build and test @hobo/pricing (release cone)": "heavy",
	"@hobo/pricing affected gate": "heavy",
	"Clean container bootstrap": "heavy",
	"dagger-native": "heavy",
	"Publish local deps image (non-blocking)": "deps_build",
	"Publish GitHub Pages (site/)": "release_trunk",
	"Build all OCI images on tag (gate publish)": "runner_image",
	"Publish GHCR images (tagged release)": "release_trunk",
} as const satisfies Record<string, WorkerStorageClassName>;

const JOB_STORAGE_CLASS_MAP = new Map(Object.entries(JOB_STORAGE_CLASS));

export function storageClassForJob(name: string): WorkerStorageClassName {
	if (/^Workspace test shard [0-7](?: \([0-7]\))?$/u.test(name)) return "heavy";
	return JOB_STORAGE_CLASS_MAP.get(name) ?? "standard";
}

export function storageReserveForJob(name: string): WorkerStorageReserve {
	return STORAGE_CLASS_RESERVES[storageClassForJob(name)];
}

export function storageReserveForDepsBuild(): WorkerStorageReserve {
	return STORAGE_CLASS_RESERVES.deps_build;
}

export function storageReserveForClass(
	className: WorkerStorageClassName,
): WorkerStorageReserve {
	return STORAGE_CLASS_RESERVES[className];
}
