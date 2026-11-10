import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMergeSegments } from "../src/conflict.js";
import {
	createRepositories,
	type Repositories,
} from "./fixtures/repository.js";

const BASE = "one\ntwo\nthree\nfour\nfive\n";

describe("git workspace (real git)", () => {
	let repos: Repositories;
	let base: string;
	beforeEach(() => {
		repos = createRepositories();
		base = repos.seed({ "a.txt": BASE, "keep.txt": "keep\n" });
	});
	afterEach(() => repos.cleanup());

	async function fetched(branches: Record<string, number>) {
		const workspace = repos.workspace();
		for (const [branch, number] of Object.entries(branches))
			repos.pull(number, branch);
		await workspace.fetch([
			"refs/heads/main",
			...Object.values(branches).map((number) => `refs/pull/${number}/head`),
		]);
		return workspace;
	}

	it("reports a clean trial merge without touching any ref", async () => {
		const ours = repos.commit("ours", { "a.txt": BASE.replace("one", "ONE") });
		const theirs = repos.commit("theirs", {
			"a.txt": BASE.replace("five", "FIVE"),
		});
		const workspace = await fetched({ ours: 1, theirs: 2 });
		const merge = await workspace.trial(ours, theirs);
		expect(merge).toMatchObject({ clean: true, files: [] });
		expect(merge.tree).toMatch(/^[a-f0-9]{40}$/);
		expect(repos.remoteRef("refs/heads/main")).toBe(base);
	});

	it("returns a text conflict as zdiff3 regions with the common base", async () => {
		const ours = repos.commit("ours", {
			"a.txt": BASE.replace("two", "TWO ours"),
		});
		const theirs = repos.commit("theirs", {
			"a.txt": BASE.replace("two", "TWO theirs"),
		});
		const workspace = await fetched({ ours: 1, theirs: 2 });
		const merge = await workspace.trial(ours, theirs);
		expect(merge.clean).toBe(false);
		expect(merge.files).toHaveLength(1);
		const [file] = merge.files;
		expect(file).toMatchObject({
			path: "a.txt",
			kind: "content",
			markerSize: 7,
		});
		expect(parseMergeSegments(file?.merged ?? "", 7)).toEqual([
			{ kind: "text", text: "one\n" },
			{
				kind: "conflict",
				id: 0,
				ours: "TWO ours\n",
				base: "two\n",
				theirs: "TWO theirs\n",
			},
			{ kind: "text", text: "three\nfour\nfive\n" },
		]);
	});

	it("widens the markers when the file already contains marker-like lines", async () => {
		const tricky = `${BASE}<<<<<<< looks like a marker\n=======\n`;
		repos.commit("main", { "a.txt": tricky });
		const ours = repos.commit("ours", {
			"a.txt": tricky.replace("two", "TWO ours"),
		});
		const theirs = repos.commit("theirs", {
			"a.txt": tricky.replace("two", "TWO theirs"),
		});
		const workspace = await fetched({ ours: 1, theirs: 2 });
		const [file] = (await workspace.trial(ours, theirs)).files;
		expect(file?.markerSize).toBe(8);
		const segments = parseMergeSegments(file?.merged ?? "", 8);
		expect(
			segments.filter((segment) => segment.kind === "conflict"),
		).toHaveLength(1);
		expect(segments.at(-1)).toMatchObject({
			kind: "text",
			text: expect.stringContaining("<<<<<<< looks like a marker\n=======\n"),
		});
	});

	it("marks conflicts that are not plain text as unsupported", async () => {
		const binary = new Uint8Array([0, 159, 146, 150, 0, 1]);
		repos.commit("main", { "logo.bin": binary });
		const ours = repos.commit("ours", {
			"keep.txt": "changed by ours\n",
			"logo.bin": new Uint8Array([0, 1, 2, 3]),
		});
		const theirs = repos.commit("theirs", {
			"keep.txt": null,
			"logo.bin": new Uint8Array([0, 9, 9, 9]),
		});
		const workspace = await fetched({ ours: 1, theirs: 2 });
		const merge = await workspace.trial(ours, theirs);
		expect(merge.clean).toBe(false);
		expect(
			Object.fromEntries(merge.files.map((file) => [file.path, file.kind])),
		).toEqual({ "keep.txt": "unsupported", "logo.bin": "unsupported" });
	});

	it("writes a merge commit that differs from git's own merge only at resolved paths", async () => {
		const ours = repos.commit("ours", {
			"a.txt": BASE.replace("two", "TWO ours"),
			"ours-only.txt": "from ours\n",
		});
		const theirs = repos.commit("theirs", {
			"a.txt": BASE.replace("two", "TWO theirs"),
			"theirs-only.txt": "from theirs\n",
		});
		const workspace = await fetched({ ours: 1, theirs: 2 });
		const merge = await workspace.trial(ours, theirs);
		const commit = await workspace.commit({
			tree: merge.tree,
			parents: [ours, theirs],
			files: new Map([["a.txt", BASE.replace("two", "TWO both")]]),
			message: "Merge theirs into ours\n\nHobo-Agent-Resolution: test\n",
		});
		await workspace.push(commit, "refs/heads/hobo-agent/resolve/1-test");
		const ref = "refs/heads/hobo-agent/resolve/1-test";
		expect(repos.remoteRef(ref)).toBe(commit);
		expect(repos.remoteFile(ref, "a.txt")).toBe(
			BASE.replace("two", "TWO both"),
		);
		expect(repos.remoteFile(ref, "ours-only.txt")).toBe("from ours\n");
		expect(repos.remoteFile(ref, "theirs-only.txt")).toBe("from theirs\n");
		expect(repos.git(repos.remote, "log", "-1", "--format=%P", commit)).toBe(
			`${ours} ${theirs}`,
		);
		expect(
			repos.git(repos.remote, "log", "-1", "--format=%an|%B", commit),
		).toContain("hobo-ci-agent|Merge theirs into ours");
		// Only the resolved path differs from the tree git produced.
		expect(
			repos.git(
				repos.agent,
				"diff",
				"--name-only",
				merge.tree,
				`${commit}^{tree}`,
			),
		).toBe("a.txt");
	});

	it("fast-forwards a pull request branch and refuses to rewrite one", async () => {
		const ours = repos.commit("ours", {
			"a.txt": BASE.replace("two", "TWO ours"),
		});
		repos.commit("main", { "a.txt": BASE.replace("two", "TWO main") });
		const workspace = await fetched({ ours: 1 });
		const main = repos.remoteRef("refs/heads/main");
		const merge = await workspace.trial(ours, main);
		const commit = await workspace.commit({
			tree: merge.tree,
			parents: [ours, main],
			files: new Map([["a.txt", BASE.replace("two", "TWO merged")]]),
			message: "Merge main into ours\n",
		});
		await workspace.push(commit, "refs/heads/ours");
		expect(repos.remoteRef("refs/heads/ours")).toBe(commit);
		// Moving the branch back to an older commit would rewrite it.
		await expect(workspace.push(ours, "refs/heads/ours")).rejects.toThrow(
			"git push failed",
		);
		const unrelated = await workspace.commit({
			tree: merge.tree,
			parents: [main, main],
			files: new Map(),
			message: "not a descendant of ours\n",
		});
		await expect(workspace.push(unrelated, "refs/heads/ours")).rejects.toThrow(
			"git push failed",
		);
		expect(repos.remoteRef("refs/heads/ours")).toBe(commit);
	});

	it.each([
		"refs/heads/gh-readonly-queue/main/pr-1-abc",
		"refs/heads/mergify/merge-queue/0123456789",
		"refs/heads/gtmq_abc",
		"refs/tags/v1",
		"refs/heads/../main",
		"main",
		"refs/heads/a b",
	])("refuses to push to %s", async (ref) => {
		const workspace = await fetched({});
		await expect(workspace.push(base, ref)).rejects.toThrow("refused git ref");
	});

	it("refuses refs and object ids that could be read as options", async () => {
		const workspace = await fetched({});
		await expect(workspace.fetch(["--upload-pack=evil"])).rejects.toThrow(
			"refused git ref",
		);
		await expect(workspace.trial("--help", base)).rejects.toThrow(
			"invalid git object id",
		);
		await expect(
			workspace.commit({
				tree: base,
				parents: [base, base],
				files: new Map([["missing.txt", "x"]]),
				message: "m",
			}),
		).rejects.toThrow("not a file in the merged tree");
	});
});
