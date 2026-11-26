import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	PipelineSchema,
	parsePipeline,
	parseRelativePath,
} from "@hobo/ci/execution";
import {
	type LocalPreparation,
	LocalPreparationSchema,
} from "./_generated/readiness_pb.js";
import { localConfig, localParams } from "./local-config.js";

export const CI_CF_ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOCAL_DOCKER_IGNORE = "*\n!source.tar.gz\n!Dockerfile\n";

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function fileDigest(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function sourceEnvironment(selectedEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (key.startsWith("GIT_")) delete env[key];
	return { ...env, ...selectedEnv };
}

export function sourceGit(
	args: string[],
	selectedEnv: NodeJS.ProcessEnv = {},
): string {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		env: sourceEnvironment(selectedEnv),
		maxBuffer: 32 * 1024 * 1024,
		timeout: 120000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(result.stderr || "Git source operation failed");
	return result.stdout.trimEnd();
}

/** Expand pinned, initialized Git submodules without modifying a source checkout. */
async function archiveSource(
	source: string,
	sha: string,
	directory: string,
): Promise<void> {
	const links: { path: string; sha: string }[] = [];
	const objectDirs = new Set<string>();
	function discover(repo: string, commit: string, prefix: string): void {
		objectDirs.add(
			resolve(
				repo,
				sourceGit(["-C", repo, "rev-parse", "--git-path", "objects"]),
			),
		);
		const records = sourceGit([
			"-C",
			repo,
			"ls-tree",
			"-rz",
			"--full-tree",
			commit,
		])
			.split("\0")
			.filter(Boolean);
		for (const record of records) {
			const match = /^160000 commit ([a-f0-9]{40,64})\t(.+)$/.exec(record);
			if (!match) continue;
			const path = parseRelativePath(`${prefix}${match[2]}`);
			const child = resolve(source, path);
			if (
				resolve(sourceGit(["-C", child, "rev-parse", "--show-toplevel"])) !==
				child
			)
				throw new Error(
					`submodule ${path} must be initialized at its pinned revision`,
				);
			const childSha = match[1];
			if (!childSha) throw new Error("invalid Git link");
			sourceGit(["-C", child, "cat-file", "-e", `${childSha}^{commit}`]);
			links.push({ path, sha: childSha });
			discover(child, childSha, `${path}/`);
		}
	}
	discover(source, sha, "");
	const gitDir = join(directory, "source-objects.git");
	sourceGit(["init", "--bare", "-q", gitDir]);
	const env = {
		GIT_ALTERNATE_OBJECT_DIRECTORIES: [...objectDirs]
			.map((path) => JSON.stringify(path))
			.join(delimiter),
	};
	const git = (...args: string[]) =>
		sourceGit(
			[`--git-dir=${gitDir}`, `--work-tree=${directory}`, ...args],
			env,
		);
	try {
		git("read-tree", sha);
		for (const link of links) {
			git("update-index", "--force-remove", "--", link.path);
			git("read-tree", `--prefix=${link.path}/`, `${link.sha}^{tree}`);
		}
		const tree = git("write-tree");
		// CI needs the committed tree, including files excluded from release archives.
		await writeFile(
			join(gitDir, "info/attributes"),
			"* -export-ignore -export-subst\n",
		);
		// A canonical private commit supplies a stable archive timestamp on all Git
		// versions. It never modifies the source repository or its original identity.
		const canonical = sourceGit(
			[
				`--git-dir=${gitDir}`,
				`--work-tree=${directory}`,
				"-c",
				"user.name=HoBo CI",
				"-c",
				"user.email=ci@hobo.localhost",
				"-c",
				"commit.gpgsign=false",
				"commit-tree",
				tree,
				"-m",
				"HoBo immutable source tree",
			],
			{
				...env,
				GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
				GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
			},
		);
		const lfs = spawnSync(
			"git",
			[
				`--git-dir=${gitDir}`,
				"grep",
				"-Il",
				"-e",
				"^version https://git-lfs.github.com/spec/v1$",
				tree,
			],
			{ encoding: "utf8", env: sourceEnvironment(env) },
		);
		if (lfs.status === 0)
			throw new Error(
				"Git LFS pointer files must be materialized into a committed source snapshot before local CI",
			);
		if (lfs.status !== 1) throw new Error("could not verify source content");
		git(
			"archive",
			"--format=tar.gz",
			"--prefix=source/",
			`--output=${join(directory, "source.tar.gz")}`,
			canonical,
		);
	} finally {
		await rm(gitDir, { recursive: true, force: true });
	}
}

export async function runtimeDigest(): Promise<string> {
	const paths = [
		"examples/local/index.ts",
		"src/backend.ts",
		"src/local-source.ts",
		"src/_generated/readiness_pb.ts",
		"package.json",
		"src/local-config.ts",
		"src/local-state.ts",
		"src/local-runtime.ts",
		"src/local-server.ts",
		"src/local-preparation.ts",
		"scripts/local.ts",
		"containers/proxy/Dockerfile",
		"containers/proxy/iptables-compat.sh",
		"containers/proxy/docker-local.sh",
	];
	const hashes = await Promise.all(
		paths.map(
			async (path) => `${path}:${await fileDigest(join(CI_CF_ROOT, path))}`,
		),
	);
	return sha256(hashes.join("\n"));
}

export async function atomicText(path: string, value: string): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(value);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
}

async function bundleDigest(directory: string): Promise<string> {
	const entries = await readdir(directory, { withFileTypes: true });
	const parts: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(directory, entry.name);
		if (entry.isDirectory())
			parts.push(`${entry.name}/:${await bundleDigest(path)}`);
		else if (entry.isFile())
			parts.push(`${entry.name}:${await fileDigest(path)}`);
		else throw new Error("invalid prepared Worker bundle member");
	}
	if (!parts.length) throw new Error("empty prepared Worker bundle");
	return sha256(parts.join("\n"));
}

