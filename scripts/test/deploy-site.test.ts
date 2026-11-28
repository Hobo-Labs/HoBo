import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { siteTree } from "../ci/create-github-release.mts";
import { parseDeploySiteArgs } from "../deploy-site.mts";

function site(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-site-dist-"));
	writeFileSync(join(dir, "index.html"), "<h1>HoBo</h1>");
	writeFileSync(join(dir, ".nojekyll"), "");
	return dir;
}

describe("deploy-site release Freight", () => {
	it("indexes the published tree without the staging clone's .git", () => {
		const dir = site();
		const before = siteTree(dir).digest;
		mkdirSync(join(dir, ".git"));
		writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/gh-pages");
		expect(siteTree(dir).digest).toBe(before);
	});

	it("publishes only through the Pages realizer: no git push, no orphan force-push", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "deploy-site.mts"),
			"utf8",
		);
		expect(source).not.toMatch(/"push"/u);
		expect(source).not.toMatch(/--force/u);
		expect(source).toContain("qualifySiteRelease");
		expect(source).toContain("qualifySiteCandidate");
		expect(source).toContain("promoteSiteStable");
	});

	it("parses candidate-only and stable-only without dropping the both-promotions default", () => {
		expect(parseDeploySiteArgs([])).toEqual({ mode: "build" });
		expect(parseDeploySiteArgs(["--release-freight", "site/dist"])).toEqual({
			mode: "freight",
			dist: "site/dist",
			candidateOnly: false,
		});
		expect(
			parseDeploySiteArgs([
				"--candidate-only",
				"--release-freight",
				"site/dist",
			]),
		).toEqual({
			mode: "freight",
			dist: "site/dist",
			candidateOnly: true,
		});
		expect(parseDeploySiteArgs(["--stable-only"])).toEqual({ mode: "stable" });
	});

	it("rejects a flag pair that would record and promote the wrong half", () => {
		expect(() =>
			parseDeploySiteArgs(["--candidate-only", "--stable-only"]),
		).toThrow(/cannot be combined/u);
		expect(() => parseDeploySiteArgs(["--candidate-only"])).toThrow(
			/requires --release-freight/u,
		);
		expect(() =>
			parseDeploySiteArgs(["--stable-only", "--release-freight", "site/dist"]),
		).toThrow(/does not take --release-freight/u);
		expect(() => parseDeploySiteArgs(["--release-freight"])).toThrow(
			/needs the built site directory/u,
		);
		expect(() =>
			parseDeploySiteArgs(["--release-freight", "--candidate-only"]),
		).toThrow(/needs the built site directory/u);
	});
});
