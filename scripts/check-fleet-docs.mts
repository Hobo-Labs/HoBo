#!/usr/bin/env node
/**
 * `pnpm run fleet:docs` (O27, ADR-0182): the fleet's vocabulary and its
 * documents agree. Three checks, each a list of gaps:
 *
 * 1. every event type in `packages/fleet/src/events.ts` appears in
 *    `docs/design/fleet.md` and is covered by the `fleet.*` row of
 *    `docs/design/event-families.md`;
 * 2. every `ADR-NNNN` in `docs/design/fleet.md` and `docs/design/adr/fleet.md`
 *    is a row of `docs/design/adr/index.md`;
 * 3. every runbook of the operations section has its file under
 *    `docs/maintenance/fleet/` (`FLEET_RUNBOOKS`).
 *
 *   node --import tsx scripts/check-fleet-docs.mts [--root=<dir>]
 *
 * Exits 1 when any gap is found.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DocsGap {
	readonly kind: "document" | "event" | "event-family" | "adr" | "runbook";
	readonly subject: string;
	readonly detail: string;
}

const EVENTS_FILE = "packages/fleet/src/events.ts";
const DESIGN_DOC = "docs/design/fleet.md";
const ADR_DOC = "docs/design/adr/fleet.md";
const ADR_INDEX = "docs/design/adr/index.md";
const EVENT_FAMILIES = "docs/design/event-families.md";
const RUNBOOK_DIR = "docs/maintenance/fleet";

/**
 * One file per runbook of the operations section, in its order: install and
 * upgrade; enroll, suspend, unlock, revoke; rotate each key; backup and
 * restore drill; NATS server loss; callout outage; clone alarm;
 * claim-violation alarm; witness outage; relay outage; one-active fleet stuck
 * sealed.
 */
export const FLEET_RUNBOOKS = [
	"install-and-upgrade.md",
	"enroll-suspend-unlock-revoke.md",
	"rotate-keys.md",
	"backup-and-restore-drill.md",
	"nats-server-loss.md",
	"callout-outage.md",
	"clone-alarm.md",
	"claim-violation-alarm.md",
	"witness-outage.md",
	"relay-outage.md",
	"one-active-fleet-stuck-sealed.md",
] as const;

function read(root: string, path: string): string | undefined {
	const absolute = join(root, path);
	return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function mentions(text: string, name: string): boolean {
	return new RegExp(`(?<![\\w.])${escape(name)}(?![\\w])`, "u").test(text);
}

/** The `fleet.<PascalCase>` event types `events.ts` declares, in order, once each. */
export function fleetEventTypes(source: string): string[] {
	return [
		...new Set(
			[...source.matchAll(/["'`](fleet\.[A-Z][A-Za-z0-9]*)["'`]/gu)].map(
				(match) => match[1] ?? "",
			),
		),
	];
}

/** Every gap between the fleet's vocabulary and its documents under `root`. */
export function checkFleetDocs(root: string): DocsGap[] {
	const gaps: DocsGap[] = [];
	const missing = (path: string): void => {
		gaps.push({
			kind: "document",
			subject: path,
			detail: `${path} does not exist`,
		});
	};

	const events = read(root, EVENTS_FILE);
	const design = read(root, DESIGN_DOC);
	const adr = read(root, ADR_DOC);
	const index = read(root, ADR_INDEX);
	const families = read(root, EVENT_FAMILIES);
	for (const [path, text] of [
		[EVENTS_FILE, events],
		[DESIGN_DOC, design],
		[ADR_DOC, adr],
		[ADR_INDEX, index],
		[EVENT_FAMILIES, families],
	] as const)
		if (text === undefined) missing(path);

	// 1. Events against the design document and the family row.
	const types = events === undefined ? [] : fleetEventTypes(events);
	for (const type of types)
		if (design === undefined || !mentions(design, type))
			gaps.push({
				kind: "event",
				subject: type,
				detail: `${type} is not in ${DESIGN_DOC}`,
			});
	if (families !== undefined) {
		const row = families
			.split("\n")
			.find((line) => /^\|\s*`fleet\.\*`\s*\|/u.test(line));
		if (row === undefined)
			gaps.push({
				kind: "event-family",
				subject: "fleet.*",
				detail: `${EVENT_FAMILIES} has no \`fleet.*\` row`,
			});
		else
			for (const type of types)
				if (!mentions(row, type))
					gaps.push({
						kind: "event-family",
						subject: type,
						detail: `${type} is not covered by the \`fleet.*\` row of ${EVENT_FAMILIES}`,
					});
	}

	// 2. ADR mentions against the index.
	const rows = new Set(
		(index ?? "")
			.split("\n")
			.map((line) => /^\|\s*(\d{4})\s*\|/u.exec(line)?.[1])
			.filter((id): id is string => id !== undefined),
	);
	if (index !== undefined) {
		const seen = new Set<string>();
		for (const [path, text] of [
			[DESIGN_DOC, design],
			[ADR_DOC, adr],
		] as const)
			for (const match of (text ?? "").matchAll(/\bADR-(\d{4})\b/gu)) {
				const id = match[1] ?? "";
				if (rows.has(id) || seen.has(id)) continue;
				seen.add(id);
				gaps.push({
					kind: "adr",
					subject: `ADR-${id}`,
					detail: `ADR-${id} (${path}) is not a row of ${ADR_INDEX}`,
				});
			}
	}

	// 3. Runbooks.
	for (const runbook of FLEET_RUNBOOKS) {
		const path = `${RUNBOOK_DIR}/${runbook}`;
		if (!existsSync(join(root, path)))
			gaps.push({
				kind: "runbook",
				subject: path,
				detail: `runbook ${path} does not exist`,
			});
	}
	return gaps;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const rootArg = process.argv
		.slice(2)
		.find((arg) => arg.startsWith("--root="))
		?.slice("--root=".length);
	const root = rootArg
		? resolve(rootArg)
		: resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const gaps = checkFleetDocs(root);
	for (const gap of gaps) process.stderr.write(`${gap.kind}: ${gap.detail}\n`);
	if (gaps.length > 0) {
		process.stderr.write(`fleet:docs: ${gaps.length} gap(s)\n`);
		process.exit(1);
	}
	process.stdout.write("fleet:docs: no gaps\n");
}
