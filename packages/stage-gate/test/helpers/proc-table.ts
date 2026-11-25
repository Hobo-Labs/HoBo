import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PGID = 4242;
export const GROUP = { pgid: PGID, sid: PGID } as const;

export interface ProcEntry {
	readonly pid: number;
	readonly comm: string;
	readonly state: string;
	readonly pgrp: number;
	readonly session?: number;
	readonly threads: number;
}

export function statLine({
	pid,
	comm,
	state,
	pgrp,
	session = pgrp,
	threads,
}: ProcEntry): string {
	const flags = "0 -1 4227084 91 0 0 0 0 0 0 0 20 0";
	const rest = `0 414627 0 0 18446744073709551615${" 0".repeat(13)} 17${" 0".repeat(13)}`;
	return `${pid} (${comm}) ${state} 1 ${pgrp} ${session} ${flags} ${threads} ${rest}\n`;
}

export const zombie = (pid: number): ProcEntry => ({
	pid,
	comm: "sleep",
	state: "Z",
	pgrp: PGID,
	threads: 1,
});

export interface ProcTables {
	readonly dir: string;
	readonly table: (entries: readonly ProcEntry[], selfPid?: number) => string;
	readonly remove: () => void;
}

export function procTables(): ProcTables {
	const dir = mkdtempSync(join(tmpdir(), "hobo-proc-table-"));
	let made = 0;
	return {
		dir,
		table(entries, selfPid = process.pid) {
			made += 1;
			const root = join(dir, `proc-${made}`);
			mkdirSync(root, { recursive: true });
			symlinkSync(String(selfPid), join(root, "self"));
			for (const entry of entries) {
				mkdirSync(join(root, String(entry.pid)));
				writeFileSync(join(root, String(entry.pid), "stat"), statLine(entry));
			}
			return root;
		},
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
}
