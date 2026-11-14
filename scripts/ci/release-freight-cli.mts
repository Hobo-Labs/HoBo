#!/usr/bin/env node
/**
 * The hobo CLI every release job runs `hobo deploy` with, built once per run.
 *
 * `release-hobo-cli` (release-hobo.yml) builds `@hobo/hobo...` and packs the
 * `dist/` of every package in that build closure, as turbo's own dry run names
 * it, into one archive with a manifest of the commit it was built from. Its
 * sha256 is the job's `digest` output. Each release job downloads the archive
 * and restores it here, which refuses (fail closed) unless:
 *
 * - the archive's sha256 is the digest the build job published;
 * - the manifest's revision is the commit this job checked out (`git rev-parse
 *   HEAD`), so a CLI built from another tree never releases this one;
 * - every entry lies inside a planned package's `dist/`.
 *
 * Usage:
 *   release-freight-cli.mts pack <out.tgz> [--github-output <path>]
 *   release-freight-cli.mts restore <bundle.tgz> --digest sha256:<hex>
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = join(import.meta.dirname, "..", "..");
const MANIFEST = "hobo-release-cli.json";
const TOP_PACKAGE = "@hobo/hobo";

/** Where a package of the closure may live: a workspace or vendored package. */
const directorySchema = z
	.string()
	.regex(/^(?:packages|external)\/[A-Za-z0-9._/-]+$/u)
	.refine(
		(directory) =>
			posix.normalize(directory) === directory &&
			!directory.split("/").includes(".."),
	);

/** One package of the `@hobo/hobo...` build closure. */
const entrySchema = z.object({
	package: z.string().min(1),
	directory: directorySchema,
});
export type CliBundleEntry = Readonly<z.infer<typeof entrySchema>>;

/** The part of `turbo run build --dry=json` the plan reads. */
const dryRunSchema = z.object({
	tasks: z
		.array(
			z.object({
				package: z.string().min(1),
				directory: z.string(),
				outputs: z.array(z.string()),
			}),
		)
		.min(1),
});

const manifestSchema = z.object({
	schema: z.literal("hobo.release-cli-bundle/v1"),
	revision: z.string().regex(/^[0-9a-f]{40}$/u),
	packages: z.array(entrySchema).min(1),
});
type Manifest = Readonly<z.infer<typeof manifestSchema>>;

/** What packing produced: the archive's sha256, the build job's `digest`. */
export type PackedCliBundle = Readonly<{ digest: string }>;

function closure(entries: readonly CliBundleEntry[]): CliBundleEntry[] {
	if (!entries.some((entry) => entry.package === TOP_PACKAGE))
		throw new Error(`the build closure does not include ${TOP_PACKAGE}`);
	return [...entries].sort((a, b) => a.directory.localeCompare(b.directory));
}

/** The closure from `turbo run build --filter=@hobo/hobo... --dry=json`. */
export function cliBundlePlan(dryRunJson: string): CliBundleEntry[] {
	const dryRun = dryRunSchema.safeParse(JSON.parse(dryRunJson));
	if (!dryRun.success) throw new Error("turbo dry run lists no build tasks");
	return closure(
		dryRun.data.tasks.map((task) => {
			if (task.outputs.length !== 1 || task.outputs[0] !== "dist/**")
				throw new Error(
					`${task.package} builds ${JSON.stringify(task.outputs)}, not dist/**: the CLI bundle would ship part of its build`,
				);
			const entry = entrySchema.safeParse(task);
			if (!entry.success)
				throw new Error(
					`${task.package} lives at ${JSON.stringify(task.directory)}, not under packages/ or external/`,
				);
			return entry.data;
		}),
	);
}

function run(command: string, args: readonly string[], cwd: string): string {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`,
		);
	return result.stdout ?? "";
}

function sha256File(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Pack every planned `dist/` with a manifest naming the commit it was built from. */
export function packCliBundle(options: {
	root: string;
	plan: readonly CliBundleEntry[];
	revision: string;
	out: string;
}): PackedCliBundle {
	if (!/^[0-9a-f]{40}$/u.test(options.revision))
		throw new Error(
			`revision must be a 40-hex commit, got ${options.revision}`,
		);
	for (const entry of options.plan) {
		const dist = join(options.root, entry.directory, "dist");
		if (!existsSync(dist) || !statSync(dist).isDirectory())
			throw new Error(
				`${entry.package} was not built: ${entry.directory}/dist is missing`,
			);
	}
	const staging = mkdtempSync(join(tmpdir(), "hobo-release-cli-"));
	try {
		const manifest: Manifest = {
			schema: "hobo.release-cli-bundle/v1",
			revision: options.revision,
			packages: [...options.plan],
		};
		writeFileSync(join(staging, MANIFEST), `${JSON.stringify(manifest)}\n`);
		run(
			"tar",
			[
				"--sort=name",
				"--owner=0",
				"--group=0",
				"--numeric-owner",
				"-czf",
				options.out,
				"-C",
				staging,
				MANIFEST,
				"-C",
				options.root,
				...options.plan.map((entry) => `${entry.directory}/dist`),
			],
			options.root,
		);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	return { digest: sha256File(options.out) };
}

function readManifest(text: string): Manifest {
	const manifest = manifestSchema.safeParse(JSON.parse(text));
	if (!manifest.success)
		throw new Error(
			`the CLI bundle's ${MANIFEST} is not hobo.release-cli-bundle/v1`,
		);
	return { ...manifest.data, packages: closure(manifest.data.packages) };
}

