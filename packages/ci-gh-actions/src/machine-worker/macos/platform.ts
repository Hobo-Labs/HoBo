import type { MachineIsolation } from "@hobo/ci";
import { machinePlatform } from "../session.js";

export type MachineConnectAsk = Readonly<{ host: boolean; vm: boolean }>;

export type AppleContainerStatus =
	| Readonly<{ available: true }>
	| Readonly<{ available: false; reason: string }>;

export type MachineMode = "container" | "host" | "vm";

export type MachineConnectPlan =
	| Readonly<{
			ok: true;
			mode: MachineMode;
			os: "linux" | "macos";
			arch: "x64" | "arm64";
			isolation: MachineIsolation;
	  }>
	| Readonly<{ ok: false; reason: string }>;

function refuse(reason: string): MachineConnectPlan {
	return { ok: false, reason };
}

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
