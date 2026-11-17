import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

function within(base: string, candidate: string): boolean {
	const relative = path.relative(base, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Check every existing metadata path before a batch may write. Symlinked scopes,
 * nested links, and multiply linked files can otherwise redirect an overwrite
 * or deletion into a different project or outside the checkout. This is a
 * preflight for a trusted local workspace, not protection from concurrent swaps.
 */
export function assertSafeOptimizexpWriteScopes(root: string, projectPaths: readonly string[]): void {
	const repo = realpathSync(root);
	const visited = new Set<string>();
	const inspect = (target: string): void => {
		let stat;
		try {
			stat = lstatSync(target);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		if (stat.isSymbolicLink()) throw new Error(`Unsafe OptimizeXP write path: symbolic link at ${target}`);
		if (stat.isDirectory()) {
			for (const name of readdirSync(target)) inspect(path.join(target, name));
		} else if (!stat.isFile() || stat.nlink > 1) {
			throw new Error(`Unsafe OptimizeXP write path: linked or non-regular file at ${target}`);
		}
	};
	for (const projectPath of projectPaths) {
		const project = path.resolve(repo, projectPath || ".");
		if (!within(repo, project)) throw new Error(`Project write path escapes repository: ${projectPath}`);
		const actual = realpathSync(project);
		if (!within(repo, actual)) throw new Error(`Project write path resolves outside repository: ${projectPath}`);
		if (actual !== project) throw new Error(`Project write path resolves through a symbolic link: ${projectPath}`);
		const scope = path.join(actual, ".optimizexp");
		if (visited.has(scope)) continue;
		visited.add(scope);
		inspect(scope);
	}
}

/** A concise diagnostic for command-line preflight failures. */
export function optimizexpWriteProblem(root: string, projectPaths: readonly string[]): string | undefined {
	try {
		assertSafeOptimizexpWriteScopes(root, projectPaths);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
