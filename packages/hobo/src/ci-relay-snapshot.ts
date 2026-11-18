import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinnedGitEnvironment } from "./pinned-git-source.js";

export async function relayCommitSnapshot(
	relayDir: string,
	sha: string,
): Promise<{ dir: string; close(): Promise<void> }> {
	if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
		throw new Error("The relay commit is not a complete Git object id.");
	const gitEnv = pinnedGitEnvironment();
	const git = (args: readonly string[]): Promise<Buffer> =>
		new Promise((resolve, reject) =>
			execFile(
				"git",
				[...args],
				{
					cwd: relayDir,
					env: gitEnv,
					encoding: "buffer",
					maxBuffer: 32 * 1024 * 1024,
					timeout: 30_000,
				},
				(error, stdout) => {
					if (error) reject(error);
					else resolve(stdout);
				},
			),
		);
	if (
		(await git(["rev-parse", "--verify", `${sha}^{commit}`]))
			.toString("utf8")
			.trim() !== sha
	)
		throw new Error("The relay commit does not resolve exactly.");
	const prefix = (await git(["rev-parse", "--show-prefix"]))
		.toString("utf8")
		.replace(/\r?\n$/u, "")
		.replace(/\/$/u, "");
	const tree = prefix.length === 0 ? sha : `${sha}:${prefix}`;
	const listing = await git(["ls-tree", "--full-tree", "-r", "-z", tree]);
	if (!Buffer.from(listing.toString("utf8"), "utf8").equals(listing))
		throw new Error("The committed relay tree contains a non-UTF-8 path.");

	const root = await mkdtemp(path.join(tmpdir(), "hobo-ci-commit-"));
	try {
		const source = path.join(root, "source");
		await mkdir(source);
		let ancestor = path.resolve(relayDir);
		while (true) {
			const modules = path.join(ancestor, "node_modules");
			if (existsSync(modules)) {
				await symlink(
					modules,
					path.join(root, "node_modules"),
					process.platform === "win32" ? "junction" : "dir",
				);
				break;
			}
			const parent = path.dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
		const entries = listing.toString("utf8").split("\0").filter(Boolean);
		if (entries.length > 5_000)
			throw new Error("The committed relay tree is too large to inspect.");
		let total = 0;
		for (const entry of entries) {
			const tab = entry.indexOf("\t");
			const meta = entry
				.slice(0, tab)
				.match(/^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/u);
			const name = entry.slice(tab + 1);
			if (
				name === "deploy/secret-store.binding.json" ||
				name === "packages/ci-vercel/deploy/secret-store.binding.json"
			)
				continue;
			const parts = name.split("/");
			if (
				tab < 0 ||
				meta === null ||
				parts.some(
					(part) =>
						!part || part === "." || part === ".." || /[\\:]/u.test(part),
				)
			)
				throw new Error(
					"The committed relay tree contains an unsupported path or file type.",
				);
			const oid = meta[2];
			if (oid === undefined) throw new Error("Invalid Git tree entry.");
			const content = await git(["cat-file", "blob", oid]);
			total += content.length;
			if (total > 32 * 1024 * 1024)
				throw new Error("The committed relay tree is too large to inspect.");
			const destination = path.join(source, ...parts);
			await mkdir(path.dirname(destination), { recursive: true });
			await writeFile(destination, content, {
				mode: meta[1] === "100755" ? 0o755 : 0o644,
			});
		}
		return {
			dir: source,
			close: () => rm(root, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
