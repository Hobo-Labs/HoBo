import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	checkoutFromBareMirror,
	classifyCheckoutTransportError,
	mirrorObjectsPath,
	submodulesEnabledFromCliArg,
	writeAlternates,
} from "../../.github/actions/hobo-checkout/repo-checkout.mts";

const repository = "Hobo-Labs/HoBo";
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
	writeFileSync(join(source, "README.md"), "mirror fixture\n");
	writeFileSync(join(source, "scripts/ci/ci-trace.mts"), "export {};\n");
	git(source, ["add", "README.md", "scripts/ci/ci-trace.mts"]);
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
