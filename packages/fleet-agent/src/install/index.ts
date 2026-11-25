import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Outcome } from "@hobo/fleet";
import {
	LAUNCHD_LABEL,
	renderLaunchdPlist,
	renderSystemdUnit,
	renderWindowsTask,
	SERVICE_NAME,
	serviceEnvironment,
} from "./render.js";

type Definition = Readonly<{ path: string; text: string }>;

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/u;

function userHome(): string {
	const stated =
		process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	return stated !== undefined && isAbsolute(stated) ? stated : homedir();
}

function refused(message: string): Outcome<string> {
	return { ok: false, error: { code: "invalid-request", message } };
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function argvProblem(
	platform: NodeJS.Platform,
	argv: readonly string[],
): string | undefined {
	const [program] = argv;
	if (program === undefined) return "the service needs a command to run";
	const absolute =
		platform === "win32" ? WINDOWS_ABSOLUTE.test(program) : isAbsolute(program);
	if (!absolute)
		return "the service's program must be an absolute path, so that it does not depend on PATH";
	for (const [index, arg] of argv.entries()) {
		if (hasControlCharacter(arg))
			return `argument ${index} holds a control character`;
		if (arg.includes("hft_"))
			return `argument ${index} looks like a bootstrap token; pass it with --token-file or on standard input`;
	}
	return undefined;
}

function definitionFor(
	platform: NodeJS.Platform,
	argv: readonly string[],
): Definition | undefined {
	const home = userHome();
	const environment = serviceEnvironment(process.env);
	if (platform === "linux") {
		const configured = process.env.XDG_CONFIG_HOME;
		const config =
			configured !== undefined && isAbsolute(configured)
				? configured
				: join(home, ".config");
		return {
			path: join(config, "systemd", "user", `${SERVICE_NAME}.service`),
			text: renderSystemdUnit(argv, environment),
		};
	}
	if (platform === "darwin")
		return {
			path: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
			text: renderLaunchdPlist(argv, environment),
		};
	if (platform === "win32")
		return {
			path: join(home, "AppData", "Local", "hobo", `${SERVICE_NAME}.xml`),
			text: renderWindowsTask(argv),
		};
	return undefined;
}

async function writeDefinition(definition: Definition): Promise<void> {
	await mkdir(dirname(definition.path), { recursive: true });
	const temporary = `${definition.path}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await open(temporary, "wx", 0o644);
	try {
		await handle.writeFile(definition.text, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if (process.platform !== "win32") await chmod(temporary, 0o644);
		await rename(temporary, definition.path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function installService(
	platform: NodeJS.Platform,
	argv: readonly string[],
): Promise<Outcome<string>> {
	const problem = argvProblem(platform, argv);
	if (problem !== undefined) return refused(problem);
	const definition = definitionFor(platform, argv);
	if (definition === undefined)
		return refused(
			`no service manager is supported on ${platform}; run \`hobo fleet run\` under your own supervisor`,
		);
	try {
		await writeDefinition(definition);
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "unavailable",
				message: `could not write ${definition.path}: ${error instanceof Error ? error.message : "unknown error"}`,
			},
		};
	}
	return { ok: true, value: definition.path };
}