/**
 * Restore a packed CLI into this checkout. Throws unless the archive is the
 * one the build job published (digest), built from this commit (revision),
 * and writes only inside the planned packages' `dist/`.
 */
export function restoreCliBundle(options: {
	root: string;
	bundle: string;
	digest: string;
	revision: string;
}): Manifest {
	if (!/^sha256:[0-9a-f]{64}$/u.test(options.digest))
		throw new Error(
			`the build job's digest must be sha256:<64 hex>, got ${JSON.stringify(options.digest)}`,
		);
	if (!existsSync(options.bundle))
		throw new Error(`the CLI bundle ${options.bundle} was not downloaded`);
	const actual = sha256File(options.bundle);
	if (actual !== options.digest)
		throw new Error(
			`the CLI bundle's digest ${actual} is not the build job's ${options.digest}`,
		);
	const manifest = readManifest(
		run("tar", ["-xzOf", options.bundle, MANIFEST], options.root),
	);
	if (manifest.revision !== options.revision)
		throw new Error(
			`the CLI bundle was built from revision ${manifest.revision}, not this checkout's ${options.revision}`,
		);
	const allowed = manifest.packages.map((entry) => `${entry.directory}/dist`);
	const entries = run("tar", ["-tzf", options.bundle], options.root)
		.split("\n")
		.map((line) => line.trim().replace(/^\.\//u, ""))
		.filter((line) => line !== "" && line !== ".");
	// Only files and directories: a link could point a later entry anywhere.
	const kinds = run("tar", ["-tvzf", options.bundle], options.root)
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => line[0]);
	if (kinds.some((kind) => kind !== "-" && kind !== "d"))
		throw new Error(
			"the CLI bundle holds a link or device; only files are restored",
		);
	for (const entry of entries) {
		if (entry === MANIFEST) continue;
		const path = entry.replace(/\/$/u, "");
		const inside =
			!path.split("/").includes("..") &&
			allowed.some((dist) => path === dist || path.startsWith(`${dist}/`));
		if (!inside)
			throw new Error(
				`the CLI bundle writes ${entry}, outside every planned package's dist/`,
			);
	}
	for (const dist of allowed)
		rmSync(join(options.root, dist), { recursive: true, force: true });
	run(
		"tar",
		["-xzf", options.bundle, "--no-same-owner", "-C", options.root, ...allowed],
		options.root,
	);
	for (const dist of allowed)
		if (!existsSync(join(options.root, dist)))
			throw new Error(`the CLI bundle did not restore ${dist}`);
	return manifest;
}

function headRevision(): string {
	return run("git", ["rev-parse", "HEAD"], root).trim();
}

function main(argv: readonly string[]): void {
	const [command, path, ...rest] = argv;
	const flag = (name: string) => {
		const at = rest.indexOf(name);
		return at === -1 ? undefined : rest[at + 1];
	};
	if (command === "pack" && path) {
		const plan = cliBundlePlan(
			run(
				"pnpm",
				[
					"exec",
					"turbo",
					"run",
					"build",
					`--filter=${TOP_PACKAGE}...`,
					"--dry=json",
				],
				root,
			),
		);
		const revision = headRevision();
		const { digest } = packCliBundle({ root, plan, revision, out: path });
		console.log(
			`hobo CLI bundle: ${plan.length} packages at ${revision}, ${digest}`,
		);
		const output = flag("--github-output");
		if (output)
			appendFileSync(output, `digest=${digest}\nrevision=${revision}\n`);
		return;
	}
	if (command === "restore" && path) {
		const manifest = restoreCliBundle({
			root,
			bundle: path,
			digest: flag("--digest") ?? "",
			revision: headRevision(),
		});
		console.log(
			`hobo CLI restored: ${manifest.packages.length} packages built at ${manifest.revision}`,
		);
		return;
	}
	throw new Error(
		"usage: release-freight-cli.mts pack <out.tgz> [--github-output <path>] | restore <bundle.tgz> --digest sha256:<hex>",
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
