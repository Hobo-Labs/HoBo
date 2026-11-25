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

/** Absolute repo root, resolved from this module's location. */
export const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** Static fixture workspace: one codegen-opted-in package (`widgets`). */
export const FIXTURE_WORKSPACE = fileURLToPath(
	new URL("../fixtures/workspace", import.meta.url),
);

export interface TempRepoOptions {
	/** Copy the repo's buf.gen.yaml into the temp root (default true). */
	readonly withBufTemplate?: boolean;
	/** Link the repo's cached CUE binary into the temp root (default true). */
	readonly withCueCache?: boolean;
	/** Fixture workspace directory to copy in; omit for an empty packages/. */
	readonly workspace?: string | undefined;
}

/**
 * Scaffold a throwaway repo root that the schema-tools CLI can run against
 * hermetically: the vendored buf binary resolves module-relative, the CUE
 * binary is linked from the real repo's .tools cache (no network), and the
 * package tree comes from a static fixture.
 */
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

/**
 * Fixture .proto/.cue files are checked in with a .txt suffix so the
 * architecture guard's misplaced-data-model rule (schemas only under a real
 * package's data-models/) does not fire on test fixtures; restore the real
 * extensions in the scaffolded copy.
 */
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
