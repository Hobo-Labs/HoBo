import { existsSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ownerWriteGuard } from "../../src/owner-write-guard.js";

const [action, cwd] = process.argv.slice(2);
if (!cwd) throw new Error("A synthetic project path is required.");
const guard = ownerWriteGuard(`cd\u0000${cwd}`, cwd);
try {
	const pause = new Int32Array(new SharedArrayBuffer(4));
	if (action === "revision") {
		writeSync(1, `${guard.currentSettingsRevision()}\n`);
	} else if (action === "increment-revision") {
		const generation = guard.currentSelection().generation;
		writeSync(1, `${guard.advanceSettingsRevision(generation)}\n`);
	} else if (action === "legacy-aba") {
		const generation = guard.currentSelection().generation;
		guard.advanceSettingsRevision(generation);
		writeFileSync(join(cwd, "synthetic-legacy-setting"), "second");
		guard.advanceSettingsRevision(generation);
		writeFileSync(join(cwd, "synthetic-legacy-setting"), "first");
		writeSync(1, "changed\n");
	} else if (action === "prepared" || action === "prepared-hold") {
		const generation = guard.currentSelection().generation;
		const revision = guard.currentPreparationSnapshot(generation);
		writeSync(1, "prepared\n");
		if (action === "prepared-hold") Atomics.wait(pause, 0, 0);
		while (!existsSync(join(cwd, "synthetic-release")))
			Atomics.wait(pause, 0, 0, 10);
		await guard.run(
			async () => {
				writeFileSync(join(cwd, "synthetic-stale-effect"), "applied");
				writeSync(1, "entered\n");
			},
			() => false,
			generation,
			() => true,
			undefined,
			revision,
		);
	} else if (action === "lock") {
		const directory = join(
			process.env.XDG_STATE_HOME ?? "",
			"hobo",
			"owner-write-guards",
		);
		const name = readdirSync(directory).find((file) =>
			file.endsWith(".sqlite"),
		);
		if (!name) throw new Error("A synthetic guard database is required.");
		const database = new DatabaseSync(join(directory, name));
		database.exec("BEGIN IMMEDIATE");
		writeSync(1, "locked\n");
		while (!existsSync(join(cwd, "synthetic-release")))
			Atomics.wait(pause, 0, 0, 10);
		database.exec("COMMIT");
		database.close();
	} else {
		const selected =
			action === "stale" ? guard.currentSelection().generation : undefined;
		if (action === "stale") {
			writeSync(1, "selected\n");
			while (!existsSync(join(cwd, "synthetic-release")))
				Atomics.wait(pause, 0, 0, 10);
		}
		await guard.run(
			async () => {
				if (action === "stale")
					writeFileSync(join(cwd, "synthetic-stale-effect"), "applied");
				if (action === "hold" || action === "finish")
					writeFileSync(join(cwd, "synthetic-effect"), "applied");
				writeSync(1, "entered\n");
				if (action === "hold") Atomics.wait(pause, 0, 0);
				if (action === "finish") {
					while (!existsSync(join(cwd, "synthetic-release")))
						Atomics.wait(pause, 0, 0, 10);
				}
			},
			() => false,
			selected,
		);
	}
} catch {
	writeSync(1, "refused\n");
}
