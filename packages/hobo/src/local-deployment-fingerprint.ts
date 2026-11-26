import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".cache"]);

function temporary(name: string): boolean {
	return (
		/\.(?:tmp|temp|swp|swo|log|bak)$/iu.test(name) ||
		name.endsWith("~") ||
		name.startsWith(".#")
	);
}

/** Hash executable project inputs and packaged artifacts, excluding local control state. */
export async function fingerprintLocalDeployment(
	projectDir: string,
	hoboHome: string,
): Promise<string> {
	const project = resolve(projectDir);
	const home = resolve(hoboHome);
	if (project === home)
		throw new Error(
			"HOBO_HOME must be separate from the application project directory",
		);
	const hash = createHash("sha256");
	const ancestors = new Set<string>();
	async function visit(directory: string): Promise<void> {
		const actual = await realpath(directory);
		if (ancestors.has(actual))
			throw new Error(`Circular deployment input directory: ${directory}`);
		ancestors.add(actual);
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			for (const entry of entries) {
				const file = join(directory, entry.name);
				const path = relative(project, file).split(sep).join("/");
				const generated = /^\.hobo\/(?:build|generated)(?:\/|$)/u.test(path);
				if (
					!generated &&
					(IGNORED_DIRECTORIES.has(entry.name) ||
						temporary(entry.name) ||
						entry.name === ".hobo-codegen.lock" ||
						entry.name.startsWith(".hobo-codegen-"))
				)
					continue;
				if (resolve(file) === home) continue;
				if (path.startsWith(".hobo/") && !generated) continue;
				const info = entry.isSymbolicLink() ? await stat(file) : entry;
				if (info.isDirectory()) await visit(file);
				else if (info.isFile()) {
					const bytes = await readFile(file);
					hash.update(JSON.stringify([path, bytes.length]));
					hash.update(bytes);
				} else throw new Error(`Unsupported deployment input: ${path}`);
			}
		} finally {
			ancestors.delete(actual);
		}
	}
	await visit(project);
	return `sha256:${hash.digest("hex")}`;
}
