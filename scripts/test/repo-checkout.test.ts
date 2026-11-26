import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	checkoutFromBareMirror,
	classifyCheckoutTransportError,
	clearSkipWorktreeFromSparseCone,
	clearSparseCheckoutConfig,
	disableSparseCheckoutIfActive,
	mirrorObjectsPath,
	sparseCheckoutEnabled,
	submodulesEnabledFromCliArg,
	writeAlternates,
} from "../../.github/actions/hobo-checkout/repo-checkout.mts";

const repoCheckoutCli = resolve(
	import.meta.dirname,
	"../../.github/actions/hobo-checkout/repo-checkout.mts",
);

const repository = "Hobo-Labs/HoBo";
const newlinePath =
	process.platform === "win32"
		? "other/deep/line-break.txt"
		: "other/deep/line\nbreak.txt";
const trailingSpacePath =
	process.platform === "win32"
		? "other/deep/trailing-space.txt"
		: "other/deep/trailing-space.txt ";
let temp = "";
let source = "";
let mirror = "";
let sha = "";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), "hobo-repo-checkout-"));
	source = join(temp, "source");
	mirror = join(temp, "mirror.git");
	mkdirSync(source);
	git(source, ["init", "-b", "main"]);
	mkdirSync(join(source, "scripts", "ci"), { recursive: true });
	mkdirSync(join(source, "other", "deep"), { recursive: true });
	writeFileSync(join(source, "README.md"), "mirror fixture\n");
	writeFileSync(join(source, "scripts/ci/ci-trace.mts"), "export {};\n");
	writeFileSync(join(source, "other/deep/outside-cone.txt"), "outside\n");
	writeFileSync(join(source, newlinePath), "unusual\n");
	writeFileSync(join(source, trailingSpacePath), "space\n");
	git(source, [
		"add",
		"README.md",
		"scripts/ci/ci-trace.mts",
		"other/deep/outside-cone.txt",
		newlinePath,
		trailingSpacePath,
	]);
	git(source, [
		"-c",
		"user.name=HoBo Test",
		"-c",
		"user.email=hobo-test@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"fixture",
	]);
	sha = git(source, ["rev-parse", "HEAD"]);
	execFileSync("git", ["clone", "--bare", source, mirror]);
});

afterAll(() => {
	rmSync(temp, { recursive: true, force: true });
});

describe("repo checkout transport classification", () => {
	it("enables submodule sync for true and recursive CLI values", () => {
		expect(submodulesEnabledFromCliArg("true")).toBe(true);
		expect(submodulesEnabledFromCliArg("recursive")).toBe(true);
		expect(submodulesEnabledFromCliArg("false")).toBe(false);
	});
	it("detects HTTP/2 protocol errors and promisor failures", () => {
		expect(
			classifyCheckoutTransportError(
				"RPC failed; curl 92 HTTP/2 stream 3 was not closed cleanly: PROTOCOL_ERROR",
			),
		).toBe(true);
		expect(
			classifyCheckoutTransportError(
				"could not fetch 00eb66aee0 from promisor remote",
			),
		).toBe(true);
		expect(classifyCheckoutTransportError("expected 'packfile'")).toBe(true);
	});
});

describe("checkoutFromBareMirror", () => {
	it("writes alternates to the bare mirror objects directory", () => {
		const work = join(temp, "work-alternates");
		mkdirSync(work);
		const gitDir = join(work, ".git");
		mkdirSync(gitDir, { recursive: true });
		writeAlternates(gitDir, mirror);
		const alternates = readFileSync(
			join(gitDir, "objects", "info", "alternates"),
			"utf8",
		);
		expect(alternates.trim()).toBe(mirrorObjectsPath(mirror));
	});

	it("checks out a commit using only the mirror alternates", () => {
		const work = join(temp, "work-checkout");
		const result = checkoutFromBareMirror({
			workDir: work,
			sha,
			mirrorGitDir: mirror,
			originUrl: `https://github.com/${repository}`,
			markerPath: "scripts/ci/ci-trace.mts",
			retryDelaysMs: [0],
		});
		expect(result.ok).toBe(true);
		expect(existsSync(join(work, "scripts/ci/ci-trace.mts"))).toBe(true);
	});
});

