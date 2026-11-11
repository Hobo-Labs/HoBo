/**
 * The mesh part of `hobo ci status`: the relay mesh's nodes as a table, from
 * the relay when one can be asked, and from this machine's own report when
 * none can.
 *
 * A machine that runs jobs for a repository (`local:runner`) is a mesh node
 * and keeps a report of what it sees in its state directory. That file is
 * what makes `status` answer offline: no relay, no credential, no network.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toJson } from "@bufbuild/protobuf";
import {
	type MeshNodeReport,
	type MeshNodeReports,
	MeshNodeReportsSchema,
	parseMeshNodeReports,
} from "@hobo/ci-gh-actions/client";

/** A size in MiB as a person reads it; an unknown one is a dash. */
function size(megabytes: number | undefined): string {
	if (megabytes === undefined) return "-";
	if (megabytes < 1024) return `${megabytes} MB`;
	const gigabytes = megabytes / 1024;
	return `${gigabytes >= 100 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
}

/** The share of jobs delivered, with the counts behind it when the node gives them. */
function reliability(node: MeshNodeReport): string {
	if (node.reliability === undefined) return "-";
	const share = node.reliability.toFixed(2);
	return node.delivered === undefined || node.dropped === undefined
		? share
		: `${share} (${Math.round(node.delivered)} ok, ${Math.round(node.dropped)} dropped)`;
}

function row(node: MeshNodeReport): string[] {
	// A node that is gone has no capacity to offer; its last figures would mislead.
	const lost = node.state === "lost";
	return [
		node.id,
		node.state,
		lost ? "-" : `${node.freeSlots}/${node.totalSlots}`,
		lost ? "-" : size(node.freeMemoryMb),
		lost ? "-" : size(node.freeDiskMb),
		reliability(node),
		node.trust,
	];
}

const HEADINGS = [
	"NODE",
	"STATE",
	"SLOTS",
	"MEMORY",
	"DISK",
	"RELIABILITY",
	"TRUST",
];

/**
 * The nodes as a table: node, state, free/total slots, free memory, free
 * disk, reliability and trust, with a line above saying how the answering
 * host stands to a mesh and one below with what the live nodes add up to.
 */
export function meshNodesTable(reports: MeshNodeReports): string {
	if (reports.mesh === "not-configured" && reports.nodes.length === 0)
		return "Mesh: not configured on this relay (no HOBO_CI_NATS_URL); no nodes to list.";
	const rows = [HEADINGS, ...reports.nodes.map(row)];
	const widths = HEADINGS.map((_, column) =>
		Math.max(...rows.map((cells) => (cells[column] ?? "").length)),
	);
	const lines = rows.map((cells) =>
		cells
			.map((cell, column) => cell.padEnd(widths[column] ?? 0))
			.join("  ")
			.trimEnd(),
	);
	const heading =
		reports.mesh === "configured"
			? `Mesh: ${reports.nodes.length} node(s) as of ${reports.readAt}`
			: reports.mesh === "unreachable"
				? `Mesh: unreachable; the last reading, as of ${reports.readAt}`
				: `Mesh: not configured; this machine's own report as of ${reports.readAt}`;
	const capacity = reports.capacity;
	const summary = capacity
		? `Capacity: ${capacity.freeSlots}/${capacity.totalSlots} slots free on ${capacity.healthy} healthy node(s); ${size(capacity.freeMemoryMb)} memory and ${size(capacity.freeDiskMb)} disk free.`
		: "";
	const trust = reports.requireTrusted
		? "Only trusted nodes are ranked for jobs."
		: "Trust: trusted = key in the mesh's trusted set; unverified = signed by an unlisted key, or unsigned; invalid = signature failed, never ranked.";
	// The relay lists at most a few hundred nodes; the summary covers them all.
	const truncated = reports.truncated
		? `More nodes are known than are listed; ${reports.nodes.length} shown.`
		: "";
	return [heading, ...lines, truncated, summary, trust]
		.filter((line) => line !== "")
		.join("\n");
}

/** The reports as plain JSON, for `--json`. */
export function meshNodesData(reports: MeshNodeReports) {
	return toJson(MeshNodeReportsSchema, reports, { alwaysEmitImplicit: true });
}

/**
 * This machine's own mesh report, when a local runner has written one:
 * `mesh-node.json` in its state directory (`HOBO_CI_LOCAL_STATE_DIRECTORY`,
 * or `.hobo/ci-local` in the repository). Nothing when there is none or it
 * cannot be read.
 */
export async function localMeshReport(
	repositoryRoot: string,
	env: Readonly<Record<string, string | undefined>>,
): Promise<MeshNodeReports | undefined> {
	const state = resolve(
		repositoryRoot,
		env.HOBO_CI_LOCAL_STATE_DIRECTORY ?? join(".hobo", "ci-local"),
	);
	try {
		const text = await readFile(join(state, "mesh-node.json"), "utf8");
		// A report is small; one that is not is not a report.
		return text.length > 1024 * 1024 ? undefined : parseMeshNodeReports(text);
	} catch {
		return undefined;
	}
}
