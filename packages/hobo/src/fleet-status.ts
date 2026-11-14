/**
 * The table `hobo fleet status` prints, and `hobo ci status` under it (design
 * §6.15; it replaces the mesh table `ci-mesh-status.ts` printed): per fleet,
 * its members with state, availability and health, free/total slots, free
 * memory and disk, reliability and the sandbox tiers they offer, then what the
 * fleet adds up to.
 */
import {
	Availability,
	type FleetMemberView,
	type FleetView,
	Health,
	MemberState,
	SandboxTier,
} from "@hobo/fleet";

// domain-view: one fleet as status shows it; `view` is absent when the authority would not answer for it.
export type NamedFleetView = Readonly<{
	fleet: string;
	view: FleetView | undefined;
}>;

/** A size in MiB as a person reads it; an unknown one is a dash. */
function size(megabytes: number | undefined): string {
	if (megabytes === undefined) return "-";
	if (megabytes < 1024) return `${megabytes} MB`;
	const gigabytes = megabytes / 1024;
	return `${gigabytes >= 100 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
}

const STATES = new Map<number, string>([
	[MemberState.PENDING, "pending"],
	[MemberState.ACTIVE, "active"],
	[MemberState.SUSPENDED, "suspended"],
	[MemberState.LOCKED, "locked"],
	[MemberState.REVOKED, "revoked"],
	[MemberState.REJECTED, "rejected"],
]);

const AVAILABILITY = new Map<number, string>([
	[Availability.LIVE, "live"],
	[Availability.UNHEALTHY, "unhealthy"],
	[Availability.LOST, "lost"],
]);

const HEALTH = new Map<number, string>([
	[Health.REACHABLE, "reachable"],
	[Health.DRAINING, "draining"],
	[Health.PRESSURED, "pressured"],
	[Health.UNREACHABLE, "unreachable"],
	[Health.QUOTA_EXHAUSTED, "quota-exhausted"],
	[Health.AUTH, "auth"],
	[Health.UNKNOWN, "unknown"],
]);

const TIERS = new Map<number, string>([
	[SandboxTier.S1_CONTAINER, "S1"],
	[SandboxTier.S2_USER_KERNEL, "S2"],
	[SandboxTier.S3_MICROVM, "S3"],
]);

function reliability(member: FleetMemberView): string {
	if (member.reliability === undefined) return "-";
	const share = member.reliability.toFixed(2);
	return member.samples === undefined
		? share
		: `${share} (${Math.round(member.samples.delivered)} ok, ${Math.round(member.samples.dropped)} dropped)`;
}

function row(member: FleetMemberView): string[] {
	// A member that is lost has no capacity to offer; its last figures would mislead.
	const lost = member.availability === Availability.LOST;
	const capacity = member.capacity;
	return [
		member.name || member.memberId,
		STATES.get(member.state) ?? "-",
		AVAILABILITY.get(member.availability) ?? "-",
		HEALTH.get(member.health) ?? "-",
		lost || capacity === undefined
			? "-"
			: `${capacity.freeSlots}/${capacity.totalSlots ?? "?"}`,
		lost ? "-" : size(capacity?.freeMemoryMb),
		lost ? "-" : size(capacity?.freeDiskMb),
		reliability(member),
		member.sandboxTiers.map((tier) => TIERS.get(tier) ?? "?").join(",") || "-",
	];
}

const HEADINGS = [
	"MEMBER",
	"STATE",
	"AVAILABILITY",
	"HEALTH",
	"SLOTS",
	"MEMORY",
	"DISK",
	"RELIABILITY",
	"TIER",
];

function table(rows: readonly (readonly string[])[]): string[] {
	const widths = HEADINGS.map((_, column) =>
		Math.max(...rows.map((cells) => (cells[column] ?? "").length)),
	);
	return rows.map((cells) =>
		cells
			.map((cell, column) => cell.padEnd(widths[column] ?? 0))
			.join("  ")
			.trimEnd(),
	);
}

function fleetSection(entry: NamedFleetView): string[] {
	const view = entry.view;
	if (view === undefined)
		return [`Fleet ${entry.fleet}: the authority returned no view.`];
	const lines = [
		`Fleet ${entry.fleet}: ${view.members.length} member(s) as of ${view.asOf}`,
		...table([HEADINGS, ...view.members.map(row)]),
	];
	if (view.truncated)
		lines.push(
			`More members are known than are listed; ${view.members.length} shown.`,
		);
	const capacity = view.capacity;
	if (capacity !== undefined)
		lines.push(
			`Capacity: ${capacity.freeSlots}/${capacity.totalSlots} slots free on ${capacity.healthy} healthy of ${capacity.live} live member(s); ${size(capacity.freeMemoryMb)} memory and ${size(capacity.freeDiskMb)} disk free.`,
		);
	return lines;
}

/** Every fleet's section, separated by a blank line. */
export function fleetStatusTable(views: readonly NamedFleetView[]): string {
	if (views.length === 0) return "No fleets.";
	return views.map((entry) => fleetSection(entry).join("\n")).join("\n\n");
}
