/**
 * Sandbox drivers (L38, L40; design §6.11, §7.3, D58). `sandboxDrivers`
 * builds this platform's candidates, runs each one's self-test, and answers
 * one driver per tier (the first candidate of that tier whose self-test
 * passed), up to `cap`.
 *
 * - Linux: the sandbox runtime is not a host prerequisite. The agent
 *   provisions gVisor's `runsc` itself (`runtime-provision.ts`: a pinned,
 *   SHA-512-verified release in its cache) and serves `S1_CONTAINER` and
 *   `S2_USER_KERNEL` from it. A host `crun` or `runc` is used only when an
 *   operator configures its path (`HOBO_FLEET_SANDBOX_RUNTIME`), and then for
 *   `S1_CONTAINER` only; nothing is taken from `PATH`. The mode is probed
 *   (`privilege.ts`): rootful when the agent is root (each sandbox in a user
 *   namespace mapped to a reserved high id range, A10's fallback), rootless
 *   when unprivileged user namespaces work, otherwise nothing is advertised.
 *   Limits go through cgroups when they are delegated, else (runsc only)
 *   through the sentry with `--ignore-cgroups`. `S3_MICROVM` over Kata fails
 *   closed (A11).
 * - macOS: `S3_MICROVM` over Apple's `container` (fails closed, A12).
 * - Anything else: none.
 *
 * When no Linux runtime qualifies, `hobo_fleet_sandbox_unavailable` is logged
 * with the reason (`not-provisioned`, `checksum-mismatch`,
 * `no-root-or-userns`, …); a candidate whose self-test fails logs it too.
 *
 * Settings, from the environment: `HOBO_FLEET_SANDBOX_CACHE` (the runtime
 * cache; `~/.cache/hobo-fleet`, or `/var/lib/hobo-fleet` as root),
 * `HOBO_FLEET_SANDBOX_DOWNLOAD=0` (use only the cache), and
 * `HOBO_FLEET_SANDBOX_RUNTIME` (an operator's host runtime).
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type FleetLog, type SandboxDriver, SandboxTier } from "@hobo/fleet";
import { createRegistryImageStore, type ImageStore } from "./image.js";
import {
	APPLE_CONTAINER_RUNTIME,
	createMicroVmSandboxDriver,
	KATA_RUNTIME,
} from "./microvm.js";
import { type CgroupPlacement, ROOTFUL_ID_BASE } from "./oci-config.js";
import { createOciSandboxDrivers } from "./oci-driver.js";
import { createOciCalls, type OciCalls } from "./oci-runtime.js";
import {
	type Cgroups,
	type Privilege,
	probeCgroups,
	probePrivilege,
	REAL_HOST,
	userNamespaceTrial,
} from "./privilege.js";
import {
	type RuntimeResolution,
	resolveSandboxRuntime,
} from "./runtime-provision.js";

/** The drivers whose self-test passed, up to `cap`. */
export async function sandboxDrivers(
	options: Readonly<{ cap?: SandboxTier; log: FleetLog }>,
): Promise<readonly SandboxDriver[]> {
	return configuredSandboxDrivers({
		...options,
		settings: sandboxSettings(process.env, process.geteuid?.() ?? 0),
	});
}

/** `sandboxDrivers` with explicit settings (the O10 test passes the CI cache). */
export async function configuredSandboxDrivers(
	options: Readonly<{
		cap?: SandboxTier | undefined;
		log: FleetLog;
		settings: SandboxSettings;
	}>,
): Promise<readonly SandboxDriver[]> {
	return selectSandboxDrivers(
		await platformCandidates(process.platform, options.log, options.settings),
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

export type SandboxSettings = Readonly<{
	/** An operator-configured host runtime; the only way a host binary is used. */
	hostRuntime: string | undefined;
	cacheDir: string;
	allowDownload: boolean;
}>;

/** Reads the settings in this file's comment; no runtime is ever looked up on PATH. */
export function sandboxSettings(
	env: Readonly<Record<string, string | undefined>>,
	euid: number,
): SandboxSettings {
	const configured = env.HOBO_FLEET_SANDBOX_RUNTIME;
	const cache = env.HOBO_FLEET_SANDBOX_CACHE;
	return {
		hostRuntime:
			configured === undefined || configured === "" ? undefined : configured,
		cacheDir:
			cache !== undefined && cache !== ""
				? cache
				: euid === 0
					? "/var/lib/hobo-fleet"
					: join(
							env.XDG_CACHE_HOME ?? join(env.HOME ?? homedir(), ".cache"),
							"hobo-fleet",
						),
		allowDownload: env.HOBO_FLEET_SANDBOX_DOWNLOAD !== "0",
	};
}

/** What the Linux probes found: the runtime, the privilege mode and where limits go. */
export type HostSetup = Readonly<{
	runtime: RuntimeResolution;
	privilege: Privilege;
	cgroups: Cgroups;
}>;

/** Resolves (provisioning when allowed) the runtime, then probes privilege with it and cgroups. */
export async function probeLinuxHost(
	settings: SandboxSettings,
): Promise<HostSetup> {
	const euid = process.geteuid?.() ?? 0;
	const runtime = await resolveSandboxRuntime({
		hostRuntime: settings.hostRuntime,
		cacheDir: settings.cacheDir,
		allowDownload: settings.allowDownload,
	});
	const runsc =
		runtime.ok && runtime.runtime.name === "runsc"
			? runtime.runtime.path
			: undefined;
	const privilege = await probePrivilege({
		euid,
		host: REAL_HOST,
		trial: userNamespaceTrial(runsc),
	});
	return { runtime, privilege, cgroups: probeCgroups(euid, REAL_HOST) };
}

/**
 * runsc's global flags: a loopback-only network stack (the forwarder
 * container brings the proxy and control ports into it), connects to host
 * Unix sockets (the forwarder's, to the agent's relay and control sockets;
 * runsc `--host-uds=open`), the sandbox's OCI seccomp profile loaded inside
 * the sentry, and, without delegated cgroups, `--ignore-cgroups` so the
 * sentry's own limits (`oci-config.ts`) are the ones that hold.
 */
export function runscFlags(cgroups: CgroupPlacement): readonly string[] {
	const flags = ["--network=none", "--host-uds=open", "--oci-seccomp"];
	if (cgroups.mode === "sentry") flags.push("--ignore-cgroups");
	return flags;
}

/** Creates `dir` (and missing parents) and leaves it traversable but not listable by others. */
function traversable(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o711 });
	chmodSync(dir, 0o711);
	return dir;
}

