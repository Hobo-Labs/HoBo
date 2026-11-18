import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createReleaseJournal,
	findPendingLocalRelease,
} from "../src/release-journal.js";

const roots: string[] = [];
const initial = {
	deploymentId: "dpl_new",
	previousDeploymentId: "dpl_old",
	commit: "0123456789abcdef0123456789abcdef01234567",
	state: "reserved" as const,
};

async function home() {
	const root = await mkdtemp(join(tmpdir(), "hobo-release-journal-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("release checkpoint journal", () => {
	it("durably shares the first reservation and allows only matching state transitions", async () => {
		const root = await home();
		const first = createReleaseJournal(root, "prj_test", "dpl_new");
		const second = createReleaseJournal(root, "prj_test", "dpl_new");
		expect(await first.reserve(initial)).toEqual({
			checkpoint: initial,
			created: true,
		});
		expect(
			await second.reserve({ ...initial, previousDeploymentId: "dpl_other" }),
		).toEqual({ checkpoint: initial, created: false });
		await expect(
			second.save({
				...initial,
				previousDeploymentId: "dpl_other",
				state: "verified",
			}),
		).rejects.toThrow();
		await second.save({ ...initial, state: "verified" });
		expect((await first.load())?.state).toBe("verified");
		await expect(
			first.save({ ...initial, state: "rolled-back" }),
		).rejects.toThrow();
	});

	it("refuses a symlink or corrupt checkpoint without modifying its target", async () => {
		const root = await home();
		const journal = createReleaseJournal(root, "prj_test", "dpl_new");
		await journal.reserve(initial);
		const file = join(root, "cd", "releases", "prj_test-dpl_new.json");
		await writeFile(file, "not JSON");
		await expect(journal.load()).rejects.toThrow();
		await rm(file);
		const outside = join(root, "outside");
		await writeFile(outside, "untouched");
		await symlink(outside, file);
		await expect(journal.load()).rejects.toThrow();
		expect(await readFile(outside, "utf8")).toBe("untouched");
	});

	it("allows at most one simultaneous caller to create a reservation", async () => {
		const root = await home();
		const journals = [
			createReleaseJournal(root, "prj_test", "dpl_new"),
			createReleaseJournal(root, "prj_test", "dpl_new"),
		];
		const outcomes = await Promise.allSettled(
			journals.map((journal) => journal.reserve(initial)),
		);
		expect(
			outcomes.filter(
				(outcome) => outcome.status === "fulfilled" && outcome.value.created,
			),
		).toHaveLength(1);
		expect(await journals[0]?.load()).toEqual(initial);
	});

	it("finds a prior unfinished release and refuses ambiguous or corrupt history", async () => {
		const root = await home();
		expect(await findPendingLocalRelease(root, "prj_test")).toBeUndefined();
		const first = createReleaseJournal(root, "prj_test", "dpl_new");
		await first.reserve(initial);
		expect(await findPendingLocalRelease(root, "prj_test")).toEqual(initial);
		const second = createReleaseJournal(root, "prj_test", "dpl_other");
		await second.reserve({ ...initial, deploymentId: "dpl_other" });
		await expect(findPendingLocalRelease(root, "prj_test")).rejects.toThrow(
			/multiple/iu,
		);
		await first.save({ ...initial, state: "verified" });
		expect(
			(await findPendingLocalRelease(root, "prj_test"))?.deploymentId,
		).toBe("dpl_other");
		await writeFile(
			join(root, "cd", "releases", "prj_test-dpl_other.json"),
			"invalid",
		);
		await expect(findPendingLocalRelease(root, "prj_test")).rejects.toThrow();
	});
});
