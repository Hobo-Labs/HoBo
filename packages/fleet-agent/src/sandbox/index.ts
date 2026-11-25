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

export async function sandboxDrivers(
	options: Readonly<{ cap?: SandboxTier; log: FleetLog }>,
): Promise<readonly SandboxDriver[]> {
	return configuredSandboxDrivers({
		...options,
		settings: sandboxSettings(process.env, process.geteuid?.() ?? 0),
	});
}

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
	hostRuntime: string | undefined;
	cacheDir: string;
	allowDownload: boolean;
}>;

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

export type HostSetup = Readonly<{
	runtime: RuntimeResolution;
	privilege: Privilege;
	cgroups: Cgroups;
}>;

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

export function runscFlags(cgroups: CgroupPlacement): readonly string[] {
	const flags = ["--network=none", "--host-uds=open", "--oci-seccomp"];
	if (cgroups.mode === "sentry") flags.push("--ignore-cgroups");
	return flags;
}

function traversable(dir: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o711 });
	chmodSync(dir, 0o711);
	return dir;
}

const BOTH_TIERS = "S1_CONTAINER,S2_USER_KERNEL";

export function linuxCandidates(
	setup: HostSetup,
	input: Readonly<{
		log: FleetLog;
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
		idShift:
			rootful && setup.runtime.ok && setup.runtime.runtime.name !== "runsc"
				? ROOTFUL_ID_BASE
				: 0,
	});
	return linuxCandidates(setup, { log, run, images });
}
