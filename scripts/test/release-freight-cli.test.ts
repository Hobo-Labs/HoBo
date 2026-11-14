import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	cliBundlePlan,
	packCliBundle,
	restoreCliBundle,
} from "../ci/release-freight-cli.mts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

const dryRun = (
	tasks: readonly {
		package: string;
		directory: string;
		outputs?: readonly string[];
	}[],
) =>
	JSON.stringify({
		tasks: tasks.map((task) => ({
			taskId: `${task.package}#build`,
			task: "build",
			package: task.package,
			directory: task.directory,
			outputs: task.outputs ?? ["dist/**"],
		})),
	});

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "hobo-cli-bundle-"));
	for (const [dir, file] of [
		["packages/hobo", "index.js"],
		["packages/cd", "provenance/index.js"],
	] as const) {
		mkdirSync(join(root, dir, "dist", file, ".."), { recursive: true });
		writeFileSync(join(root, dir, "dist", file), `// ${dir}\n`);
		writeFileSync(join(root, dir, "package.json"), "{}");
	}
	return root;
}

const plan = cliBundlePlan(
	dryRun([
		{ package: "@hobo/hobo", directory: "packages/hobo" },
		{ package: "@hobo/cd", directory: "packages/cd" },
	]),
);

describe("cliBundlePlan", () => {
	it("reads the @hobo/hobo build closure from turbo's dry run, sorted", () => {
		expect(plan.map((entry) => entry.directory)).toEqual([
			"packages/cd",
			"packages/hobo",
		]);
	});

	it("refuses a closure without @hobo/hobo", () => {
		expect(() =>
			cliBundlePlan(
				dryRun([{ package: "@hobo/cd", directory: "packages/cd" }]),
			),
		).toThrow(/@hobo\/hobo/u);
	});

	it("refuses a task whose outputs are not dist/** (it would ship half a build)", () => {
		expect(() =>
			cliBundlePlan(
				dryRun([
					{ package: "@hobo/hobo", directory: "packages/hobo" },
					{
						package: "@hobo/x",
						directory: "packages/x",
						outputs: ["dist/**", "generated/**"],
					},
				]),
			),
		).toThrow(/@hobo\/x/u);
	});

	it("refuses a directory outside packages/", () => {
		for (const directory of ["../etc", "/abs/packages/x", "packages/../x"])
			expect(() =>
				cliBundlePlan(
					dryRun([
						{ package: "@hobo/hobo", directory: "packages/hobo" },
						{ package: "@hobo/x", directory },
					]),
				),
			).toThrow(/packages\//u);
	});

	it("refuses an archive that holds a link", () => {
		const staged = workspace();
		writeFileSync(
			join(staged, "hobo-release-cli.json"),
			JSON.stringify({
				schema: "hobo.release-cli-bundle/v1",
				revision: REVISION,
				packages: [
					{ package: "@hobo/hobo", directory: "packages/hobo" },
					{ package: "@hobo/cd", directory: "packages/cd" },
				],
			}),
		);
		spawnSync("ln", ["-s", "/etc", join(staged, "packages/hobo/dist/etc")]);
		const linked = join(staged, "..", `${REVISION.slice(0, 8)}-link.tgz`);
		spawnSync("tar", [
			"-czf",
			linked,
			"-C",
			staged,
			"hobo-release-cli.json",
			"packages/hobo/dist",
			"packages/cd/dist",
		]);
		const digest = `sha256:${spawnSync("sha256sum", [linked], {
			encoding: "utf8",
		}).stdout.slice(0, 64)}`;
		expect(() =>
			restoreCliBundle({
				root: workspace(),
				bundle: linked,
				digest,
				revision: REVISION,
			}),
		).toThrow(/link/u);
	});
});

describe("packCliBundle + restoreCliBundle", () => {
	it("round-trips the built closure bound to its revision and digest", () => {
		const source = workspace();
		const out = join(mkdtempSync(join(tmpdir(), "hobo-cli-out-")), "cli.tgz");
		const packed = packCliBundle({
			root: source,
			plan,
			revision: REVISION,
			out,
		});
		expect(packed.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		const target = workspace();
		spawnSync("rm", ["-rf", join(target, "packages/hobo/dist")]);
		spawnSync("rm", ["-rf", join(target, "packages/cd/dist")]);
		restoreCliBundle({
			root: target,
			bundle: out,
			digest: packed.digest,
			revision: REVISION,
		});
		expect(
			readFileSync(
				join(target, "packages/cd/dist/provenance/index.js"),
				"utf8",
			),
		).toBe("// packages/cd\n");
		expect(existsSync(join(target, "packages/hobo/dist/index.js"))).toBe(true);
	});

	it("refuses to pack a closure that was not built", () => {
		const source = workspace();
		spawnSync("rm", ["-rf", join(source, "packages/cd/dist")]);
		expect(() =>
			packCliBundle({
				root: source,
				plan,
				revision: REVISION,
				out: join(source, "cli.tgz"),
			}),
		).toThrow(/packages\/cd\/dist/u);
	});

	it("refuses a bundle whose digest is not the build job's", () => {
		const source = workspace();
		const out = join(source, "cli.tgz");
		packCliBundle({ root: source, plan, revision: REVISION, out });
		for (const digest of ["", "sha256:abc", `sha256:${"0".repeat(64)}`])
			expect(() =>
				restoreCliBundle({
					root: workspace(),
					bundle: out,
					digest,
					revision: REVISION,
				}),
			).toThrow(/digest/u);
	});

	it("refuses a bundle built from another revision than this checkout", () => {
		const source = workspace();
		const out = join(source, "cli.tgz");
		const { digest } = packCliBundle({
			root: source,
			plan,
			revision: REVISION,
			out,
		});
		expect(() =>
			restoreCliBundle({
				root: workspace(),
				bundle: out,
				digest,
				revision: OTHER,
			}),
		).toThrow(/revision/u);
	});

	it("refuses an archive that writes anywhere but a planned dist/", () => {
		const source = workspace();
		const out = join(source, "cli.tgz");
		const { digest } = packCliBundle({
			root: source,
			plan,
			revision: REVISION,
			out,
		});
		// A second archive with the same manifest plus one file outside dist/.
		const staged = mkdtempSync(join(tmpdir(), "hobo-cli-evil-"));
		spawnSync("tar", ["-xzf", out, "-C", staged]);
		mkdirSync(join(staged, "packages/hobo/src"), { recursive: true });
		writeFileSync(join(staged, "packages/hobo/src/evil.js"), "x");
		const evil = join(staged, "..", `${digest.slice(7, 15)}-evil.tgz`);
		spawnSync("tar", [
			"-czf",
			evil,
			"-C",
			staged,
			"hobo-release-cli.json",
			"packages",
		]);
		const evilDigest = `sha256:${spawnSync("sha256sum", [evil], {
			encoding: "utf8",
		}).stdout.slice(0, 64)}`;
		expect(() =>
			restoreCliBundle({
				root: workspace(),
				bundle: evil,
				digest: evilDigest,
				revision: REVISION,
			}),
		).toThrow(/outside/u);
	});

	it("refuses an archive that holds a link", () => {
		const staged = workspace();
		writeFileSync(
			join(staged, "hobo-release-cli.json"),
			JSON.stringify({
				schema: "hobo.release-cli-bundle/v1",
				revision: REVISION,
				packages: [
					{ package: "@hobo/hobo", directory: "packages/hobo" },
					{ package: "@hobo/cd", directory: "packages/cd" },
				],
			}),
		);
		spawnSync("ln", ["-s", "/etc", join(staged, "packages/hobo/dist/etc")]);
		const linked = join(staged, "..", `${REVISION.slice(0, 8)}-link.tgz`);
		spawnSync("tar", [
			"-czf",
			linked,
			"-C",
			staged,
			"hobo-release-cli.json",
			"packages/hobo/dist",
			"packages/cd/dist",
		]);
		const digest = `sha256:${spawnSync("sha256sum", [linked], {
			encoding: "utf8",
		}).stdout.slice(0, 64)}`;
		expect(() =>
			restoreCliBundle({
				root: workspace(),
				bundle: linked,
				digest,
				revision: REVISION,
			}),
		).toThrow(/link/u);
	});
});