async function freezeWorker(directory: string): Promise<void> {
	const config = join(directory, "bundle-config.jsonc");
	await writeFile(
		config,
		JSON.stringify({
			name: "hobo-ci-bundle",
			main: join(CI_CF_ROOT, "examples/local/index.ts"),
			compatibility_date: "2026-07-29",
			compatibility_flags: ["nodejs_compat"],
			send_metrics: false,
		}),
		{ mode: 0o600 },
	);
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(
				new URL("../bin/wrangler.js", import.meta.resolve("wrangler")),
			),
			"deploy",
			"--dry-run",
			"--outdir",
			join(directory, "worker"),
			"--config",
			config,
		],
		{
			cwd: directory,
			env: {
				...process.env,
				WRANGLER_SEND_METRICS: "false",
				WRANGLER_LOG_PATH: join(directory, "bundle.log"),
				XDG_CONFIG_HOME: join(directory, "config"),
			},
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
			timeout: 120000,
		},
	);
	await writeFile(
		join(directory, "bundle-output.log"),
		`${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		{ mode: 0o600 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`local Worker bundle failed; inspect ${join(directory, "bundle-output.log")}`,
		);
}

export async function prepareLocal(
	source: string,
	pipelinePath: string,
	ref: string,
	work: string,
	port = 8787,
	dockerfile?: string,
): Promise<string> {
	if ((await stat(pipelinePath)).size > 1024 * 1024)
		throw new Error("pipeline config exceeds one MiB");
	const pipeline = parsePipeline(await readFile(pipelinePath, "utf8"));
	const pipelineJson = toJsonString(PipelineSchema, pipeline);
	const sha = sourceGit([
		"-C",
		resolve(source),
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${ref}^{commit}`,
	]);
	await mkdir(work, { recursive: true });
	const directory = await mkdtemp(join(work, "local-"));
	try {
		const id = basename(directory);
		await archiveSource(resolve(source), sha, directory);
		const base = await readFile(
			dockerfile ?? join(CI_CF_ROOT, "examples/worker/Dockerfile"),
			"utf8",
		);
		await writeFile(
			join(directory, "Dockerfile"),
			`${base.trim()}\nCOPY source.tar.gz /opt/hobo-ci/source.tar.gz\n`,
			{ mode: 0o600 },
		);
		await writeFile(join(directory, ".dockerignore"), LOCAL_DOCKER_IGNORE, {
			mode: 0o600,
		});
		await freezeWorker(directory);
		const config = localConfig(pipeline, sha, id, port);
		const pipelineSha256 = sha256(pipelineJson);
		const configJson = JSON.stringify(
			{
				...config,
				main: join(directory, "worker/index.js"),
				no_bundle: true,
				vars: { ...config.vars, HOBO_PIPELINE_SHA256: pipelineSha256 },
			},
			null,
			2,
		);
		await writeFile(join(directory, "wrangler.jsonc"), `${configJson}\n`, {
			mode: 0o600,
		});
		const token = randomBytes(32).toString("hex");
		await writeFile(
			join(directory, ".dev.vars"),
			`HOBO_CI_ACCESS_TOKEN=${token}\n`,
			{ mode: 0o600 },
		);
		await writeFile(join(directory, "access-token"), token, { mode: 0o600 });
		await writeFile(
			join(directory, "params.json"),
			toJsonStringForParams(sha, id),
			{ mode: 0o600 },
		);
		const manifest = create(LocalPreparationSchema, {
			id,
			sourceSha: sha,
			pipelineJson,
			pipelineSha256,
			port,
			archiveSha256: await fileDigest(join(directory, "source.tar.gz")),
			dockerfileSha256: await fileDigest(join(directory, "Dockerfile")),
			configSha256: await fileDigest(join(directory, "wrangler.jsonc")),
			runtimeSha256: await runtimeDigest(),
			bundleSha256: await bundleDigest(join(directory, "worker")),
		});
		await atomicText(
			join(directory, "preparation.json"),
			toJsonString(LocalPreparationSchema, manifest),
		);
		await atomicText(join(work, "latest"), directory);
		return directory;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

function toJsonStringForParams(sha: string, id: string): string {
	return JSON.stringify(localParams(sha, id));
}

export async function readPreparation(
	directory: string,
): Promise<LocalPreparation> {
	const manifest = fromJsonString(
		LocalPreparationSchema,
		await readFile(join(directory, "preparation.json"), "utf8"),
	);
	if (
		!/^local-[A-Za-z0-9_-]+$/.test(manifest.id) ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceSha) ||
		manifest.port < 1 ||
		manifest.port > 65535
	)
		throw new Error("invalid local preparation");
	parsePipeline(manifest.pipelineJson);
	const checks = await Promise.all([
		fileDigest(join(directory, "source.tar.gz")),
		fileDigest(join(directory, "Dockerfile")),
		fileDigest(join(directory, "wrangler.jsonc")),
		runtimeDigest(),
		bundleDigest(join(directory, "worker")),
	]);
	if (
		checks[0] !== manifest.archiveSha256 ||
		checks[1] !== manifest.dockerfileSha256 ||
		checks[2] !== manifest.configSha256 ||
		checks[3] !== manifest.runtimeSha256 ||
		checks[4] !== manifest.bundleSha256 ||
		sha256(manifest.pipelineJson) !== manifest.pipelineSha256 ||
		(await readFile(join(directory, ".dockerignore"), "utf8")) !==
			LOCAL_DOCKER_IGNORE
	)
		throw new Error(
			"prepared inputs changed; run local:prepare again instead of mutating a resumable run",
		);
	return manifest;
}
