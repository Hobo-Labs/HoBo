import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, join, sep } from "node:path";

export type WorkDirInodeBreakdown = Readonly<{
	entries: number;
	git: number;
	linkedNodeModules: number;
	pnpmVirtualStoreInWork: number;
	other: number;
}>;

export type WorkDirInodeIo = Readonly<{
	lstat(path: string): ReturnType<typeof lstat>;
	readdir(path: string): Promise<readonly string[]>;
	readlink(path: string): ReturnType<typeof readlink>;
}>;

const defaultIo: WorkDirInodeIo = { lstat, readdir, readlink };

function classifiesPath(
	relative: string,
): "git" | "pnpmVirtualStoreInWork" | "other" {
	const parts = relative.split(sep).filter(Boolean);
	if (parts.includes(".git")) return "git";
	const nodeModules = parts.indexOf("node_modules");
	if (nodeModules >= 0 && parts[nodeModules + 1] === ".pnpm")
		return "pnpmVirtualStoreInWork";
	return "other";
}

/** Count inodes by category without following directory symlinks. */
export async function measureWorkDirInodeBreakdown(
	root: string,
	io: WorkDirInodeIo = defaultIo,
): Promise<WorkDirInodeBreakdown> {
	const counts = {
		entries: 0,
		git: 0,
		linkedNodeModules: 0,
		pnpmVirtualStoreInWork: 0,
		other: 0,
	};
	const visit = async (entryPath: string, relative: string): Promise<void> => {
		counts.entries += 1;
		const metadata = await io.lstat(entryPath);
		if (metadata.isSymbolicLink()) {
			const name = basename(entryPath);
			if (name === "node_modules") {
				counts.linkedNodeModules += 1;
				return;
			}
			const bucket = classifiesPath(relative);
			if (bucket === "git") counts.git += 1;
			else if (bucket === "pnpmVirtualStoreInWork")
				counts.pnpmVirtualStoreInWork += 1;
			else counts.other += 1;
			return;
		}
		const bucket = classifiesPath(relative);
		if (bucket === "git") counts.git += 1;
		else if (bucket === "pnpmVirtualStoreInWork")
			counts.pnpmVirtualStoreInWork += 1;
		else counts.other += 1;
		if (!metadata.isDirectory()) return;
		for (const entry of await io.readdir(entryPath)) {
			const childRel = relative ? join(relative, entry) : entry;
			await visit(join(entryPath, entry), childRel);
		}
	};
	await visit(root, "");
	return counts;
}
