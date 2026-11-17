/**
 * How a computer connects as a machine, from its OS, its CPU and what its
 * owner asked for (ADR-0183).
 *
 * Linux keeps its default: a fresh container per job, or the host with
 * `--host`. A Mac has no container default, so it must be asked for one of
 * two things: `--host`, which runs each job on the Mac as the user who
 * connected it (the advert says `host`, and the labels are `self-hosted`,
 * `macOS` and the CPU), or `--vm`, which runs each job in its own Linux VM
 * through Apple's `container` tool (the advert says `container`, and the
 * labels are the VM's: `self-hosted`, `Linux`, `ARM64`). A `--vm` that cannot
 * be honoured is refused with the reason; it never falls back to the host.
 */
import type { MachineIsolation } from "@hobo/ci";
import { machinePlatform } from "../session.js";

/** What the owner asked for on the command line. */
export type MachineConnectAsk = Readonly<{ host: boolean; vm: boolean }>;

/** Whether Apple's `container` tool can run a VM now, or why not. */
export type AppleContainerStatus =
	| Readonly<{ available: true }>
	| Readonly<{ available: false; reason: string }>;

/** Where jobs run: a container, the host, or a Linux VM per job on a Mac. */
export type MachineMode = "container" | "host" | "vm";

/** How this computer connects, or why it cannot as asked. */
export type MachineConnectPlan =
	| Readonly<{
			ok: true;
			mode: MachineMode;
			/** The OS and CPU jobs see, which the advert's labels name. */
			os: "linux" | "macos";
			arch: "x64" | "arm64";
			isolation: MachineIsolation;
	  }>
	| Readonly<{ ok: false; reason: string }>;

function refuse(reason: string): MachineConnectPlan {
	return { ok: false, reason };
}

/**
 * The plan for a computer (`process.platform`, `process.arch`). `appleContainer`
 * is the probe of Apple's tool, made only when `--vm` was asked on a Mac;
 * `undefined` means it was not probed and `--vm` is refused.
 */
export function machineConnectPlan(
	where: Readonly<{ platform: string; arch: string }>,
	ask: MachineConnectAsk,
	appleContainer: AppleContainerStatus | undefined,
): MachineConnectPlan {
	if (ask.host && ask.vm)
		return refuse(
			"Give --host or --vm, not both: --host runs jobs on this machine, --vm in a Linux VM each.",
		);
	if (where.platform === "linux") {
		if (ask.vm)
			return refuse(
				"--vm runs each job in a Linux VM through Apple's container tool, which runs only on a Mac; on Linux each job already runs in a fresh container.",
			);
		const linux = machinePlatform(where.platform, where.arch);
		if (!linux.supported) return refuse(linux.reason);
		return ask.host
			? {
					ok: true,
					mode: "host",
					os: "linux",
					arch: linux.arch,
					isolation: "host",
				}
			: {
					ok: true,
					mode: "container",
					os: "linux",
					arch: linux.arch,
					isolation: "container",
				};
	}
	if (where.platform !== "darwin")
		return refuse(
			`Only Linux and macOS machines can connect (this one is ${where.platform}).`,
		);
	if (where.arch !== "x64" && where.arch !== "arm64")
		return refuse(
			`Only x64 and arm64 machines can connect (this one is ${where.arch}).`,
		);
	if (ask.vm) {
		if (where.arch !== "arm64")
			return refuse(
				"--vm needs Apple silicon: Apple's container tool does not run on an Intel Mac. Connect with --host instead.",
			);
		if (appleContainer === undefined)
			return refuse(
				"--vm needs Apple's container tool, and it was not checked; jobs never fall back to the host.",
			);
		if (!appleContainer.available)
			return refuse(
				`${appleContainer.reason} --vm never falls back to the host; connect with --host to run jobs on this Mac.`,
			);
		return {
			ok: true,
			mode: "vm",
			os: "linux",
			arch: "arm64",
			isolation: "container",
		};
	}
	if (!ask.host)
		return refuse(
			"A Mac has no container default: its jobs would run on this machine as you. Connect with --host to accept that, or with --vm on Apple silicon to run each job in its own Linux VM through Apple's container tool.",
		);
	return {
		ok: true,
		mode: "host",
		os: "macos",
		arch: where.arch,
		isolation: "host",
	};
}
