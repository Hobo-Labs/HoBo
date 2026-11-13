/**
 * Service installers (L10, design §6.15). Signature frozen by the fleet
 * contract commit (ADR-0182).
 *
 * `argv` is the command line the service runs, program first (for example
 * `[process.execPath, <hobo entry>, "fleet", "run"]`). The definition is
 * written for the current user, replacing an earlier one, and the answer is
 * its path; enabling it (`systemctl --user enable --now hobo-fleet`,
 * `launchctl bootstrap gui/<uid> <path>`, `Register-ScheduledTask`) is left
 * to the caller, which can show the person what it runs first. The agent's
 * `HOBO_FLEET_*` variables set now are written into the systemd and launchd
 * definitions; a Windows task runs with the user's own environment.
 */
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

/** A drive-letter or UNC path; one starting with a single backslash is relative to the current drive. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/u;

/** The user's home as the environment states it (what os.homedir() reads first), else the account's. */
function userHome(): string {
	const stated =
		process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	return stated !== undefined && isAbsolute(stated) ? stated : homedir();
}

function refused(message: string): Outcome<string> {
	return { ok: false, error: { code: "invalid-request", message } };
}

/** C0 controls and DEL: a newline would end a unit line, a NUL would end the string. */
function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** Why `argv` cannot be a service's command line, or undefined when it can. */
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
		// Rule 11: a bootstrap token never goes on a command line.
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

/** Atomic replace, readable by the service manager (`0644`). */
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

/** Installs `hobo fleet run` as a systemd unit, launchd agent or Windows service. */
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
