import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { UsageError } from "../shell/errors.js";
import type { CommandModule } from "../shell/registry.js";
import { assertCatalogStarter, buildProjectFiles } from "../templates/index.js";
import {
	type ProjectName,
	parseProjectName,
	parseTemplateId,
	type ScaffoldResult,
} from "../types/scaffold.js";

export class DestinationExistsError extends UsageError {
	constructor(message: string) {
		super(message, [
			"Pick an empty directory name, or pass `--force` to scaffold into a non-empty directory.",
		]);
	}
}

export function createNewCommand(): CommandModule {
	return {
		run: async ({ context, flags, args }) => {
			const rawName = args[0];
			if (rawName === undefined) {
				throw new UsageError(
					"Invalid project name: provide a directory name for hobo new.",
					["Run `hobo new <name> [-t todo|api|agent|fullstack]`."],
				);
			}
			if (args.length > 1) {
				throw new UsageError(
					`Unexpected argument "${args[1]}". hobo new accepts exactly one project name.`,
					["Pass only the project directory name after `hobo new`."],
				);
			}

			const name = parseProjectName(rawName);
			const template = parseTemplateId(flags.template ?? "api");
			assertCatalogStarter(template);
			const result = await scaffoldHoboProject({
				cwd: context.cwd,
				name,
				template,
				force: flags.force,
			});

			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: `Created HoBo project ${name}`,
				data: {
					name,
					template: result.template,
					projectDir: result.projectDir,
					createdFiles: result.createdFiles,
					nextSteps: result.nextSteps,
					offline: result.offline,
				},
			};
		},
	};
}

export async function scaffoldHoboProject(input: {
	readonly cwd: string;
	readonly name: ProjectName;
	readonly template: ReturnType<typeof parseTemplateId>;
	readonly force?: boolean;
}): Promise<ScaffoldResult> {
	const projectDir = path.resolve(input.cwd, input.name);
	const existing = await existingDirectory(projectDir);

	if (existing.exists && !existing.isDirectory) {
		throw new DestinationExistsError(
			`${projectDir} already exists and is not a directory.`,
		);
	}

	if (existing.exists && existing.entries.length > 0 && !input.force) {
		throw new DestinationExistsError(
			`${projectDir} already exists and is not empty. Use --force to write HoBo scaffold files without deleting unrelated files.`,
		);
	}

	const files = buildProjectFiles({
		name: input.name,
		template: input.template,
	});
	if (files.size === 0) {
		throw new Error(`catalog starter ${input.template} rendered no files`);
	}
	for (const [relativePath, content] of files) {
		await writeOwnedFile(projectDir, relativePath, content);
	}

	return {
		projectDir,
		name: input.name,
		template: input.template,
		createdFiles: [...files.keys()],
		offline: true,
		nextSteps: [
			`cd ${input.name}`,
			"npm install",
			"npm run typecheck",
			"npm test",
			"hobo dev",
		],
	};
}

export function isNotFound(cause: unknown): boolean {
	const boxed: { readonly code?: unknown } = Object(cause);
	return boxed.code === "ENOENT";
}

async function existingDirectory(projectDir: string) {
	try {
		const info = await stat(projectDir);
		return {
			exists: true,
			isDirectory: info.isDirectory(),
			entries: info.isDirectory() ? await readdir(projectDir) : [],
		};
	} catch (error) {
		if (isNotFound(error)) {
			return { exists: false, isDirectory: false, entries: [] as string[] };
		}
		throw error;
	}
}

async function writeOwnedFile(
	root: string,
	relativePath: string,
	content: string,
) {
	await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });

	if (relativePath === ".gitignore") {
		await mergeGitignore(path.join(root, relativePath), content);
		return;
	}

	await writeFile(path.join(root, relativePath), content);
}

async function mergeGitignore(filePath: string, requiredContent: string) {
	const requiredLines = requiredContent.trimEnd().split("\n");
	let current = "";
	try {
		current = await readFile(filePath, "utf8");
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}

	const currentLines =
		current.trimEnd() === "" ? [] : current.trimEnd().split(/\r?\n/);
	const mergedLines = [...currentLines];
	for (const line of requiredLines) {
		if (!mergedLines.includes(line)) {
			mergedLines.push(line);
		}
	}

	await writeFile(filePath, `${mergedLines.join("\n")}\n`);
}
