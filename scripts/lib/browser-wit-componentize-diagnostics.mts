import { existsSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BrowserWitComponentizeToolchain } from "./browser-wit-toolchain.mts";

export interface Preview2ShimResolution {
	readonly version: string;
	readonly packagePath: string;
}

export async function resolvePreview2ShimFromComponentizeRoot(
	componentizePackageRoot: string,
	repoRoot?: string,
): Promise<Preview2ShimResolution | null> {
	const requireFrom = createRequire(
		path.join(componentizePackageRoot, "package.json"),
	);
	const resolvers = [
		() => requireFrom.resolve("@bytecodealliance/preview2-shim"),
	];
	if (repoRoot) {
		const runtimeRequire = createRequire(
			path.join(
				repoRoot,
				"packages",
				"runtimes",
				"runtime-wasm",
				"package.json",
			),
		);
		resolvers.push(() =>
			runtimeRequire.resolve("@bytecodealliance/preview2-shim"),
		);
	}
	let entry: string | undefined;
	for (const resolve of resolvers) {
		try {
			entry = resolve();
			break;
		} catch {
			continue;
		}
	}
	if (!entry) {
		return null;
	}
	try {
		const manifestPath = path.join(path.dirname(entry), "..", "package.json");
		// SAFETY: `JSON.parse` is unknown; only optional `version` is read, then string-gated.
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			version?: unknown;
		};
		if (
			Object.prototype.toString.call(manifest.version) !== "[object String]"
		) {
			return { version: "unknown", packagePath: path.dirname(manifestPath) };
		}
		// SAFETY: `manifest.version` was verified to be a string above.
		return {
			version: manifest.version as string,
			packagePath: path.dirname(manifestPath),
		};
	} catch {
		return null;
	}
}

export async function logBrowserWitReleaseEnvironment(context: {
	repoRoot: string;
	workRoot: string;
	workRootLogical: string;
	toolchain: BrowserWitComponentizeToolchain;
}): Promise<void> {
	const preview2 = await resolvePreview2ShimFromComponentizeRoot(
		context.toolchain.componentizePackageRoot,
		context.repoRoot,
	);
	const osTmp = tmpdir();
	let osTmpReal = osTmp;
	let workRootReal = context.workRoot;
	try {
		osTmpReal = await realpath(osTmp);
	} catch {
		osTmpReal = osTmp;
	}
	try {
		workRootReal = await realpath(context.workRootLogical);
	} catch {
		workRootReal = context.workRoot;
	}
	const tmpStat = await describePath(osTmp);
	const workStat = await describePath(context.workRootLogical);
	const mountLine = await tmpMountInfoLine();
	const inContainer = detectContainer();
	process.stderr.write(
		`browser-wit: runner name=${process.env.RUNNER_NAME ?? "(unset)"} os=${process.env.RUNNER_OS ?? process.platform} arch=${process.env.RUNNER_ARCH ?? process.arch}\n`,
	);
	process.stderr.write(
		`browser-wit: container guess=${inContainer} RUNNER_ENVIRONMENT=${process.env.RUNNER_ENVIRONMENT ?? "(unset)"} GITHUB_ACTIONS=${process.env.GITHUB_ACTIONS ?? "(unset)"}\n`,
	);
	process.stderr.write(
		`browser-wit: TMPDIR=${process.env.TMPDIR ?? "(unset)"} os.tmpdir()=${osTmp} realpath=${osTmpReal}\n`,
	);
	process.stderr.write(`browser-wit: /tmp stat ${tmpStat}\n`);
	process.stderr.write(
		`browser-wit: workRoot logical=${context.workRootLogical} realpath=${workRootReal} stat ${workStat}\n`,
	);
	process.stderr.write(
		`browser-wit: /proc/self/mountinfo /tmp line=${mountLine}\n`,
	);
	let pinned: string | undefined;
	try {
		const componentizeManifest: { devDependencies?: Record<string, string> } =
			JSON.parse(
				await readFile(
					path.join(context.toolchain.componentizePackageRoot, "package.json"),
					"utf8",
				),
			);
		pinned =
			componentizeManifest.devDependencies?.["@bytecodealliance/preview2-shim"];
	} catch {
		pinned = undefined;
	}
	if (preview2) {
		process.stderr.write(
			`browser-wit: preview2-shim@${preview2.version} installed (${preview2.packagePath}); componentize-js dev pin=${pinned ?? "none"}\n`,
		);
	} else {
		process.stderr.write(
			`browser-wit: preview2-shim not installed in release graph; componentize-js dev pin=${pinned ?? "none"}\n`,
		);
	}
	process.stderr.write(
		`browser-wit: XDG_CACHE_HOME=${process.env.XDG_CACHE_HOME ?? "(unset)"}\n`,
	);
}

async function describePath(target: string): Promise<string> {
	try {
		const st = await stat(target);
		let link = "";
		try {
			const lst = await lstat(target);
			if (lst.isSymbolicLink()) {
				link = " symlink";
			}
		} catch {
			link = "";
		}
		return `mode=${st.mode.toString(8)} dev=${st.dev} ino=${st.ino}${link}`;
	} catch (error) {
		return `unreadable (${error instanceof Error ? error.message : String(error)})`;
	}
}

async function tmpMountInfoLine(): Promise<string> {
	try {
		const body = await readFile("/proc/self/mountinfo", "utf8");
		const line =
			body
				.split("\n")
				.find((entry) => /\s\/tmp\s/.test(entry) || entry.includes(" /tmp/")) ??
			"";
		return line.length > 0 ? line.slice(0, 240) : "(no /tmp entry)";
	} catch {
		return "(no /proc/self/mountinfo)";
	}
}

function detectContainer(): string {
	if (process.env.HOBO_CI_WORKER_IMAGE) {
		return `worker-image:${process.env.HOBO_CI_WORKER_IMAGE}`;
	}
	if (process.env.RUNNER_ENVIRONMENT === "github-hosted") {
		return "github-hosted";
	}
	return existsSync("/var/run/docker.sock")
		? "likely-container(docker.sock)"
		: "bare-or-vm";
}
