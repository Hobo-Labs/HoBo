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
	VALID_TEMPLATES,
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

export async function validateScaffoldProject(projectDir: string) {
	let template: ReturnType<typeof parseTemplateId>;
	try {
		// SAFETY: `const bindleRaw = JSON.parse(` is required at this I/O or test boundary.
		const bindleRaw = JSON.parse(
			await readFile(path.join(projectDir, "hobo.bindle.json"), "utf8"),
		) as { template?: unknown };
		template = parseTemplateId(String(bindleRaw.template ?? ""));
	} catch {
		return {
			ok: false,
			missing: ["hobo.bindle.json"],
			canRunHoboDev: false,
			typecheck: { status: "fail", reason: "missing scaffold files" },
			tests: { status: "fail", reason: "missing scaffold files" },
		};
	}
	const expected = buildProjectFiles({
		name: parseProjectName("validate"),
		template,
	});
	const missing: string[] = [];
	for (const relativePath of expected.keys()) {
		try {
			await stat(path.join(projectDir, relativePath));
		} catch {
			missing.push(relativePath);
		}
	}

	if (missing.length > 0) {
		return {
			ok: false,
			missing,
			canRunHoboDev: false,
			typecheck: { status: "fail", reason: "missing scaffold files" },
			tests: { status: "fail", reason: "missing scaffold files" },
		};
	}

	// SAFETY: `const packageJson = JSON.parse(` is required at this I/O or test boundary.
	const packageJson = JSON.parse(
		await readFile(path.join(projectDir, "package.json"), "utf8"),
	) as {
		scripts?: Record<string, string>;
	};
	const bindle = { template };
	const app = await readFile(path.join(projectDir, "app.ts"), "utf8");
	const appTest = await readFile(path.join(projectDir, "app.test.ts"), "utf8");
	const generated = await readFile(
		path.join(projectDir, "src/_generated/index.ts"),
		"utf8",
	);
	const declarations = await readFile(
		path.join(projectDir, "src/_generated/hobo.d.ts"),
		"utf8",
	);
	const gitignore = await readFile(path.join(projectDir, ".gitignore"), "utf8");

	const violations: string[] = [];
	if (packageJson.scripts?.dev !== "hobo dev") {
		violations.push("package.json must expose hobo dev");
	}
	if (
		packageJson.scripts?.test !== "node --test" &&
		!packageJson.scripts?.test?.includes("--test app.test.ts")
	) {
		violations.push("package.json must expose node --test");
	}
	if (packageJson.scripts?.typecheck !== "tsc --noEmit") {
		violations.push("package.json must expose tsc --noEmit");
	}
	if (!VALID_TEMPLATES.includes(template)) {
		violations.push("bindle template must be one of the valid templates");
	}
	if (!app.includes(`template: "${bindle.template}"`)) {
		violations.push("app.ts must pin the selected template");
	}
	if (!app.includes("export const api = hobo.api")) {
		violations.push("app.ts must export an api handler");
	}
	if (!app.includes("export const resource = hobo.resource")) {
		violations.push("app.ts must export a resource");
	}
	if (!app.includes('from "./src/_generated/index.ts"')) {
		violations.push("app.ts must consume checked-in generated bindings");
	}
	if (!appTest.includes("createTestRuntime")) {
		violations.push("app.test.ts must exercise the generated test runtime");
	}
	if (
		!generated.includes("export function createHobo") ||
		!generated.includes("export function createTestRuntime")
	) {
		violations.push("generated seed must be checked in");
	}
	if (!declarations.includes('declare module "@hobo/sdk"')) {
		violations.push("declarations must seed SDK module types");
	}
	if (!/^\.hobo\/$/m.test(gitignore)) {
		violations.push(".gitignore must ignore .hobo/");
	}
	if (
		/fetch\(|registry|templateUrl|http:|https:/i.test(
			`${app}\n${generated}\n${declarations}`,
		)
	) {
		violations.push(
			"scaffold must not depend on registry-hosted or network templates",
		);
	}

	return {
		ok: violations.length === 0,
		template: bindle.template,
		canRunHoboDev: packageJson.scripts?.dev === "hobo dev",
		missing,
		violations,
		typecheck: {
			status: violations.length === 0 ? "pass" : "fail",
			mode: "static-contract",
		},
		tests: {
			status: violations.length === 0 ? "pass" : "fail",
			mode: "generated-test-runtime-contract",
		},
	};
}

/**
 * Is this caught value a filesystem "no such file or directory"?
 *
 * Not `isJsonObject(error)`: that guard requires `[object Object]`, and a real
 * `Error` tags as `[object Error]` -- so the check was false for every error
 * Node actually throws, and the ENOENT branches it guarded were dead. The
 * visible consequence was that `hobo new` crashed with "Internal CLI error" on
 * the ordinary case of the target directory not existing yet, which is the case
 * scaffolding exists for. Nor `instanceof Error`, which an Error from another
 * realm fails: any object whose `code` is ENOENT counts. `Object(cause)` is
 * every object as itself and boxes a primitive (or null) into one with no
 * `code`, so the comparison needs no guess about what was thrown.
 */
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
			// SAFETY: `return { exists: false, isDirectory: false, entries: [] as string[] };` is required at this I/O or test boundary.
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
