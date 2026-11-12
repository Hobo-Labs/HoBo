import { type JsonValue, ResolverError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	gitBlobSha,
	gitTreeSha,
	loadSiteContent,
	parseStaticSiteTree,
	STATIC_SITE_TREE_CONTRACT,
} from "../src/index.js";
import { digestOf, memoryStore, siteFreight } from "./support/world.js";

const encode = (value: JsonValue) =>
	new TextEncoder().encode(JSON.stringify(value));

function indexOf(files: JsonValue[]) {
	const bytes = encode({ contract: STATIC_SITE_TREE_CONTRACT, files });
	return { bytes, digest: digestOf(bytes) };
}

const file = (path: string) => ({
	path,
	digest: `sha256:${"0".repeat(64)}`,
	size: 0,
});

describe("git object ids computed without a git binary", () => {
	it("matches git hash-object for blobs (known answers recorded from git 2.x)", () => {
		expect(gitBlobSha(new Uint8Array())).toBe(
			"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
		);
		expect(gitBlobSha(new TextEncoder().encode("hello\n"))).toBe(
			"ce013625030ba8dba906f756967f9e9ca394464a",
		);
	});

	it("matches git write-tree, including git's directory-sorts-as-slash rule and the executable mode", async () => {
		// Recorded with `git add -A && git write-tree` over the same four files:
		// "a.txt" sorts before directory "a" because "." < "/".
		const freight = siteFreight(
			{
				"index.html": "hello\n",
				"a/b/c.css": "x",
				"run.sh": "#!/bin/sh\n",
				"a.txt": "",
			},
			["run.sh"],
		);
		const site = await loadSiteContent(
			parseStaticSiteTree(freight.index, freight.digest),
			memoryStore(...freight.blobs).get,
		);
		expect(site.treeSha).toBe("d0991e196fa52fcd4d9b75ddfab76663b0811176");
		expect(site.blobs.find((blob) => blob.path === "run.sh")?.mode).toBe(
			"100755",
		);
	});

	it("is independent of the order the index lists files in", () => {
		const blobs = [
			{ path: "b/x", mode: "100644", sha: "1".repeat(40) },
			{ path: "a", mode: "100644", sha: "2".repeat(40) },
		];
		expect(gitTreeSha(blobs)).toBe(gitTreeSha([...blobs].reverse()));
	});
});

describe("static-site tree index parse boundary", () => {
	it("refuses an index that does not hash to the Freight digest", () => {
		const { bytes } = indexOf([file("index.html")]);
		expect(() => parseStaticSiteTree(bytes, digestOf(encode({})))).toThrow(
			/does not hash/u,
		);
	});

	it.each([
		["../escape.html"],
		["a/../../b"],
		["/absolute.html"],
		["a//b"],
		[".git/config"],
		["docs/.GIT/hooks/post-checkout"],
		["dir\\win.html"],
		["tab\tname"],
		["./index.html"],
	])("refuses the path %j", (path) => {
		const { bytes, digest } = indexOf([file(path)]);
		expect(() => parseStaticSiteTree(bytes, digest)).toThrow(ResolverError);
	});

	it("refuses duplicates, file/directory collisions, an empty tree and a foreign contract", () => {
		for (const files of [
			[file("a.html"), file("a.html")],
			[file("a"), file("a/b.html")],
			[],
		]) {
			const { bytes, digest } = indexOf(files);
			expect(() => parseStaticSiteTree(bytes, digest)).toThrow(ResolverError);
		}
		const foreign = encode({ contract: "other/v1", files: [file("a")] });
		expect(() => parseStaticSiteTree(foreign, digestOf(foreign))).toThrow(
			/not a hobo.static-site-tree\/v1/u,
		);
	});

	it("refuses a missing file blob and bytes that do not match their digest", async () => {
		const freight = siteFreight({ "index.html": "<h1>hi</h1>" });
		const tree = parseStaticSiteTree(freight.index, freight.digest);
		await expect(loadSiteContent(tree, async () => undefined)).rejects.toThrow(
			/not in the artifact store/u,
		);
		await expect(
			loadSiteContent(tree, async () => new TextEncoder().encode("tampered")),
		).rejects.toThrow(/do not match/u);
	});
});
