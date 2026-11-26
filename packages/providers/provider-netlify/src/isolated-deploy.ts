import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	anonymousDeployEnv,
	buildAnonymousDeployArgv,
	type ProcessResult,
	type ProcessRunner,
} from "./process-runner.js";

/** Both anonymous entry points use a private HOME and a prebuilt-only snapshot.
 * An ambient login, local CLI configuration, symlink or build script cannot
 * silently turn the temporary lane into an authenticated or executable deploy. */
export async function runIsolatedNetlifyAnonymousDeploy(input: {
	readonly runner: ProcessRunner;
	readonly workDir: string;
	readonly publishDir: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly siteName?: string;
	readonly deployMessage?: string;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
}): Promise<ProcessResult> {
	if (
		path.isAbsolute(input.publishDir) ||
		input.publishDir.split(/[\\/]/u).some((part) => part === "..")
	)
		throw new Error(
			"Netlify publish directory must remain inside its artifact root",
		);
	const source = path.resolve(input.workDir, input.publishDir),
		root = await mkdtemp(path.join(tmpdir(), "hobo-netlify-isolated-")),
		artifact = path.join(root, "artifact"),
		home = path.join(root, "home");
	let files = 0,
		bytes = 0;
	const copy = async (from: string, to: string): Promise<void> => {
		const stat = await lstat(from);
		if (stat.isSymbolicLink())
			throw new Error("Netlify artifact refuses symbolic links");
		if (stat.isDirectory()) {
			await mkdir(to, { mode: 0o700 });
			for (const entry of await readdir(from, { withFileTypes: true })) {
				if (
					[
						".netlify",
						".git",
						"node_modules",
						"netlify.toml",
						".npmrc",
						".env",
					].includes(entry.name) ||
					entry.name.startsWith(".env.")
				)
					throw new Error(
						"Netlify public artifact includes credential or build configuration",
					);
				await copy(path.join(from, entry.name), path.join(to, entry.name));
			}
			return;
		}
		if (!stat.isFile() || ++files > 256)
			throw new Error("Netlify artifact requires bounded regular files");
		const file = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const actual = await file.stat();
			if (!actual.isFile() || actual.size > 2_097_152 - bytes)
				throw new Error("Netlify artifact exceeds its aggregate byte bound");
			const data = Buffer.alloc(2_097_152 - bytes + 1);
			let used = 0;
			while (used < data.length) {
				const read = await file.read(data, used, data.length - used, null);
				if (!read.bytesRead) break;
				used += read.bytesRead;
			}
			bytes += used;
			if (bytes > 2_097_152)
				throw new Error("Netlify artifact exceeds its aggregate byte bound");
			await writeFile(to, data.subarray(0, used), { flag: "wx", mode: 0o600 });
		} finally {
			await file.close();
		}
	};
	try {
		await copy(source, artifact);
		if (!files) throw new Error("Netlify artifact is empty");
		await mkdir(home, { mode: 0o700 });
		const argv = buildAnonymousDeployArgv({
			publishDir: ".",
			...(input.siteName === undefined
				? undefined
				: { siteName: input.siteName }),
			...(input.deployMessage === undefined
				? undefined
				: { deployMessage: input.deployMessage }),
		});
		return await input.runner.run(argv, {
			cwd: artifact,
			env: {
				...anonymousDeployEnv(input.env),
				HOME: home,
				USERPROFILE: home,
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_DATA_HOME: path.join(home, "data"),
				XDG_CACHE_HOME: path.join(home, "cache"),
			},
			timeoutMs: input.timeoutMs,
			maxOutputBytes: input.maxOutputBytes,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
