export const MACHINE_SHARING = ["only_me", "anyone"] as const;
export type MachineSharing = (typeof MACHINE_SHARING)[number];

export type MachineCandidate = Readonly<{
	id: string;
	name: string;
	runsOn: string;
	labels: readonly string[];
	online: boolean;
	paused: boolean;
	slots: number;
	busy: number;
	sharing: MachineSharing;
	ownerId: string;
	ownerCanRead: boolean;
	lastPickedAtMs: number;
	repository: string | undefined;
}>;

export type MachineWant = Readonly<{
	labels: readonly string[];
	repository: string;
	starterId: string | undefined;
	triggeredById: string | undefined;
	preferMachineId: string | undefined;
	avoidMachineId: string | undefined;
}>;

export type MachineRefusal =
	| "no_machine"
	| "machine_not_shared"
	| "machine_paused"
	| "machine_full";

export type MachineChoice =
	| Readonly<{ kind: "machine"; machine: MachineCandidate }>
	| Readonly<{
			kind: "none";
			reason: MachineRefusal;
			machine: MachineCandidate | undefined;
	  }>;

export function machineLabels(
	os: "linux" | "macos" | "windows",
	arch: "x64" | "arm64" | "arm",
): readonly string[] {
	const osLabel =
		os === "linux" ? "Linux" : os === "macos" ? "macOS" : "Windows";
	return ["self-hosted", osLabel, arch.toUpperCase()];
}

function fits(machine: MachineCandidate, want: MachineWant): boolean {
	if (!machine.online) return false;
	if (
		machine.repository !== undefined &&
		machine.repository.toLowerCase() !== want.repository.toLowerCase()
	)
		return false;
	const has = new Set(machine.labels.map((label) => label.toLowerCase()));
	return want.labels.every((label) => has.has(label.toLowerCase()));
}

export function admits(machine: MachineCandidate, want: MachineWant): boolean {
	if (!machine.ownerCanRead) return false;
	const ownStart =
		want.starterId === machine.ownerId &&
		want.triggeredById === machine.ownerId;
	if (machine.sharing === "only_me") return ownStart;
	return true;
}

function rank(machine: MachineCandidate, want: MachineWant): number {
	if (machine.id === want.preferMachineId) return 0;
	if (machine.id === want.avoidMachineId) return 3;
	return machine.ownerId === want.starterId ? 1 : 2;
}

function byPreference(
	want: MachineWant,
): (left: MachineCandidate, right: MachineCandidate) => number {
	return (left, right) =>
		rank(left, want) - rank(right, want) ||
		left.lastPickedAtMs - right.lastPickedAtMs ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function chooseMachine(
	candidates: readonly MachineCandidate[],
	want: MachineWant,
): MachineChoice {
	const order = byPreference(want);
	const fitting = candidates.filter((machine) => fits(machine, want));
	if (fitting.length === 0)
		return { kind: "none", reason: "no_machine", machine: undefined };
	const admitted = fitting.filter((machine) => admits(machine, want));
	if (admitted.length === 0)
		return {
			kind: "none",
			reason: "machine_not_shared",
			machine: [...fitting].sort(order)[0],
		};
	const awake = admitted.filter((machine) => !machine.paused);
	if (awake.length === 0)
		return {
			kind: "none",
			reason: "machine_paused",
			machine: [...admitted].sort(order)[0],
		};
	const free = awake.filter((machine) => machine.busy < machine.slots);
	const sorted = [...(free.length > 0 ? free : awake)].sort(order);
	const machine = sorted[0];
	if (free.length === 0 || !machine)
		return { kind: "none", reason: "machine_full", machine };
	return { kind: "machine", machine };
}