describe("disableSparseCheckoutIfActive", () => {
	it("materializes a full tree after a cone limited to scripts/ci", () => {
		const work = join(temp, "work-resolve-actions-cone");
		execFileSync("git", ["clone", "--no-checkout", source, work]);
		git(work, ["sparse-checkout", "init", "--cone"]);
		git(work, ["sparse-checkout", "set", "scripts/ci"]);
		git(work, ["checkout", sha]);
		expect(existsSync(join(work, "other/deep/outside-cone.txt"))).toBe(false);
		expect(sparseCheckoutEnabled(work)).toBe(true);
		expect(disableSparseCheckoutIfActive(work)).toBe(true);
		expect(sparseCheckoutEnabled(work)).toBe(false);
		expect(existsSync(join(work, "other/deep/outside-cone.txt"))).toBe(true);
	});
});

describe("clearSparseCheckoutConfig", () => {
	it("clears skip-worktree for whitespace paths and assume-unchanged entries", () => {
		const work = join(temp, "work-sparse-special-paths");
		execFileSync("git", ["clone", source, work]);
		const whitespace =
			process.platform === "win32"
				? "other/deep/leading and trailing.txt"
				: "other/deep/ leading and trailing .txt ";
		const assumed = "other/deep/assumed.txt";
		writeFileSync(join(work, whitespace), "whitespace\n");
		writeFileSync(join(work, assumed), "assumed\n");
		git(work, ["add", "--", whitespace, assumed]);
		git(work, ["update-index", "--skip-worktree", "--", whitespace, assumed]);
		git(work, ["update-index", "--assume-unchanged", "--", assumed]);
		expect(git(work, ["ls-files", "-v", "--", whitespace])[0]).toBe("S");
		expect(git(work, ["ls-files", "-v", "--", assumed])[0]).toBe("s");
		expect(clearSkipWorktreeFromSparseCone(work)).toBe(true);
		expect(git(work, ["ls-files", "-v", "--", whitespace])[0]).toBe("H");
		expect(git(work, ["ls-files", "-v", "--", assumed])[0]).toBe("h");
	});

	it("clears stale index flags when sparse config was already removed", () => {
		const work = join(temp, "work-sparse-interrupted-prepare");
		execFileSync("git", ["clone", "--no-checkout", source, work]);
		git(work, ["sparse-checkout", "init", "--cone"]);
		git(work, ["sparse-checkout", "set", "scripts/ci"]);
		git(work, ["checkout", sha]);
		git(work, ["config", "--worktree", "--unset", "core.sparseCheckout"]);
		rmSync(join(work, ".git", "info", "sparse-checkout"));
		expect(sparseCheckoutEnabled(work)).toBe(false);
		expect(clearSparseCheckoutConfig(work)).toBe(true);
		git(work, ["checkout", "--force", sha]);
		expect(existsSync(join(work, "other/deep/outside-cone.txt"))).toBe(true);
	});

	it("recognizes a Git boolean alias for sparse checkout", () => {
		const work = join(temp, "work-sparse-boolean-alias");
		execFileSync("git", ["clone", "--no-checkout", source, work]);
		git(work, ["sparse-checkout", "init", "--cone"]);
		git(work, ["sparse-checkout", "set", "scripts/ci"]);
		git(work, ["checkout", sha]);
		git(work, ["config", "--worktree", "core.sparseCheckout", "yes"]);
		expect(sparseCheckoutEnabled(work)).toBe(true);
		expect(clearSparseCheckoutConfig(work)).toBe(true);
		git(work, ["checkout", "--force", sha]);
		expect(existsSync(join(work, "other/deep/outside-cone.txt"))).toBe(true);
	});

	it("lets the next full checkout materialize paths excluded by the old cone", () => {
		const work = join(temp, "work-next-full-checkout");
		execFileSync("git", ["clone", "--no-checkout", source, work]);
		git(work, ["sparse-checkout", "init", "--cone"]);
		git(work, ["sparse-checkout", "set", "scripts/ci"]);
		git(work, ["checkout", sha]);
		const outside = join(work, "other/deep/outside-cone.txt");
		expect(existsSync(outside)).toBe(false);
		git(work, ["update-index", "--assume-unchanged", "--", trailingSpacePath]);
		writeFileSync(join(work, "README.md"), "local modification\n");
		expect(clearSparseCheckoutConfig(work)).toBe(true);
		expect(readFileSync(join(work, "README.md"), "utf8")).toBe(
			"local modification\n",
		);
		expect(existsSync(outside)).toBe(false);
		git(work, ["checkout", "--force", sha]);
		expect(readFileSync(outside, "utf8")).toBe("outside\n");
		expect(readFileSync(join(work, newlinePath), "utf8")).toBe("unusual\n");
		expect(readFileSync(join(work, trailingSpacePath), "utf8")).toBe("space\n");
	});

	it("clears sparse config on a blob:none clone without materializing missing blobs", () => {
		const work = join(temp, "work-blob-none-sparse");
		execFileSync("git", [
			"clone",
			"--filter=blob:none",
			"--no-checkout",
			`file://${source}`,
			work,
		]);
		git(work, ["sparse-checkout", "init", "--cone"]);
		git(work, ["sparse-checkout", "set", "scripts/ci"]);
		git(work, ["checkout", sha]);
		expect(existsSync(join(work, "other/deep/outside-cone.txt"))).toBe(false);
		expect(sparseCheckoutEnabled(work)).toBe(true);
		expect(clearSparseCheckoutConfig(work)).toBe(true);
		expect(sparseCheckoutEnabled(work)).toBe(false);
		expect(existsSync(join(work, "other/deep/outside-cone.txt"))).toBe(false);
		git(work, ["checkout", "-f", sha]);
		expect(existsSync(join(work, "other/deep/outside-cone.txt"))).toBe(true);
	});
});

