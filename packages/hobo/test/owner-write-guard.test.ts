import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { OwnerStoreOperationUncertainError } from "@hobo/hobo-ci/owner-store-errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerWriteGuard } from "../src/owner-write-guard.js";
import { supportsOwnerGuard } from "./support/owner-guard-support.js";

let home: string;
let project: string;
let state: string;

beforeEach(async () => {
	home = await realpath(
		await mkdtemp(join(tmpdir(), "hobo-owner-write-guard-")),
	);
	project = join(home, "synthetic-private-project");
	state = join(home, "state");
	await mkdir(project);
	vi.stubEnv("XDG_STATE_HOME", state);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
});

function guard() {
	return ownerWriteGuard(`cd\u0000${project}`, project);
}

function start(action: string, env: NodeJS.ProcessEnv = {}) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			fileURLToPath(
				new URL("./support/owner-write-guard-child.ts", import.meta.url),
			),
			action,
			project,
		],
		{
			env: { ...process.env, XDG_STATE_HOME: state, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const closed = once(child, "close");
	const output = Promise.race([
		once(child.stdout, "data").then(([chunk]) => String(chunk)),
		closed.then(() => {
			throw new Error("Child exited without reporting an outcome.");
		}),
	]);
	return { child, closed, output };
}

describe.runIf(supportsOwnerGuard())("durable owner write guard", () => {
	it("clears only a completed write and retains a failed or uncertain write", async () => {
		const selected = guard();
		expect(
			await selected.run(
				async () => "done",
				() => false,
			),
		).toBe("done");
		expect(() => selected.assertClear()).not.toThrow();
		await expect(
			selected.run(
				async () => {
					throw new Error("lost response");
				},
				() => false,
			),
		).rejects.toThrow("lost response");
		expect(() => selected.assertClear()).toThrow(/uncertain outcome/u);
		let called = false;
		await expect(
			selected.run(
				async () => {
					called = true;
				},
				() => false,
			),
		).rejects.toThrow(/uncertain outcome/u);
		expect(called).toBe(false);
	});

	it("retains a marker explicitly marked uncertain even when the callback returns", async () => {
		const selected = guard();
		let marked = false;
		const result = selected.run(
			async () => {
				marked = true;
				return "done";
			},
			() => marked,
		);
		await expect(result).rejects.toBeInstanceOf(
			OwnerStoreOperationUncertainError,
		);
		await expect(result).rejects.toThrow(/uncertain outcome/u);
		expect(() => selected.assertClear()).toThrow(/uncertain outcome/u);
	});

	it("clears a canceled prepared write after nonce installation before dispatch", async () => {
		const selected = guard();
		const failure = new Error("synthetic session closed");
		const generation = selected.currentSelection().generation;
		const revision = selected.currentPreparationSnapshot(generation);
		let dispatched = false;
		await expect(
			selected.run(
				async () => {
					dispatched = true;
				},
				() => true,
				generation,
				() => {
					throw failure;
				},
				() => false,
				revision,
			),
		).rejects.toBe(failure);
		expect(dispatched).toBe(false);
		expect(() => selected.assertClear()).not.toThrow();
		expect(
			selected.currentPreparationSnapshot(generation).operationRevision,
		).toBe(revision.operationRevision + 1);
	});

	it("keeps the nonce when the prepared-write commit acknowledgement is lost", async () => {
		const baseline = guard();
		const generation = baseline.currentSelection().generation;
		const revision = baseline.currentPreparationSnapshot(generation);
		const selected = ownerWriteGuard(`cd\u0000${project}`, project, {
			noFollow: constants.O_NOFOLLOW,
			sync: fsyncSync,
			commitStart: (database) => {
				database.exec("COMMIT");
				throw new Error("synthetic lost acknowledgement");
			},
		});
		let dispatched = false;
		await expect(
			selected.run(
				async () => {
					dispatched = true;
				},
				() => false,
				generation,
				() => true,
				undefined,
				revision,
			),
		).rejects.toThrow(/guard is unavailable/u);
		expect(dispatched).toBe(false);
		expect(() => guard().assertClear()).toThrow(/uncertain outcome/u);
		expect(guard().currentSettingsRevision()).toBe(revision.settingsRevision);
		const restarted = start("try");
		expect(await restarted.output).toBe("refused\n");
		await restarted.closed;
	});

	it("clears its nonce when a preflight refuses before the callback starts", async () => {
		const selected = guard();
		const failure = new Error("synthetic preflight refusal");
		let dispatched = false;
		await expect(
			selected.run(
				async () => {
					dispatched = true;
				},
				() => false,
				undefined,
				() => {
					throw failure;
				},
			),
		).rejects.toBe(failure);
		expect(dispatched).toBe(false);
		expect(() => selected.assertClear()).not.toThrow();
		await expect(
			selected.run(
				async () => "completed",
				() => false,
			),
		).resolves.toBe("completed");
	});

	it("does not clear independent uncertainty when preflight refuses", async () => {
		const selected = guard();
		await expect(
			selected.run(
				async () => undefined,
				() => false,
				undefined,
				() => {
					selected.markUncertain();
					throw new Error("synthetic preflight refusal");
				},
			),
		).rejects.toThrow(/uncertain outcome/u);
		expect(() => selected.assertClear()).toThrow(/uncertain outcome/u);
	});

	it("does not block a different family in the same project", async () => {
		const ci = ownerWriteGuard(`ci\u0000${project}`, project);
		await guard().run(
			async () => {
				expect(
					await ci.run(
						async () => "ci-complete",
						() => false,
					),
				).toBe("ci-complete");
			},
			() => false,
		);
		ci.assertClear();
		guard().assertClear();
	});

	it("does not coordinate different checkouts, even if they use the same store", async () => {
		const otherProject = join(home, "other-checkout");
		await mkdir(otherProject);
		const other = ownerWriteGuard(`cd\u0000${otherProject}`, otherProject);
		const store = new Map<string, string>();
		await guard().run(
			async () => {
				await other.run(
					async () => {
						store.set("synthetic-setting", "second");
					},
					() => false,
				);
				store.set("synthetic-setting", "first");
			},
			() => false,
		);
		expect(store.get("synthetic-setting")).toBe("first");
	});

	it("does not coordinate separate state directories", async () => {
		await guard().run(
			async () => {
				vi.stubEnv("XDG_STATE_HOME", join(home, "other-state"));
				await guard().run(
					async () => undefined,
					() => false,
				);
			},
			() => false,
		);
	});

	it("persists scoped revisions across processes and restarts", async () => {
		const selected = guard();
		const generation = selected.currentSelection().generation;
		const initial = selected.currentSettingsRevision();
		expect(selected.advanceSettingsRevision(generation)).toBe(initial + 1);
		const writer = start("increment-revision");
		expect(await writer.output).toBe(`${initial + 2}\n`);
		await writer.closed;
		expect(guard().currentSettingsRevision()).toBe(initial + 2);
		const restarted = start("revision");
		expect(await restarted.output).toBe(`${initial + 2}\n`);
		await restarted.closed;
	});

	it("allows only the active guard nonce to advance a revision during its write", async () => {
		const selected = guard();
		const generation = selected.currentSelection().generation;
		const initial = selected.currentSettingsRevision();
		let expired = "";
		await selected.run(
			async (nonce) => {
				expired = nonce;
				expect(selected.advanceSettingsRevision(generation, nonce)).toBe(
					initial + 1,
				);
				expect(() => selected.advanceSettingsRevision(generation)).toThrow(
					/uncertain outcome/u,
				);
				expect(() =>
					selected.advanceSettingsRevision(generation, "synthetic-other-nonce"),
				).toThrow(/uncertain outcome/u);
			},
			() => false,
		);
		expect(() => selected.advanceSettingsRevision(generation, expired)).toThrow(
			/uncertain outcome/u,
		);
		expect(selected.currentSettingsRevision()).toBe(initial + 1);
	});

	it("refuses revision exhaustion without wrapping or changing selection", async () => {
		const selected = guard();
		const generation = selected.currentSelection().generation;
		const directory = join(state, "hobo", "owner-write-guards");
		const name = (await readdir(directory)).find((file) =>
			file.endsWith(".sqlite"),
		);
		if (!name) throw new Error("Missing synthetic guard database.");
		const database = new DatabaseSync(join(directory, name));
		try {
			database
				.prepare("UPDATE owner_settings_revision SET revision = ? WHERE id = 1")
				.run(Number.MAX_SAFE_INTEGER);
		} finally {
			database.close();
		}
		expect(selected.currentSettingsRevision()).toBe(Number.MAX_SAFE_INTEGER);
		expect(() => selected.advanceSettingsRevision(generation)).toThrow(
			/guard is unavailable/u,
		);
		expect(() => selected.changeGeneration(generation)).toThrow(
			/guard is unavailable/u,
		);
		expect(selected.currentSelection().generation).toBe(generation);
		const restarted = start("revision");
		expect(await restarted.output).toBe(`${Number.MAX_SAFE_INTEGER}\n`);
		await restarted.closed;
	});

	it("refuses operation revision exhaustion before dispatch", async () => {
		const selected = guard();
		const generation = selected.currentSelection().generation;
		selected.currentPreparationSnapshot(generation);
		const directory = join(state, "hobo", "owner-write-guards");
		const name = (await readdir(directory)).find((file) =>
			file.endsWith(".sqlite"),
		);
		if (!name) throw new Error("Missing synthetic guard database.");
		const database = new DatabaseSync(join(directory, name));
		try {
			database
				.prepare(
					"UPDATE owner_operation_revision SET revision = ? WHERE id = 1",
				)
				.run(Number.MAX_SAFE_INTEGER);
		} finally {
			database.close();
		}
		let dispatched = false;
		await expect(
			selected.run(
				async () => {
					dispatched = true;
				},
				() => false,
				generation,
			),
		).rejects.toThrow(/guard is unavailable/u);
		expect(dispatched).toBe(false);
		expect(
			selected.currentPreparationSnapshot(generation).operationRevision,
		).toBe(Number.MAX_SAFE_INTEGER);
		expect(() => selected.assertClear()).not.toThrow();
	});

	it("refuses before dispatch when the project path is missing or noncanonical", async () => {
		const missing = join(home, "missing-project");
		const alias = join(home, "project-alias");
		let dispatched = false;
		const write = async () => {
			dispatched = true;
		};
		await expect(
			ownerWriteGuard(`cd\u0000${missing}`, missing).run(write, () => false),
		).rejects.toThrow(/guard is unavailable/u);
		await symlink(project, alias);
		await expect(
			ownerWriteGuard(`cd\u0000${alias}`, alias).run(write, () => false),
		).rejects.toThrow(/guard is unavailable/u);
		await expect(
			ownerWriteGuard(`cd\u0000${missing}`, project).run(write, () => false),
		).rejects.toThrow(/guard is unavailable/u);
		expect(dispatched).toBe(false);
	});

	it("uses the private default state directory with a separate HoBo home", async () => {
		const hoboHome = join(home, "hobo-home");
		await mkdir(hoboHome);
		const child = start("try", {
			HOME: home,
			HOBO_HOME: hoboHome,
			XDG_STATE_HOME: "",
		});
		expect(await child.output).toBe("entered\n");
		await child.closed;
		expect(
			await readdir(
				join(home, ".local", "state", "hobo", "owner-write-guards"),
			),
		).toHaveLength(1);
		expect(await readdir(hoboHome)).toEqual([]);
	});

	it("blocks another process while writing and after the writer crashes", async () => {
		const writer = start("hold");
		try {
			expect(await writer.output).toBe("entered\n");
			expect(() => guard().assertClear()).toThrow(/uncertain outcome/u);
			const concurrent = start("try");
			expect(await concurrent.output).toBe("refused\n");
			await concurrent.closed;
			writer.child.kill("SIGKILL");
			await writer.closed;
			expect(await readFile(join(project, "synthetic-effect"), "utf8")).toBe(
				"applied",
			);
			expect(() => guard().assertClear()).toThrow(/uncertain outcome/u);
			const restarted = start("try");
			expect(await restarted.output).toBe("refused\n");
			await restarted.closed;
		} finally {
			writer.child.kill("SIGKILL");
			await writer.closed;
		}
	});

	it("does not dispatch an old prepared operation after another process completes", async () => {
		const older = start("prepared");
		try {
			expect(await older.output).toBe("prepared\n");
			const selected = guard();
			const generation = selected.currentSelection().generation;
			await selected.run(
				async () => "completed",
				() => false,
				generation,
			);
			const outcome = once(older.child.stdout, "data").then(([chunk]) =>
				String(chunk),
			);
			await writeFile(join(project, "synthetic-release"), "continue");
			expect(await outcome).toBe("refused\n");
			await older.closed;
			expect(await readdir(project)).not.toContain("synthetic-stale-effect");
			expect(() => guard().assertClear()).not.toThrow();
		} finally {
			older.child.kill("SIGKILL");
			await older.closed;
		}
	});

	it("allows a new write after a process crashes during read-only preparation", async () => {
		const older = start("prepared-hold");
		try {
			expect(await older.output).toBe("prepared\n");
			older.child.kill("SIGKILL");
			await older.closed;
			const selected = guard();
			const generation = selected.currentSelection().generation;
			const revision = selected.currentPreparationSnapshot(generation);
			await expect(
				selected.run(
					async () => "completed",
					() => false,
					generation,
					() => true,
					undefined,
					revision,
				),
			).resolves.toBe("completed");
		} finally {
			older.child.kill("SIGKILL");
			await older.closed;
		}
	});

	it("refuses a stale process that starts its write after selection changes", async () => {
		const writer = start("stale");
		try {
			expect(await writer.output).toBe("selected\n");
			const before = guard().currentSelection().generation;
			const after = guard().changeGeneration(before);
			expect(after).not.toBe(before);
			const outcome = once(writer.child.stdout, "data").then(([chunk]) =>
				String(chunk),
			);
			await writeFile(join(project, "synthetic-release"), "continue");
			expect(await outcome).toBe("refused\n");
			await writer.closed;
			expect(await readdir(project)).not.toContain("synthetic-stale-effect");
			expect(guard().currentSelection().generation).toBe(after);
		} finally {
			writer.child.kill("SIGKILL");
			await writer.closed;
		}
	});

	it("does not change selection while another process is writing", async () => {
		const writer = start("finish");
		try {
			expect(await writer.output).toBe("entered\n");
			const before = guard().currentSelection().generation;
			expect(() => guard().changeGeneration(before)).toThrow(
				/uncertain outcome/u,
			);
			const revision = guard().currentSettingsRevision();
			expect(() => guard().advanceSettingsRevision(before)).toThrow(
				/uncertain outcome/u,
			);
			await writeFile(join(project, "synthetic-release"), "continue");
			await writer.closed;
			expect(guard().currentSelection().generation).toBe(before);
			expect(guard().currentSettingsRevision()).toBe(revision);
		} finally {
			writer.child.kill("SIGKILL");
			await writer.closed;
		}
	});

	it.each([
		false,
		true,
	])("rechecks local uncertainty after a competing cleanup lock (uncertain: %s)", async (closeSession) => {
		let uncertain = false;
		let locker: ReturnType<typeof start> | undefined;
		try {
			const result = guard().run(
				async () => {
					locker = start("lock");
					expect(await locker.output).toBe("locked\n");
					setTimeout(() => {
						uncertain = closeSession;
						writeFileSync(join(project, "synthetic-release"), "continue");
					}, 100);
					return "completed";
				},
				() => uncertain,
			);
			if (closeSession)
				await expect(result).rejects.toThrow(/uncertain outcome/u);
			else await expect(result).resolves.toBe("completed");
			await locker?.closed;
			if (closeSession)
				expect(() => guard().assertClear()).toThrow(/uncertain outcome/u);
			else expect(() => guard().assertClear()).not.toThrow();
		} finally {
			locker?.child.kill("SIGKILL");
			await locker?.closed;
		}
	});

	it("retains the nonce if the cleanup lock stays busy", async () => {
		let locker: ReturnType<typeof start> | undefined;
		try {
			await expect(
				guard().run(
					async () => {
						locker = start("lock");
						expect(await locker.output).toBe("locked\n");
					},
					() => false,
				),
			).rejects.toBeInstanceOf(OwnerStoreOperationUncertainError);
			await writeFile(join(project, "synthetic-release"), "continue");
			await locker?.closed;
			expect(() => guard().assertClear()).toThrow(/uncertain outcome/u);
		} finally {
			locker?.child.kill("SIGKILL");
			await locker?.closed;
		}
	});

	it("retains a prewritten cleanup marker after an ambiguous commit and sidecar sync failure", async () => {
		const directory = join(state, "hobo", "owner-write-guards");
		let cleanupSynced = false;
		let commitFailed = false;
		const selected = ownerWriteGuard(`cd\u0000${project}`, project, {
			noFollow: constants.O_NOFOLLOW,
			sync: (fd) => {
				if (fstatSync(fd).isFile()) {
					if (commitFailed) throw new Error("synthetic sync failure");
					if (
						existsSync(directory) &&
						readdirSync(directory).some((name) => name.endsWith(".cleanup"))
					)
						cleanupSynced = true;
				}
				fsyncSync(fd);
			},
			commitCleanup: (database) => {
				expect(cleanupSynced).toBe(true);
				database.exec("COMMIT");
				commitFailed = true;
				throw new Error("synthetic ambiguous commit");
			},
		});
		await expect(
			selected.run(
				async () => "provider-completed",
				() => false,
			),
		).rejects.toBeInstanceOf(OwnerStoreOperationUncertainError);
		const files = await readdir(directory);
		const databaseName = files.find((name) => name.endsWith(".sqlite"));
		const uncertainName = files.find((name) => name.endsWith(".uncertain"));
		expect(files.some((name) => name.endsWith(".cleanup"))).toBe(true);
		if (!databaseName || !uncertainName)
			throw new Error("Missing synthetic state.");
		await rm(join(directory, uncertainName));
		const database = new DatabaseSync(join(directory, databaseName));
		try {
			expect(
				database.prepare("SELECT nonce FROM owner_write_guard").get(),
			).toBeUndefined();
		} finally {
			database.close();
		}
		const restarted = start("try");
		expect(await restarted.output).toBe("refused\n");
		await restarted.closed;
	});

	it("keeps an independently marked uncertainty after another process finishes", async () => {
		const writer = start("finish");
		try {
			expect(await writer.output).toBe("entered\n");
			guard().markUncertain();
			await writeFile(join(project, "synthetic-release"), "finish");
			await writer.closed;
			expect(() => guard().assertClear()).toThrow(/uncertain outcome/u);
			const restarted = start("try");
			expect(await restarted.output).toBe("refused\n");
			await restarted.closed;
		} finally {
			writer.child.kill("SIGKILL");
			await writer.closed;
		}
	});

	it("stores only opaque state in an owner-only location", async () => {
		await guard()
			.run(
				async () => {
					throw new Error("synthetic-owner-credential");
				},
				() => false,
			)
			.catch(() => undefined);
		const directory = join(state, "hobo", "owner-write-guards");
		const files = await readdir(directory);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^[0-9a-f]{64}\.sqlite$/u);
		expect((await lstat(directory)).mode & 0o077).toBe(0);
		const database = join(directory, files[0] ?? "");
		expect((await lstat(database)).mode & 0o077).toBe(0);
		const bytes = await readFile(database);
		for (const value of [
			project,
			"synthetic-private-project",
			"synthetic-owner-credential",
		])
			expect(bytes.includes(value)).toBe(false);
	});

	it("refuses to keep guard state inside the project repository", async () => {
		await mkdir(join(project, ".git"));
		await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
		vi.stubEnv("XDG_STATE_HOME", join(project, "state"));
		await expect(
			guard().run(
				async () => undefined,
				() => false,
			),
		).rejects.toThrow(/guard is unavailable/u);
	});

	it.each([
		"directory",
		"file",
	])("refuses guard state in a checkout with a symlinked Git %s", async (kind) => {
		const metadata = join(home, "metadata");
		await mkdir(metadata);
		await writeFile(join(metadata, "HEAD"), "ref: refs/heads/main\n");
		const target = kind === "directory" ? metadata : join(home, "git-link");
		if (kind === "file") await writeFile(target, `gitdir: ${metadata}\n`);
		await symlink(target, join(project, ".git"));
		vi.stubEnv("XDG_STATE_HOME", join(project, "state"));
		await expect(
			guard().run(
				async () => undefined,
				() => false,
			),
		).rejects.toThrow(/guard is unavailable/u);
		expect(await readdir(project)).toEqual([".git"]);
	});

	it("refuses guard state inside a bare repository", async () => {
		const bare = join(home, "bare-repository");
		await mkdir(join(bare, "objects"), { recursive: true });
		await mkdir(join(bare, "refs"));
		await writeFile(join(bare, "HEAD"), "ref: refs/heads/main\n");
		vi.stubEnv("XDG_STATE_HOME", join(bare, "state"));
		await expect(
			guard().run(
				async () => undefined,
				() => false,
			),
		).rejects.toThrow(/guard is unavailable/u);
		expect(await readdir(bare)).toEqual(["HEAD", "objects", "refs"]);
	});

	it("rejects a state directory redirected into a repository", async () => {
		await mkdir(join(project, ".git"));
		await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
		await mkdir(join(project, "state"));
		await symlink(join(project, "state"), join(home, "redirect"));
		vi.stubEnv("XDG_STATE_HOME", join(home, "redirect"));
		await expect(
			guard().run(
				async () => undefined,
				() => false,
			),
		).rejects.toThrow(/guard is unavailable/u);
		expect(await readdir(join(project, "state"))).toEqual([]);
	});

	it("refuses a guard directory accessible to other users", async () => {
		const directory = join(state, "hobo", "owner-write-guards");
		await mkdir(directory, { recursive: true });
		await chmod(directory, 0o755);
		await expect(
			guard().run(
				async () => undefined,
				() => false,
			),
		).rejects.toThrow(/guard is unavailable/u);
	});

	it("refuses a replaceable parent of the guard directory", async () => {
		const parent = join(state, "hobo");
		await mkdir(join(parent, "owner-write-guards"), { recursive: true });
		await chmod(parent, 0o777);
		await expect(
			guard().run(
				async () => undefined,
				() => false,
			),
		).rejects.toThrow(/guard is unavailable/u);
	});
});
