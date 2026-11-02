import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { CiProjectConfig } from "./project-config.js";
import { selectCiEnvironment } from "./project-config.js";
import {
	CI_PROJECT_LOCAL_OVERRIDE_PATH,
	DEFAULT_CI_PROJECT_PATH,
	loadCiProjectConfigDocument,
	resolveExplicitCiEnvironmentName,
} from "./relay-routing.js";

const maxBytes = 256 * 1024;

async function readBounded(path: string): Promise<string | undefined> {
	try {
		await access(path, constants.R_OK);
		const text = await readFile(path, "utf8");
		if (new TextEncoder().encode(text).byteLength > maxBytes)
			throw new Error("project configuration too large");
		return text;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
}

export interface LoadedCiProject {
	readonly configPath: string;
	readonly config: CiProjectConfig;
	readonly environmentName: string;
	readonly environment: ReturnType<typeof selectCiEnvironment>;
}

/** Load `.hobo/ci.json` plus optional gitignored `.hobo/ci.local.json` from a repo root. */
export async function loadCiProjectFromDirectory(options: {
	repositoryRoot: string;
	configPath?: string;
	environment?: string;
	env?: NodeJS.ProcessEnv;
	organization?: CiProjectConfig;
}): Promise<LoadedCiProject> {
	const configPath =
		options.configPath ??
		options.env?.HOBO_CI_PROJECT_CONFIG?.trim() ??
		DEFAULT_CI_PROJECT_PATH;
	const absoluteConfig = resolve(options.repositoryRoot, configPath);
	const committed = await readBounded(absoluteConfig);
	if (!committed) throw new Error("missing CI project configuration");
	const localPath = resolve(
		options.repositoryRoot,
		CI_PROJECT_LOCAL_OVERRIDE_PATH,
	);
	const local = await readBounded(localPath);
	const config = loadCiProjectConfigDocument(
		committed,
		local,
		options.organization,
	);
	const environmentName = resolveExplicitCiEnvironmentName(
		config,
		options.environment,
		options.env,
	);
	return Object.freeze({
		configPath: absoluteConfig,
		config,
		environmentName,
		environment: selectCiEnvironment(config, environmentName),
	});
}
