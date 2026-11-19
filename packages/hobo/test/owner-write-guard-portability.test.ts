import { constants, fstatSync, fsyncSync, statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerWriteGuard } from "../src/owner-write-guard.js";
import { supportsOwnerGuard } from "./support/owner-guard-support.js";

let home: string;
let project: string;

beforeEach(async () => {
	home = await realpath(
		await mkdtemp(join(tmpdir(), "hobo-owner-portability-")),
	);
	project = join(home, "project");
	await mkdir(project);
	vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
});

describe("owner guard filesystem prerequisites", () => {
	it("refuses before dispatch when no-follow opens are unavailable", async () => {
		const guard = ownerWriteGuard(`cd\u0000${project}`, project, {
			noFollow: 0,
			sync: fsyncSync,
		});
		let dispatched = false;
		await expect(
			guard.run(
				async () => {
					dispatched = true;
				},
				() => false,
			),
		).rejects.toThrow(/guard is unavailable/u);
		expect(() => guard.markUncertain()).toThrow(/guard is unavailable/u);
		expect(dispatched).toBe(false);
	});

	it.runIf(supportsOwnerGuard()).each(["file", "directory"])(
		"keeps refusing when the guard %s cannot be synced",
		async (kind) => {
			const guard = ownerWriteGuard(`cd\u0000${project}`, project, {
				noFollow: constants.O_NOFOLLOW,
				sync: (fd) => {
					if (fstatSync(fd).isDirectory() === (kind === "directory"))
						throw new Error("sync unavailable");
					fsyncSync(fd);
				},
			});
			let dispatched = false;
			for (let attempt = 0; attempt < 2; attempt++) {
				await expect(
					guard.run(
						async () => {
							dispatched = true;
						},
						() => false,
					),
				).rejects.toThrow(/guard is unavailable/u);
			}
			expect(dispatched).toBe(false);
		},
	);

	it.runIf(supportsOwnerGuard())(
		"syncs newly created state directories and their parents before dispatch",
		async () => {
			const synced = new Set<string>();
			const guard = ownerWriteGuard(`cd\u0000${project}`, project, {
				noFollow: constants.O_NOFOLLOW,
				sync: (fd) => {
					const info = fstatSync(fd);
					if (info.isDirectory()) synced.add(`${info.dev}:${info.ino}`);
					fsyncSync(fd);
				},
			});
			await guard.run(
				async () => {
					for (const directory of [
						home,
						join(home, "state"),
						join(home, "state", "hobo"),
						join(home, "state", "hobo", "owner-write-guards"),
					]) {
						const info = statSync(directory);
						expect(synced.has(`${info.dev}:${info.ino}`)).toBe(true);
					}
				},
				() => false,
			);
		},
	);
});
