import { access } from "node:fs/promises";
import path from "node:path";

import type { CliContext } from "../types/envelope.js";
import { NoBindleError } from "./errors.js";
import type { CliFlags } from "./parse.js";

const markers = [
	"hobo.bindle.json",
	"bindle.ts",
	"bindle.js",

	"src/bindle.ts",
	"src/bindle.mts",
	"src/bindle.js",
	"src/bindle.mjs",
	"dist/bindle.js",

	"app.ts",
	"app.mts",
	"app.js",
	"app.mjs",
	".hobo",
] as const;

export interface ContextFactoryRequest {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly flags: CliFlags;
	readonly verb: string;
	readonly args: readonly string[];
	readonly requiresProject: boolean;
}

export type ContextFactory = (
	request: ContextFactoryRequest,
) => Promise<CliContext>;

export async function defaultContextFactory(
	request: ContextFactoryRequest,
): Promise<CliContext> {
	const projectDir = await findProjectDir(
		request.cwd,
		["codegen", "stub", "build"].includes(request.verb),
	);
	if (request.requiresProject && !projectDir) {
		throw new NoBindleError(request.cwd, {
			monorepo: await looksLikeHoboMonorepo(request.cwd),
		});
	}

	return {
		cwd: request.cwd,
		projectDir,
		identity: null,
		clients: {
			readApi: "stub",
			runtime: "stub",
		},
	};
}

async function findProjectDir(
	startDir: string,
	typescriptAuthoring = false,
): Promise<string | null> {
	let current = path.resolve(startDir);
	while (true) {
		for (const marker of markers) {
			if (await exists(path.join(current, marker))) {
				return current;
			}
		}
		if (
			typescriptAuthoring &&
			(await exists(path.join(current, "tsconfig.json")))
		)
			return current;

		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

async function looksLikeHoboMonorepo(startDir: string): Promise<boolean> {
	const root = path.resolve(startDir);
	return (
		(await exists(path.join(root, "pnpm-workspace.yaml"))) &&
		(await exists(path.join(root, "examples", "hello-bindle")))
	);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}