describe("prepare-full-worktree CLI", () => {
	it("exits 0 and clears sparse config inside an active sparse worktree", () => {
		const work = join(temp, "work-cli-sparse-ok");
		execFileSync("git", ["clone", "--no-checkout", source, work]);
		git(work, ["sparse-checkout", "init", "--cone"]);
		git(work, ["sparse-checkout", "set", "scripts/ci"]);
		git(work, ["checkout", sha]);
		const result = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				"--no-warnings",
				repoCheckoutCli,
				"--prepare-full-worktree",
				"--workdir",
				work,
			],
			{ encoding: "utf8" },
		);
		expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
		expect(result.stdout).toContain("hobo_ci_sparse_disable=ok");
		expect(sparseCheckoutEnabled(work)).toBe(false);
	});

	it("exits 1 outside a git worktree", () => {
		const work = mkdtempSync(join(tmpdir(), "hobo-prepare-full-no-git-"));
		const result = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				"--no-warnings",
				repoCheckoutCli,
				"--prepare-full-worktree",
				"--workdir",
				work,
			],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("hobo_ci_sparse_disable=fail");
		rmSync(work, { recursive: true, force: true });
	});
});

describe("hobo-checkout sparse recovery", () => {
	it("materializes the requested cone in a working copy with no checked-out files", () => {
		const action = readFileSync(
			join(
				import.meta.dirname,
				"../../.github/actions/hobo-checkout/action.yml",
			),
			"utf8",
		);
		const step =
			/    - name: Initialize sparse cone before root files\n[\s\S]*?      run: \|\n((?:        .*\n)+)/u.exec(
				action,
			);
		if (!step?.[1]) throw new Error("sparse initialization step is missing");
		const script = step[1]
			.split("\n")
			.filter(Boolean)
			.map((line) => line.slice(8))
			.join("\n");
		const work = join(temp, "work-sparse-recovery");
		execFileSync("git", ["clone", "--no-checkout", source, work]);
		const initialized = spawnSync("bash", ["-c", script], {
			cwd: work,
			encoding: "utf8",
			env: { ...process.env, DIR_CONES: "scripts/ci" },
		});
		expect(initialized.status, initialized.stderr).toBe(0);
		expect(existsSync(join(work, "scripts/ci/ci-trace.mts"))).toBe(true);
	});
});
