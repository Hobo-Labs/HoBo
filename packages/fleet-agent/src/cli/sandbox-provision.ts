#!/usr/bin/env node
/**
 * `fleet-agent sandbox provision` (D58): provisions the pinned gVisor runtime
 * and probes this host with the same code the agent's `sandboxDrivers` runs,
 * so CI and devices share one path.
 *
 *   node --import tsx packages/fleet-agent/src/cli/sandbox-provision.ts [--cache <dir>] [--probe]
 *
 * Prints one JSON object: `{runtime, version, arch, digest, mode, cgroups,
 * reason?}`, `mode` being `rootful`, `rootless` or `unavailable` and
 * `cgroups` `delegated` or `sentry`. With `--probe` it also starts a trial
 * sandbox (each candidate's self-test) and reports where the limits ended up.
 * Exits 0 when a mode is available, 3 when not, 2 on bad arguments.
 * `HOBO_FLEET_SANDBOX_RUNTIME` and `HOBO_FLEET_SANDBOX_DOWNLOAD` apply as
 * they do for the agent.
 */
import { pathToFileURL } from "node:url";
import { type FleetLog, SandboxTier } from "@hobo/fleet";
import {
	type HostSetup,
	linuxDriversFor,
	probeLinuxHost,
	type SandboxSettings,
	sandboxSettings,
	selectSandboxDrivers,
} from "../sandbox/index.js";
import { GVISOR_PIN, gvisorArch } from "../sandbox/runtime-provision.js";

const USAGE = "usage: sandbox-provision [--cache <dir>] [--probe]\n";

export type SelfTestAnswer =
	| Readonly<{ ok: true; cgroups: "delegated" | "sentry" }>
	| Readonly<{ ok: false; reason: string }>;

export type ProvisionDeps = Readonly<{
	platform: NodeJS.Platform;
	env: Readonly<Record<string, string | undefined>>;
	euid: number;
	probeHost(settings: SandboxSettings): Promise<HostSetup>;
	selfTest(
		setup: HostSetup,
		settings: SandboxSettings,
	): Promise<SelfTestAnswer>;
}>;

// domain-view: the JSON this command prints.
type Report = Readonly<{
	runtime: string;
	version: string;
	arch: string;
	digest: string | null;
	mode: "rootful" | "rootless" | "unavailable";
	cgroups: "delegated" | "sentry";
	reason?: string;
}>;

type Parsed = Readonly<{ cache: string | undefined; probe: boolean }>;

function parse(argv: readonly string[]): Parsed | undefined {
	let cache: string | undefined;
	let probe = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--probe") probe = true;
		else if (arg === "--cache") {
			cache = argv[i + 1];
			if (cache === undefined || cache === "") return undefined;
			i += 1;
		} else return undefined;
	}
	return { cache, probe };
}

/** Runs the command; answers its exit code and what it prints on standard output. */
export async function runSandboxProvision(
	argv: readonly string[],
	deps: ProvisionDeps,
): Promise<Readonly<{ code: 0 | 2 | 3; output: string }>> {
	const parsed = parse(argv);
	if (parsed === undefined) return { code: 2, output: USAGE };
	const defaults = sandboxSettings(deps.env, deps.euid);
	const settings: SandboxSettings =
		parsed.cache === undefined
			? defaults
			: { ...defaults, cacheDir: parsed.cache };
	const print = (report: Report) => ({
		code: report.mode === "unavailable" ? (3 as const) : (0 as const),
		output: `${JSON.stringify(report)}\n`,
	});
	const unavailable = (reason: string, base: Partial<Report> = {}) =>
		print({
			runtime: "runsc",
			version: GVISOR_PIN.release,
			arch: gvisorArch(process.arch) ?? process.arch,
			digest: null,
			cgroups: "sentry",
			...base,
			mode: "unavailable",
			reason,
		});
	if (deps.platform !== "linux")
		return unavailable(
			`unsupported-platform: the sandbox runtime is provisioned on Linux only, not ${deps.platform}`,
		);
	const setup = await deps.probeHost(settings);
	if (!setup.runtime.ok)
		return unavailable(`${setup.runtime.reason}: ${setup.runtime.detail}`, {
			cgroups: setup.cgroups.mode,
		});
	const { runtime } = setup.runtime;
	const found = {
		runtime: runtime.name,
		version: runtime.version,
		arch: runtime.arch ?? process.arch,
		digest: runtime.digest ?? null,
		cgroups: setup.cgroups.mode,
	};
	if (setup.privilege.mode === "unavailable")
		return unavailable(
			`${setup.privilege.reason}: ${setup.privilege.detail}`,
			found,
		);
	if (!parsed.probe) return print({ ...found, mode: setup.privilege.mode });
	const answer = await deps.selfTest(setup, settings);
	if (!answer.ok) return unavailable(answer.reason, found);
	return print({
		...found,
		mode: setup.privilege.mode,
		cgroups: answer.cgroups,
	});
}

/** The real self-test: the agent's own Linux candidates, an `S1_CONTAINER` driver required. */
async function selfTest(setup: HostSetup): Promise<SelfTestAnswer> {
	const reasons: string[] = [];
	const log: FleetLog = (event, fields) => {
		if (event === "hobo_fleet_sandbox_unavailable")
			reasons.push(String(fields.reason));
	};
	const candidates = linuxDriversFor(setup, log);
	const chosen = await selectSandboxDrivers(candidates, undefined);
	const s1 = chosen.find((driver) => driver.tier === SandboxTier.S1_CONTAINER);
	if (s1 === undefined)
		return {
			ok: false,
			reason: `no S1 sandbox passed its self-test: ${reasons.join("; ")}`,
		};
	// With delegated cgroups the first candidate uses them; the sentry-limited one follows.
	const delegated = setup.cgroups.mode === "delegated" && candidates[0] === s1;
	return { ok: true, cgroups: delegated ? "delegated" : "sentry" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const answer = await runSandboxProvision(process.argv.slice(2), {
		platform: process.platform,
		env: process.env,
		euid: process.geteuid?.() ?? 0,
		probeHost: probeLinuxHost,
		selfTest,
	});
	(answer.code === 2 ? process.stderr : process.stdout).write(answer.output);
	process.exitCode = answer.code;
}
