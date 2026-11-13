/**
 * Sandbox drivers (L38, design §6.11, §7.3). `sandboxDrivers` builds this
 * platform's candidates, runs each one's self-test, and answers one driver per
 * tier (the first candidate of that tier whose self-test passed), up to `cap`.
 *
 * - Linux: `S1_CONTAINER` over `crun`, else `runc`; `S2_USER_KERNEL` over
 *   gVisor's `runsc`; `S3_MICROVM` over Kata (fails closed, A11).
 * - macOS: `S3_MICROVM` over Apple's `container` (fails closed, A12).
 * - Anything else: none.
 *
 * Rootless when the agent is not root; when it is, every sandbox runs in a
 * user namespace mapped to a reserved high id range (A10's fallback).
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type FleetLog, type SandboxDriver, SandboxTier } from "@hobo/fleet";
import { createRegistryImageStore } from "./image.js";
import {
	APPLE_CONTAINER_RUNTIME,
	createMicroVmSandboxDriver,
	KATA_RUNTIME,
} from "./microvm.js";
import { ROOTFUL_ID_BASE } from "./oci-config.js";
import { createOciSandboxDriver } from "./oci-driver.js";
import { createOciCalls } from "./oci-runtime.js";

/** The drivers whose self-test passed, up to `cap`. */
export function sandboxDrivers(
	options: Readonly<{ cap?: SandboxTier; log: FleetLog }>,
): Promise<readonly SandboxDriver[]> {
	return selectSandboxDrivers(
		platformCandidates(process.platform, options.log),
		options.cap,
	);
}

/** One driver per tier, the first candidate of it whose self-test passes, none above `cap`; ordered by tier. */
export async function selectSandboxDrivers(
	candidates: readonly SandboxDriver[],
	cap: SandboxTier | undefined,
): Promise<readonly SandboxDriver[]> {
	const chosen = new Map<SandboxTier, SandboxDriver>();
	for (const candidate of candidates) {
		if (candidate.tier === SandboxTier.UNSPECIFIED) continue;
		if (cap !== undefined && candidate.tier > cap) continue;
		if (chosen.has(candidate.tier)) continue;
		const answer = await candidate.available();
		if (answer.ok) chosen.set(candidate.tier, candidate);
	}
	return [...chosen.values()].sort((a, b) => a.tier - b.tier);
}

/** Creates `dir` (and missing parents) and leaves it traversable but not listable by others. */
function traversable(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o711 });
	chmodSync(dir, 0o711);
	return dir;
}

/** This platform's driver candidates, in preference order. */
export function platformCandidates(
	platform: NodeJS.Platform,
	log: FleetLog,
): readonly SandboxDriver[] {
	if (platform === "darwin")
		return [createMicroVmSandboxDriver(APPLE_CONTAINER_RUNTIME, log)];
	if (platform !== "linux") return [];
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	const rootless = uid === 0 ? undefined : { uid, gid };
	const home =
		rootless === undefined
			? traversable("/var/lib/hobo-fleet")
			: join(
					process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
					"hobo-fleet",
				);
	const run =
		rootless === undefined
			? traversable("/run/hobo-fleet")
			: join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `hobo-fleet-${uid}`);
	const images = createRegistryImageStore({
		cacheDir:
			rootless === undefined
				? traversable(join(home, "images"))
				: join(home, "images"),
		fetch,
		idShift: rootless === undefined ? ROOTFUL_ID_BASE : 0,
	});
	const oci = (
		tier: SandboxTier,
		runtime: string,
		globalFlags: readonly string[],
	): SandboxDriver =>
		createOciSandboxDriver({
			tier,
			runtime,
			calls: createOciCalls({
				binary: runtime,
				stateRoot: join(run, `state-${runtime}`),
				globalFlags,
				rootless: rootless !== undefined,
			}),
			images,
			workRoot: join(run, "sandbox"),
			rootless,
			log,
		});
	return [
		oci(SandboxTier.S1_CONTAINER, "crun", []),
		oci(SandboxTier.S1_CONTAINER, "runc", []),
		// gVisor's own network stack would hide the forwarder's loopback; host mode uses the sandbox's namespace.
		oci(SandboxTier.S2_USER_KERNEL, "runsc", ["--network=host"]),
		createMicroVmSandboxDriver(KATA_RUNTIME, log),
	];
}
