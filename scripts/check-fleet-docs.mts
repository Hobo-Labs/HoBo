#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DocsGap {
	readonly kind: "document" | "event" | "runbook";
	readonly subject: string;
	readonly detail: string;
}

const EVENTS_FILE = "packages/fleet/src/events.ts";
const FLEET_README = "packages/fleet/README.md";
const RUNBOOK_DIR = "docs/maintenance/fleet";

export const RUNBOOK_FILES = [
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

export function declaredEventTypes(source: string): string[] {
	return [
		...new Set(
			[...source.matchAll(/["'`](fleet\.[A-Z][A-Za-z0-9]*)["'`]/gu)].map(
				(match) => match[1] ?? "",
			),
		),
	];
}

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
	const readme = read(root, FLEET_README);
	for (const [path, text] of [
		[EVENTS_FILE, events],
		[FLEET_README, readme],
	] as const)
		if (text === undefined) missing(path);

	const types = events === undefined ? [] : declaredEventTypes(events);
	for (const type of types)
		if (readme === undefined || !mentions(readme, type))
			gaps.push({
				kind: "event",
				subject: type,
				detail: `${type} is not in ${FLEET_README}`,
			});

	for (const runbook of RUNBOOK_FILES) {
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
