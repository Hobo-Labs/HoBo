import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	boxGitMirrorInsteadOfConfig,
	resolveBoxGitMirror,
} from "../../.github/actions/hobo-checkout/box-git-mirror.mts";

const repository = "Hobo-Labs/HoBo";
const probe = join(
	import.meta.dirname,
	"..",
	"..",
	".github/actions/hobo-checkout/box-git-mirror.mts",
);
let temp = "";
let source = "";
let mirror = "";
let sha = "";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function env(shaValue = sha, mirrorValue = mirror): NodeJS.ProcessEnv {
	return {
		GITHUB_REPOSITORY: repository,
		GITHUB_SHA: shaValue,
		HOBO_CI_GIT_MIRROR: mirrorValue,
	};
}

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), "hobo-box-git-mirror-"));
	source = join(temp, "source");
	mirror = join(temp, "mirror.git");
	mkdirSync(source);
	git(source, ["init"]);
	writeFileSync(join(source, "README.md"), "mirror fixture\n");
	git(source, ["add", "README.md"]);
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

describe("resolveBoxGitMirror", () => {
	it("misses a promisor blob:none bare mirror", () => {
		const partial = join(temp, "partial.git");
		execFileSync("git", ["clone", "--bare", source, partial]);
		execFileSync("git", [
			"--git-dir",
			partial,
			"config",
			"remote.origin.promisor",
			"true",
		]);
		execFileSync("git", [
			"--git-dir",
			partial,
			"config",
			"extensions.partialclonefilter",
			"blob:none",
		]);
		const result = resolveBoxGitMirror(env(sha, partial));
		expect(result.status).toBe("miss");
		if (result.status === "miss") {
			expect(result.reason).toContain("partial or promisor");
		}
	});

	it("uses HOBO_CI_GIT_MIRROR_ROOT before legacy /var/lib paths", () => {
		const root = join(temp, "mirror-root");
		mkdirSync(root, { recursive: true });
		const rooted = join(root, `${repository}.git`);
		execFileSync("git", ["clone", "--bare", source, rooted]);
		const result = resolveBoxGitMirror({
			GITHUB_REPOSITORY: repository,
			GITHUB_SHA: sha,
			HOBO_CI_GIT_MIRROR_ROOT: root,
		});
		expect(result.status).toBe("hit");
		if (result.status === "hit") {
			expect(result.mirror).toBe(realpathSync(rooted));
		}
	});
	it("misses without throwing when the path does not exist", () => {
		const result = resolveBoxGitMirror(env(sha, join(temp, "missing.git")));
		expect(result.status).toBe("miss");
	});

	it("hits a bare mirror containing the triggering commit", () => {
		const result = resolveBoxGitMirror(env());
		expect(result).toEqual({
			status: "hit",
			mirror: realpathSync(mirror),
			insteadOfConfig: boxGitMirrorInsteadOfConfig(mirror, repository),
		});
	});

	it("misses a bare mirror that lacks the triggering commit", () => {
		const result = resolveBoxGitMirror(env("0".repeat(40)));
		expect(result.status).toBe("miss");
		if (result.status === "miss") {
			expect(result.reason).toContain("does not contain");
		}
	});

	it("misses a blobless mirror that has the commit but not its files", () => {
		// What the box built (finding 104): the commit is there, so the probe
		// used to say hit, and the checkout then died asking the mirror for blobs.
		git(source, ["config", "uploadpack.allowFilter", "true"]);
		const blobless = join(temp, "blobless.git");
		execFileSync("git", [
			"clone",
			"--bare",
			"--filter=blob:none",
			`file://${source}`,
			blobless,
		]);
		const result = resolveBoxGitMirror(env(sha, blobless));
		expect(result.status).toBe("miss");
	});

	it("never treats a missing SHA as a hit", () => {
		expect(resolveBoxGitMirror(env("0".repeat(40))).status).not.toBe("hit");
		expect(resolveBoxGitMirror(env("")).status).toBe("miss");
	});

	for (const invalid of ["relative.git", `${temp}/../escape.git`]) {
		it(`rejects invalid mirror path ${invalid}`, () => {
			const result = resolveBoxGitMirror(env(sha, invalid));
			expect(result.status).toBe("miss");
			if (result.status === "miss") {
				expect(result.reason).toContain("HOBO_CI_GIT_MIRROR");
			}
		});
	}
});

describe("boxGitMirrorInsteadOfConfig", () => {
	it("maps both GitHub URL forms without changing the stored remote", () => {
		const before = git(mirror, ["remote", "get-url", "origin"]);
		const result = resolveBoxGitMirror(env());
		expect(result.status).toBe("hit");
		if (result.status !== "hit") return;
		expect(result.insteadOfConfig).toContain(
			`[url "file://${realpathSync(mirror)}"]`,
		);
		expect(result.insteadOfConfig).toContain(
			`insteadOf = https://github.com/${repository}\n`,
		);
		expect(result.insteadOfConfig).toContain(
			`insteadOf = https://github.com/${repository}.git\n`,
		);
		expect(result.insteadOfConfig).not.toContain("remote.");
		expect(git(mirror, ["remote", "get-url", "origin"])).toBe(before);
	});
});

describe("box git mirror executable", () => {
	it("writes the system config and reports a hit", () => {
		const config = join(temp, "system.gitconfig");
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				probe,
				"--write-config",
				config,
			],
			{ env: { ...process.env, ...env() }, encoding: "utf8" },
		);
		expect(output).toContain("hobo_ci_git_mirror=hit");
		expect(output).toContain("insteadOf = https://github.com/Hobo-Labs/HoBo");
		expect(readFileSync(config, "utf8")).toBe(
			boxGitMirrorInsteadOfConfig(mirror, repository),
		);
	});

	it("reports a miss, exits zero, and writes no config", () => {
		const config = join(temp, "missing-system.gitconfig");
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				probe,
				"--write-config",
				config,
			],
			{
				env: { ...process.env, ...env(sha, join(temp, "absent.git")) },
				encoding: "utf8",
			},
		);
		expect(output).toContain("hobo_ci_git_mirror=miss");
		expect(existsSync(config)).toBe(false);
	});
});
