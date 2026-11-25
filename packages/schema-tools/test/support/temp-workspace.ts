import {
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export const FIXTURE_WORKSPACE = fileURLToPath(
	new URL("../fixtures/workspace", import.meta.url),
);

export interface TempRepoOptions {
	readonly withBufTemplate?: boolean;
	readonly withCueCache?: boolean;
	readonly workspace?: string | undefined;
}

export async function makeTempRepo(
	options: TempRepoOptions = {},
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "schema-tools-test-"));
	if (options.withCueCache !== false) {
		await mkdir(join(root, ".tools", "cue"), { recursive: true });
		await symlink(
			join(REPO_ROOT, ".tools", "cue", "v0.14.0"),
			join(root, ".tools", "cue", "v0.14.0"),
		);
	}
	if (options.withBufTemplate !== false) {
		await copyFile(join(REPO_ROOT, "buf.gen.yaml"), join(root, "buf.gen.yaml"));
	}
	if (options.workspace) {
		await cp(options.workspace, root, { recursive: true });
		await restoreSchemaExtensions(root);
	} else {
		await mkdir(join(root, "packages"), { recursive: true });
	}
	return root;
}

async function restoreSchemaExtensions(root: string): Promise<void> {
	const entries = await readdir(root, { withFileTypes: true, recursive: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (/\.(proto|cue)\.txt$/.test(entry.name)) {
			const absolute = join(entry.parentPath, entry.name);
			await rename(absolute, absolute.slice(0, -".txt".length));
		}
	}
}

export async function removeTempRepo(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}
