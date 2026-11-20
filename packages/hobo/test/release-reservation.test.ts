import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createNodeSqliteDriver, SqliteJournal } from "@hobo/storage-sqlite";
import { describe, expect, it } from "vitest";
import {
	promoteVerifiedRelease,
	type ReleaseCheckpoint,
	type ReleaseJournal,
	type ReleaseProvider,
} from "../src/release-controller.js";
import {
	createReleaseReservationAuthority,
	createReservedReleaseProvider,
} from "../src/release-reservation.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NEXT = "1123456789abcdef0123456789abcdef01234567";
const TARGET = { provider: "vercel", project: "test" };

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-release-reservation-"));
	const path = join(dir, "journal.sqlite");
	const journals: SqliteJournal[] = [];
	return {
		path,
		dir,
		open() {
			const journal = new SqliteJournal(createNodeSqliteDriver({ path }));
			journals.push(journal);
			return journal;
		},
		close() {
			for (const journal of journals) journal.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("target release reservations", () => {
	it("chooses one winner across independent processes", async () => {
		const f = fixture();
		try {
			f.open();
			const script = join(f.dir, "reserve.mts");
			writeFileSync(
				script,
				`import { createNodeSqliteDriver, SqliteJournal } from ${JSON.stringify(import.meta.resolve("@hobo/storage-sqlite"))};
import { createReleaseReservationAuthority } from ${JSON.stringify(new URL("../src/release-reservation.ts", import.meta.url).href)};
const journal = new SqliteJournal(createNodeSqliteDriver({ path: process.argv[2] }));
const result = await createReleaseReservationAuthority(journal).acquire(${JSON.stringify(TARGET)}, ${JSON.stringify(COMMIT)});
process.stdout.write(result.acquired ? "won" : "busy");
journal.close();`,
			);
			const exec = promisify(execFile);
			const args = ["--import", "tsx", script, f.path];
			const results = await Promise.all([
				exec(process.execPath, args),
				exec(process.execPath, args),
			]);
			expect(results.map((result) => result.stdout).sort()).toEqual([
				"busy",
				"won",
			]);
		} finally {
			f.close();
		}
	});

	it("keeps a dispatched effect reserved when its process is killed", async () => {
		const f = fixture();
		try {
			f.open();
			const script = join(f.dir, "crash.mts");
			writeFileSync(
				script,
				`import { createNodeSqliteDriver, SqliteJournal } from ${JSON.stringify(import.meta.resolve("@hobo/storage-sqlite"))};
import { createReleaseReservationAuthority } from ${JSON.stringify(new URL("../src/release-reservation.ts", import.meta.url).href)};
const journal = new SqliteJournal(createNodeSqliteDriver({ path: process.argv[2] }));
const result = await createReleaseReservationAuthority(journal).acquire(${JSON.stringify(TARGET)}, ${JSON.stringify(COMMIT)});
if (!result.acquired) process.exit(2);
await result.reservation.run(async () => {
  process.stdout.write("started");
  await new Promise(() => setInterval(() => {}, 1000));
  return { state: "pending" };
});`,
			);
			const child = spawn(
				process.execPath,
				["--import", "tsx", script, f.path],
				{
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			try {
				child.stderr.resume();
				const exited = once(child, "exit");
				const [message] = await Promise.race([
					once(child.stdout, "data"),
					exited.then(() => {
						throw new Error("The release process exited before dispatch.");
					}),
				]);
				expect(String(message)).toBe("started");
				child.kill("SIGKILL");
				await exited;
				const retry = createReleaseReservationAuthority(f.open());
				expect(await retry.acquire(TARGET, NEXT)).toEqual({
					acquired: false,
					commit: COMMIT,
				});
			} finally {
				child.kill("SIGKILL");
			}
		} finally {
			f.close();
		}
	});

	it("serializes independent callers and permits another release only after completion", async () => {
		const f = fixture();
		try {
			const a = createReleaseReservationAuthority(f.open());
			const b = createReleaseReservationAuthority(f.open());
			const [first, second] = await Promise.all([
				a.acquire(TARGET, COMMIT),
				b.acquire(TARGET, NEXT),
			]);
			expect([first.acquired, second.acquired].sort()).toEqual([false, true]);
			const winner = first.acquired ? first : second;
			if (!winner.acquired) throw new Error("No reservation winner.");
			await winner.reservation.run(async () => ({
				state: "settled",
				value: 1,
			}));
			await winner.reservation.finish("verified");
			expect((await b.acquire(TARGET, NEXT)).acquired).toBe(true);
		} finally {
			f.close();
		}
	});

	it("serializes callers for the same source and keeps separate targets independent", async () => {
		const f = fixture();
		try {
			const a = createReleaseReservationAuthority(f.open());
			const b = createReleaseReservationAuthority(f.open());
			const results = await Promise.all([
				a.acquire(TARGET, COMMIT),
				b.acquire(TARGET, COMMIT),
				a.acquire({ ...TARGET, project: "other" }, COMMIT),
			]);
			expect(results.filter((result) => result.acquired)).toHaveLength(2);
		} finally {
			f.close();
		}
	});

	it("does not treat a lost reservation acknowledgement as permission to dispatch", async () => {
		const f = fixture();
		try {
			const journal = f.open();
			const uncertain = createReleaseReservationAuthority({
				read: journal.read.bind(journal),
				async append(...args) {
					await journal.append(...args);
					throw new Error("reply lost");
				},
			});
			await expect(uncertain.acquire(TARGET, COMMIT)).rejects.toThrow(
				/confirm/,
			);
			const retry = createReleaseReservationAuthority(f.open());
			expect(await retry.acquire(TARGET, NEXT)).toEqual({
				acquired: false,
				commit: COMMIT,
			});
		} finally {
			f.close();
		}
	});

	it("retains a dispatched effect after an interrupted caller and a late result", async () => {
		const f = fixture();
		try {
			const first = await createReleaseReservationAuthority(f.open()).acquire(
				TARGET,
				COMMIT,
			);
			if (!first.acquired) throw new Error("Reservation unavailable.");
			let applyLate: (() => void) | undefined;
			let serving = "old";
			expect(
				await first.reservation.run(async () => {
					applyLate = () => {
						serving = "new";
					};
					return { state: "pending" };
				}),
			).toEqual({ state: "pending" });
			const retry = createReleaseReservationAuthority(f.open());
			expect((await retry.acquire(TARGET, NEXT)).acquired).toBe(false);
			applyLate?.();
			expect(serving).toBe("new");
			expect((await retry.acquire(TARGET, NEXT)).acquired).toBe(false);
			await expect(first.reservation.finish("rolled-back")).rejects.toThrow();
		} finally {
			f.close();
		}
	});

	it("retains the fence if a settled-effect acknowledgement is lost", async () => {
		const f = fixture();
		try {
			const journal = f.open();
			const authority = createReleaseReservationAuthority({
				read: journal.read.bind(journal),
				async append(...args) {
					const result = await journal.append(...args);
					if (args[1][0]?.type === "release.EffectSettled")
						throw new Error("reply lost");
					return result;
				},
			});
			const first = await authority.acquire(TARGET, COMMIT);
			if (!first.acquired) throw new Error("Reservation unavailable.");
			await expect(
				first.reservation.run(async () => ({ state: "settled", value: true })),
			).rejects.toThrow(/confirm/);
			await expect(first.reservation.finish("verified")).rejects.toThrow();
			expect(
				(
					await createReleaseReservationAuthority(f.open()).acquire(
						TARGET,
						NEXT,
					)
				).acquired,
			).toBe(false);
		} finally {
			f.close();
		}
	});

	it("fences an uncertain provider promotion through the release controller", async () => {
		const f = fixture();
		try {
			const first = await createReleaseReservationAuthority(f.open()).acquire(
				TARGET,
				COMMIT,
			);
			if (!first.acquired) throw new Error("Reservation unavailable.");
			let current = "old";
			let late: (() => void) | undefined;
			let checkpoint: ReleaseCheckpoint | undefined;
			const journal: ReleaseJournal = {
				async load() {
					return checkpoint;
				},
				async reserve(value) {
					checkpoint = value;
					return { checkpoint, created: true };
				},
				async save(value) {
					checkpoint = value;
				},
			};
			const provider: ReleaseProvider = {
				async inspect(id) {
					return {
						deploymentId: id,
						commit: COMMIT,
						ready: true,
						staged: true,
					};
				},
				async canRollback() {
					return true;
				},
				async current() {
					return current;
				},
				async promote() {
					late = () => {
						current = "new";
					};
					return "pending";
				},
				async rollback() {
					throw new Error("Unexpected rollback.");
				},
				async probe() {
					return true;
				},
			};
			const result = await promoteVerifiedRelease({
				provider: createReservedReleaseProvider(provider, first.reservation),
				journal,
				deploymentId: "new",
				commit: COMMIT,
				deadline: 100,
				now: () => 0,
			});
			expect(result).toEqual({
				ok: false,
				code: "promotion-uncertain",
				rolledBack: false,
			});
			late?.();
			expect(current).toBe("new");
			expect(checkpoint?.state).toBe("reserved");
			expect(
				(
					await createReleaseReservationAuthority(f.open()).acquire(
						TARGET,
						NEXT,
					)
				).acquired,
			).toBe(false);
		} finally {
			f.close();
		}
	});
});
