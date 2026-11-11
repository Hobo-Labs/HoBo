import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
	access,
	lstat,
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

async function payloadLayerKey(): Promise<string | undefined> {
	const marker = join(payload, ".hobo-ci-deps-key");
	if (!(await exists(marker))) return undefined;
	return (await readFile(marker, "utf8")).trim() || undefined;
}

async function resolveLayerKey(): Promise<string | undefined> {
	const fromEnv = process.env.HOBO_CI_DEPS_LAYER?.trim();
	if (fromEnv) return fromEnv;
	return payloadLayerKey();
}

async function collapsePackageNodeModules(): Promise<number> {
	let collapsed = 0;
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(directory, entry.name);
			if (entry.name === "node_modules") {
				const metadata = await lstat(path);
				if (metadata.isSymbolicLink()) continue;
				const relativePath = relative(root, path);
				const payloadPath = join(payload, relativePath);
				if (!(await exists(payloadPath))) continue;
				const payloadStat = await lstat(payloadPath);
				if (!payloadStat.isSymbolicLink() && !payloadStat.isDirectory())
					continue;
				await rm(path, { recursive: true, force: true });
				const target = await realpath(payloadPath);
				await symlink(target, path, "dir");
				collapsed += 1;
				continue;
			}
			await visit(path);
		}
	};
	await visit(join(root, "packages"));
	return collapsed;
}

async function linkPayload(): Promise<void> {
	const layer = await resolveLayerKey();
	if (!layer) return;
	process.env.HOBO_CI_DEPS_LAYER = layer;
	const collapsed = await collapsePackageNodeModules();
	if (collapsed > 0) {
		console.error(
			`deps layer collapsed ${collapsed} package node_modules director${collapsed === 1 ? "y" : "ies"} to payload symlinks`,
		);
	}
	for (const source of await payloadNodeModules()) {
		const destination = join(root, relative(payload, source));
		// A package the layer has and this checkout does not was dropped from
		// the tree after the layer was built. Its directory is not brought
		// back: one holding only `node_modules` is a package directory with
		// none of a package's files, and the layout check fails on it.
		if (!(await exists(dirname(destination)))) continue;
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

type Match =
	| Readonly<{ match: true }>
	| Readonly<{ match: false; reason: string }>;

function miss(reason: string): Match {
	return { match: false, reason };
}

// pnpm writes .modules.yaml as pretty-printed JSON.
const PNPM_VIRTUAL_STORE = /"virtualStoreDir"\s*:\s*"\.pnpm"/;

async function matches(expected: string): Promise<Match> {
	const actual = await resolveLayerKey();
	if (!actual || actual !== expected) return miss("job-key-mismatch");
	process.env.HOBO_CI_DEPS_LAYER = actual;
	const step = async <T,>(reason: string, run: () => Promise<T> | T) => {
		try {
			return { ok: true as const, value: await run() };
		} catch (error) {
			const code =
				error instanceof Error && "code" in error
					? `: ${String(error.code)}`
					: "";
			return { ok: false as const, reason: `${reason}${code}` };
		}
	};
	const modules = join(root, "node_modules");
	const marker = await step("payload-key", () =>
		readFile(join(payload, ".hobo-ci-deps-key"), "utf8"),
	);
	if (!marker.ok) return miss(marker.reason);
	if (marker.value.trim() !== expected) return miss("payload-key-mismatch");
	const linked = await step(
		"modules-not-linked",
		async () =>
			(await realpath(modules)) ===
			(await realpath(join(payload, "node_modules"))),
	);
	if (!linked.ok) return miss(linked.reason);
	if (!linked.value) return miss("modules-not-linked");
	const store = await step(
		"virtual-store",
		async () =>
			PNPM_VIRTUAL_STORE.test(
				await readFile(join(modules, ".modules.yaml"), "utf8"),
			) && (await stat(join(modules, ".pnpm"))).isDirectory(),
	);
	if (!store.ok) return miss(store.reason);
	if (!store.value) return miss("virtual-store");
	// The root manifest declares no workspace dependency; packages do.
	const workspaceLink = await step(
		"workspace-link",
		async () =>
			(await realpath(
				join(
					root,
					"packages",
					"ci-gh-actions",
					"node_modules",
					"@hobo",
					"ci",
					"package.json",
				),
			)) === join(root, "packages", "ci", "package.json"),
	);
	if (!workspaceLink.ok) return miss(workspaceLink.reason);
	if (!workspaceLink.value) return miss("workspace-link");
	const tsx = await step("tsx-unresolved", () => {
		createRequire(join(root, "package.json")).resolve("tsx");
		createRequire(
			join(root, "packages", "ci-gh-actions", "package.json"),
		).resolve("tsx");
	});
	if (!tsx.ok) return miss(tsx.reason);
	const executable = spawnSync("pnpm", ["exec", "tsx", "--version"], {
		cwd: root,
		env: process.env,
		stdio: "ignore",
		timeout: 30_000,
	});
	return executable.status === 0 ? { match: true } : miss("pnpm-exec");
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
	} catch (error) {
		// A missing importer (sparse S0 used to omit media/package.json) is an
		// ordinary install fallback. Name the path so the next miss is diagnosable.
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`deps layer checkout-key unavailable: ${detail}`);
	}
	const result =
		expected === "unavailable" ? miss("checkout-key") : await matches(expected);
	const match = result.match;
	const actual = process.env.HOBO_CI_DEPS_LAYER ?? "none";
	console.log(
		`deps layer ${result.match ? "match" : `miss (${result.reason})`}: job=${actual}, checkout=${expected}\nmatch=${match}`,
	);
	if (process.env.GITHUB_OUTPUT)
		appendFileSync(process.env.GITHUB_OUTPUT, `match=${match}\n`);
	if (process.argv.includes("--require") && !match) process.exitCode = 1;
} else {
	throw new Error("usage: deps-layer.mts link|check [--require]");
}