const BOTH_TIERS = "S1_CONTAINER,S2_USER_KERNEL";

/**
 * The Linux OCI candidates for a probed host, in preference order, then
 * Kata. Logs `hobo_fleet_sandbox_unavailable` when no OCI runtime qualifies.
 */
export function linuxCandidates(
	setup: HostSetup,
	input: Readonly<{
		log: FleetLog;
		/** The agent's run directory (sandboxes, runtime state). */
		run: string;
		images: ImageStore;
		makeCalls?: (
			binary: string,
			stateRoot: string,
			flags: readonly string[],
		) => OciCalls;
	}>,
): readonly SandboxDriver[] {
	const kata = createMicroVmSandboxDriver(KATA_RUNTIME, input.log);
	const unavailable = (runtime: string, reason: string) => {
		input.log("hobo_fleet_sandbox_unavailable", {
			tier: BOTH_TIERS,
			runtime,
			reason: reason.slice(0, 300),
		});
		return [kata];
	};
	const { runtime, privilege, cgroups } = setup;
	if (!runtime.ok)
		return unavailable("runsc", `${runtime.reason}: ${runtime.detail}`);
	const { name, path } = runtime.runtime;
	if (privilege.mode === "unavailable")
		return unavailable(name, `${privilege.reason}: ${privilege.detail}`);
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	const rootless = privilege.mode === "rootful" ? undefined : { uid, gid };
	const makeCalls =
		input.makeCalls ??
		((binary, stateRoot, flags) =>
			createOciCalls({ binary, stateRoot, globalFlags: flags }));
	const oci = (
		tiers: readonly SandboxTier[],
		flavor: "runsc" | "oci",
		placement: CgroupPlacement,
		flags: readonly string[],
	): readonly SandboxDriver[] =>
		createOciSandboxDrivers({
			tiers,
			runtime: name,
			flavor,
			cgroups: placement,
			calls: makeCalls(path, join(input.run, `state-${name}`), flags),
			images: input.images,
			workRoot: join(input.run, "sandbox"),
			rootless,
			log: input.log,
		});
	if (name !== "runsc") {
		if (cgroups.mode !== "delegated")
			return unavailable(
				name,
				`a host ${name} needs delegated cgroups for its limits: ${cgroups.detail}`,
			);
		return [...oci([SandboxTier.S1_CONTAINER], "oci", cgroups, []), kata];
	}
	const both = [SandboxTier.S1_CONTAINER, SandboxTier.S2_USER_KERNEL];
	const sentry: CgroupPlacement = { mode: "sentry" };
	return [
		...(cgroups.mode === "delegated"
			? oci(both, "runsc", cgroups, runscFlags(cgroups))
			: []),
		...oci(both, "runsc", sentry, runscFlags(sentry)),
		kata,
	];
}

/** This platform's driver candidates, in preference order. */
export async function platformCandidates(
	platform: NodeJS.Platform,
	log: FleetLog,
	settings: SandboxSettings,
): Promise<readonly SandboxDriver[]> {
	if (platform === "darwin")
		return [createMicroVmSandboxDriver(APPLE_CONTAINER_RUNTIME, log)];
	if (platform !== "linux") return [];
	return linuxDriversFor(await probeLinuxHost(settings), log);
}

/** The Linux candidates for a probed host, over the agent's own run and image directories. */
export function linuxDriversFor(
	setup: HostSetup,
	log: FleetLog,
): readonly SandboxDriver[] {
	const uid = process.getuid?.() ?? 0;
	const rootful = setup.privilege.mode === "rootful";
	const home = rootful
		? traversable("/var/lib/hobo-fleet")
		: join(
				process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
				"hobo-fleet",
			);
	const run = rootful
		? traversable("/run/hobo-fleet")
		: join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `hobo-fleet-${uid}`);
	const images = createRegistryImageStore({
		cacheDir: rootful
			? traversable(join(home, "images"))
			: join(home, "images"),
		fetch,
		// Only a rootful host runtime maps sandbox ids to the reserved range; rootful runsc has no user namespace.
		idShift:
			rootful && setup.runtime.ok && setup.runtime.runtime.name !== "runsc"
				? ROOTFUL_ID_BASE
				: 0,
	});
	return linuxCandidates(setup, { log, run, images });
}
