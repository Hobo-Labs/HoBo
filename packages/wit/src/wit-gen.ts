import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const WIT_ROOT = join(PACKAGE_ROOT, "wit");
export const GENERATED_ROOT = join(PACKAGE_ROOT, "src", "generated");
const JCO_PATH = join(
	PACKAGE_ROOT,
	"node_modules",
	"@bytecodealliance",
	"jco",
	"src",
	"jco.js",
);

const HOBO_DEP_DIRS = [
	"hobo-runtime",
	"hobo-queue",
	"hobo-scheduler",
	"hobo-blob-events",
	"hobo-evidence",
] as const;

export const GENERATION_TARGETS = [
	{ witPath: "wit", worldName: "sdk", outSubdir: "sdk", stagedHoboOnly: true },
	{
		witPath: "wit/deps/hobo-runtime/hobo-runtime.wit",
		worldName: "runtime-primitives",
		outSubdir: "runtime-primitives",
	},
	{
		witPath: "wit/deps/hobo-queue/hobo-queue.wit",
		worldName: "queue-guest",
		outSubdir: "queue-guest",
	},
	{
		witPath: "wit/deps/hobo-queue/hobo-queue.wit",
		worldName: "queue-provider",
		outSubdir: "queue-provider",
	},
	{
		witPath: "wit/deps/hobo-scheduler/hobo-scheduler.wit",
		worldName: "scheduler-guest",
		outSubdir: "scheduler-guest",
	},
	{
		witPath: "wit/deps/hobo-scheduler/hobo-scheduler.wit",
		worldName: "scheduler-provider",
		outSubdir: "scheduler-provider",
	},
	{
		witPath: "wit/deps/hobo-blob-events/hobo-blob-events.wit",
		worldName: "blob-events-guest",
		outSubdir: "blob-events-guest",
	},
	{
		witPath: "wit/deps/hobo-blob-events/hobo-blob-events.wit",
		worldName: "blob-events-provider",
		outSubdir: "blob-events-provider",
	},
	{
		witPath: "wit/deps/hobo-evidence/hobo-evidence.wit",
		worldName: "evidence-guest",
		outSubdir: "evidence-guest",
	},
	{
		witPath: "wit/deps/hobo-evidence/hobo-evidence.wit",
		worldName: "evidence-provider",
		outSubdir: "evidence-provider",
	},
	{
		witPath: "wit/deps/hobo-training-engine/hobo-training-engine.wit",
		worldName: "training-engine-provider",
		outSubdir: "training-engine-provider",
	},
	{
		witPath: "wit/deps/hobo-secrets/hobo-secrets.wit",
		worldName: "secrets-provider",
		outSubdir: "secrets-provider",
	},
	{
		witPath: "wit/deps/hobo-secrets/hobo-secrets.wit",
		worldName: "secrets-guest",
		outSubdir: "secrets-guest",
	},
] as const;

export function digestSource(source: string | Buffer): string {
	const bytes =
		typeof source === "string"
			? Buffer.from(source.replace(/\r\n/g, "\n"), "utf8")
			: source;
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function stageHoboSdkWitRoot(): Promise<string> {
	const stagedRoot = await mkdtemp(join(tmpdir(), "hobo-wit-sdk-"));
	const stagedDeps = join(stagedRoot, "deps");
	await cp(join(WIT_ROOT, "hobo-sdk.wit"), join(stagedRoot, "hobo-sdk.wit"));
	for (const depDir of HOBO_DEP_DIRS) {
		await cp(join(WIT_ROOT, "deps", depDir), join(stagedDeps, depDir), {
			recursive: true,
		});
	}
	return stagedRoot;
}

export async function writeGeneratedBindings(
	options: { outDir?: string } = {},
): Promise<string[]> {
	const outDir = options.outDir ?? GENERATED_ROOT;
	await rm(outDir, { recursive: true, force: true });

	const allFiles: string[] = [];
	let stagedRoot: string | undefined;

	try {
		for (const target of GENERATION_TARGETS) {
			const targetOut = join(outDir, target.outSubdir);
			let witInput: string;
			if ("stagedHoboOnly" in target && target.stagedHoboOnly) {
				stagedRoot ??= await stageHoboSdkWitRoot();
				witInput = stagedRoot;
			} else {
				witInput = join(PACKAGE_ROOT, target.witPath);
			}

			await execFileAsync(
				process.execPath,
				[
					JCO_PATH,
					"types",
					witInput,
					"--world-name",
					target.worldName,
					"--out-dir",
					targetOut,
				],
				{ cwd: PACKAGE_ROOT },
			);
			await normalizeGeneratedTree(targetOut);
			for (const fileName of await listDeclarationFiles(targetOut)) {
				allFiles.push(
					relative(outDir, join(targetOut, fileName)).replace(/\\/g, "/"),
				);
			}
		}
	} finally {
		if (stagedRoot) {
			await rm(stagedRoot, { recursive: true, force: true });
		}
	}

	return allFiles.sort();
}

export async function assertGeneratedMatches(
	options: { generatedRoot?: string } = {},
): Promise<{ checked: number }> {
	const generatedRoot = options.generatedRoot ?? GENERATED_ROOT;
	const tempDir = await mkdtemp(join(tmpdir(), "hobo-wit-jco-"));

	try {
		const expectedFileNames = await writeGeneratedBindings({ outDir: tempDir });
		const actualFileNames = await listDeclarationFiles(
			generatedRoot,
			generatedRoot,
		);

		if (actualFileNames.join("\n") !== expectedFileNames.join("\n")) {
			throw new Error(
				`wit_toolchain.generated_file_drift: expected ${expectedFileNames.join(",")}, got ${actualFileNames.join(",")}`,
			);
		}

		for (const fileName of expectedFileNames) {
			const expected = await readFile(join(tempDir, fileName), "utf8");
			const actual = await readFile(join(generatedRoot, fileName), "utf8");
			if (actual !== expected) {
				throw new Error(`wit_toolchain.generated_content_drift: ${fileName}`);
			}
		}

		return { checked: expectedFileNames.length };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function listDeclarationFiles(
	root: string,
	relativeRoot = root,
): Promise<string[]> {
	const files: string[] = [];

	async function visit(directory: string) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (entry.name.endsWith(".d.ts")) {
				files.push(relative(relativeRoot, path).replace(/\\/g, "/"));
			}
		}
	}

	await visit(root);
	return files.sort();
}

async function normalizeGeneratedTree(root: string) {
	for (const fileName of await listDeclarationFiles(root)) {
		const path = join(root, fileName);
		const text = await readFile(path, "utf8");
		const normalized = text
			.replace(/\r\n/g, "\n")
			.replace(/[ \t]+$/gm, "")
			.replace(/\s+$/u, "");
		const moduleText = /\b(export|import)\b/.test(normalized)
			? normalized
			: `${normalized}\nexport {};`;
		await writeFile(path, `${moduleText}\n`);
	}
}
