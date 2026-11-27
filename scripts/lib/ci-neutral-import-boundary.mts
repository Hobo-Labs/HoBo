import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

export function resolveImportSegments(specifier: string): readonly string[] {
	const parts: string[] = [];
	for (const segment of specifier.replaceAll("\\", "/").split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (parts.length > 0) parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts;
}

export function hostLayerEscapeSpecifier(specifier: string): boolean {
	if (!specifier.includes("..")) return false;
	const parts = resolveImportSegments(specifier);
	if (parts[0] === "host") return true;
	return parts[0] === "ci-gh-actions" || parts.includes("ci-gh-actions");
}

function packageFolderFromPath(
	absolutePath: string,
	packagesDir: string,
): string | null {
	const rel = relative(packagesDir, absolutePath);
	if (rel.startsWith("..")) return null;
	const folder = rel.split(/[/\\]/u)[0] ?? "";
	return folder === "" ? null : folder;
}

export function crossPackageFolderFromRelativeImport(
	fromFile: string,
	specifier: string,
	packagesDir: string,
): string | null {
	if (!specifier.startsWith(".")) return null;
	const fromFolder = packageFolderFromPath(fromFile, packagesDir);
	if (fromFolder === null) return null;
	const resolved = resolve(dirname(fromFile), specifier);
	const targetFolder = packageFolderFromPath(resolved, packagesDir);
	if (targetFolder === null || targetFolder === fromFolder) return null;
	return targetFolder;
}

const workspacePackageManifestSchema = z.object({
	name: z.string().optional(),
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
	peerDependencies: z.record(z.string(), z.string()).optional(),
});

type WorkspacePackageManifest = z.infer<typeof workspacePackageManifestSchema>;

function readWorkspaceManifest(manifestPath: string): WorkspacePackageManifest {
	const text = readFileSync(manifestPath, "utf8");
	const parsed = workspacePackageManifestSchema.safeParse(JSON.parse(text));
	return parsed.success ? parsed.data : {};
}

function loadPackageNameByFolder(packagesDir: string): Map<string, string> {
	const nameByFolder = new Map<string, string>();
	for (const folder of readdirSync(packagesDir)) {
		const manifestPath = join(packagesDir, folder, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = readWorkspaceManifest(manifestPath);
		if (manifest.name !== undefined) {
			nameByFolder.set(folder, manifest.name);
		}
	}
	return nameByFolder;
}

function workspaceDeps(manifestPath: string): readonly string[] {
	const manifest = readWorkspaceManifest(manifestPath);
	const names: string[] = [];
	for (const section of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
	] as const) {
		const deps = manifest[section];
		if (deps === undefined) continue;
		for (const [dep, ver] of Object.entries(deps)) {
			if (dep.startsWith("@hobo/") && ver.startsWith("workspace:")) {
				names.push(dep);
			}
		}
	}
	return names;
}

export function buildCiNeutralImportAllowlist(
	repoRoot: string,
): ReadonlySet<string> {
	const packagesDir = join(repoRoot, "packages");
	const nameByFolder = loadPackageNameByFolder(packagesDir);
	const seedFolder = "ci";
	const seedName = nameByFolder.get(seedFolder);
	if (seedName === undefined) {
		return new Set();
	}

	const folderByName = new Map<string, string>();
	for (const [folder, name] of nameByFolder) {
		folderByName.set(name, folder);
	}

	const allow = new Set<string>([seedName]);
	const queue = [seedName];
	while (queue.length > 0) {
		const name = queue.shift();
		if (name === undefined) continue;
		const folder = folderByName.get(name);
		if (folder === undefined) continue;
		for (const dep of workspaceDeps(
			join(packagesDir, folder, "package.json"),
		)) {
			if (!allow.has(dep)) {
				allow.add(dep);
				queue.push(dep);
			}
		}
	}
	allow.delete("@hobo/ci-gh-actions");
	return allow;
}

export function neutralCiCrossPackageImportViolation(
	fromFile: string,
	specifier: string,
	repoRoot: string,
	allowlist: ReadonlySet<string>,
): string | null {
	if (hostLayerEscapeSpecifier(specifier)) {
		return `forbidden host or ci-gh-actions escape via "${specifier}"`;
	}
	const packagesDir = join(repoRoot, "packages");
	const targetFolder = crossPackageFolderFromRelativeImport(
		fromFile,
		specifier,
		packagesDir,
	);
	if (targetFolder === null) return null;
	const nameByFolder = loadPackageNameByFolder(packagesDir);
	const pkgName = nameByFolder.get(targetFolder);
	if (pkgName === undefined) {
		return `unresolved cross-package target folder "${targetFolder}"`;
	}
	if (pkgName === "@hobo/ci-gh-actions") {
		return `forbidden import of ${pkgName}`;
	}
	if (!allowlist.has(pkgName)) {
		return `cross-package import of "${pkgName}" via "${specifier}" is outside the @hobo/ci dependency closure`;
	}
	return null;
}
