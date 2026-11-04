import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
	access,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
	unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const command = process.argv[2];
const payload = process.env.HOBO_CI_DEPS_PAYLOAD ?? "/opt/hobo-deps";
const root = process.cwd();

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function payloadNodeModules(): Promise<readonly string[]> {
	if (!(await exists(payload))) return [];
	const found: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (!entry.isDirectory()) continue;
			if (entry.name === "node_modules") found.push(path);
			else await visit(path);
		}
	};
	await visit(payload);
	return found;
}

async function repairWorkspaceLinks(directory: string): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await repairWorkspaceLinks(path);
			continue;
		}
		if (!entry.isSymbolicLink()) continue;
		const target = await readlink(path);
		if (isAbsolute(target)) continue;
		const resolved = resolve(dirname(path), target);
		const relativeTarget = relative(payload, resolved);
		if (
			!relativeTarget ||
			relativeTarget.startsWith("..") ||
			isAbsolute(relativeTarget) ||
			relativeTarget.split(sep).includes("node_modules")
		)
			continue;
		await unlink(path);
		await symlink(join(root, relativeTarget), path);
	}
}

async function linkPayload(): Promise<void> {
	if (!process.env.HOBO_CI_DEPS_LAYER) return;
	for (const source of await payloadNodeModules()) {
		const destination = join(root, relative(payload, source));
		await mkdir(dirname(destination), { recursive: true });
		await rm(destination, { recursive: true, force: true });
		await symlink(source, destination, "dir");
	}
	await repairWorkspaceLinks(payload);
}

async function expectedKey(): Promise<string> {
	const injected = process.env.HOBO_CI_DEPS_EXPECTED_KEY;
	if (injected) return injected;
	const platform = `linux/${process.arch === "x64" ? "amd64" : process.arch}`;
	const { depsKeyForRoot } = await import("../lib/deps-key.mts");
	return depsKeyForRoot(root, platform);
}

async function matches(expected: string): Promise<boolean> {
	const actual = process.env.HOBO_CI_DEPS_LAYER;
	if (!actual || actual !== expected) return false;
	try {
		const modules = join(root, "node_modules");
		const [
			modulesRealpath,
			payloadRealpath,
			marker,
			modulesState,
			workspaceManifest,
		] = await Promise.all([
			realpath(modules),
			realpath(join(payload, "node_modules")),
			readFile(join(payload, ".hobo-ci-deps-key"), "utf8"),
			readFile(join(modules, ".modules.yaml"), "utf8"),
			realpath(join(modules, "@hobo", "ci-gh-actions", "package.json")),
		]);
		if (
			modulesRealpath !== payloadRealpath ||
			marker.trim() !== expected ||
			!modulesState.includes('"virtualStoreDir":".pnpm"') ||
			!(await stat(join(modules, ".pnpm"))).isDirectory() ||
			workspaceManifest !==
				join(root, "packages", "ci-gh-actions", "package.json")
		)
			return false;
		createRequire(join(root, "package.json")).resolve("tsx");
		createRequire(
			join(root, "packages", "ci-gh-actions", "package.json"),
		).resolve("tsx");
		const executable = spawnSync("pnpm", ["exec", "tsx", "--version"], {
			cwd: root,
			env: process.env,
			stdio: "ignore",
			timeout: 30_000,
		});
		return executable.status === 0;
	} catch {
		return false;
	}
}

if (command === "link") {
	try {
		await linkPayload();
	} catch (error) {
		console.error(
			`deps layer link failed: ${error instanceof Error ? error.message : "unknown"}`,
		);
	}
} else if (command === "check") {
	let expected = "unavailable";
	try {
		expected = await expectedKey();
	} catch {
		// A missing or incomplete checkout key is an ordinary install fallback.
	}
	const match = expected !== "unavailable" && (await matches(expected));
	const actual = process.env.HOBO_CI_DEPS_LAYER ?? "none";
	console.log(
		`deps layer ${match ? "match" : "miss"}: job=${actual}, checkout=${expected}\nmatch=${match}`,
	);
	if (process.env.GITHUB_OUTPUT)
		appendFileSync(process.env.GITHUB_OUTPUT, `match=${match}\n`);
	if (process.argv.includes("--require") && !match) process.exitCode = 1;
} else {
	throw new Error("usage: deps-layer.mts link|check [--require]");
}
