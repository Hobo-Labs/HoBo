/**
 * Which `opensesame` a run starts, settled before the store passphrase goes
 * anywhere near it. The executable is handed OPENSESAME_STORE_PASSWORD, so a
 * program that is not OpenSesame and answers to the name is handed the key to
 * the store. What stands between a bare name and that:
 *
 * - The name is looked up on the absolute entries of PATH only. An empty entry,
 *   `.` or any relative entry means "the working directory", where a checked-out
 *   repository or a download puts a planted `opensesame`; they are not searched.
 *   The first executable file found is the one, as a shell finds it.
 * - That file must be in a trusted place (`trust.ts`): it, where its links end,
 *   and every directory above both belong to the user or root and only they can
 *   write; and none is under `node_modules/.bin` or inside the working
 *   directory's tree. A file that fails is refused (`opensesame_bin_untrusted`),
 *   not skipped for a later one, because a program anyone can rewrite is not the
 *   one the person installed.
 * - A path with a separator is the caller's explicit choice: used as given, not
 *   held to that rule.
 * - Either way the name is resolved through every symlink once, and that resolved
 *   path is what is probed and what `runProxied` starts, so nothing is looked up
 *   twice.
 * - The program is then asked `--version` with a PATH reduced the same way as the
 *   run's, and nothing else in its environment, and must answer
 *   `opensesame X.Y.Z`. That stops running the wrong program by accident or by a
 *   stray earlier entry on PATH. It is a shape check, not authentication: a
 *   program that prints that line from a trusted place passes.
 *
 * What the program says is never repeated in an error: it is not trusted text.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import { OpenSesameAdapterError } from "./errors.js";
import {
	absolutePathEntries,
	nodeTrust,
	placeProblem,
	type Trust,
	trustedPath,
} from "./trust.js";

/** What `--version` returned: how it ended and what it wrote to stdout. */
export type BinProbe = (
	bin: string,
	env: NodeJS.ProcessEnv,
) => Readonly<{ status: number | null; stdout: string }>;

export type TrustInput = Readonly<{
	/** A bare name (looked up on PATH) or a path (used as given). */
	bin: string;
	/** The caller's environment; only its PATH is read. */
	env: NodeJS.ProcessEnv;
	/** Runs `bin --version`. Defaults to doing so. */
	probe?: BinProbe | undefined;
	/** The rule's view of the file system and the user. Defaults to this process's. */
	trust?: Trust | undefined;
	/** Defaults to this process's. */
	platform?: NodeJS.Platform | undefined;
}>;

const IDENTITY = /^opensesame \d+\.\d+\.\d+/u;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_LIMIT = 4096;

const nodeProbe: BinProbe = (bin, env) => {
	const result = spawnSync(bin, ["--version"], {
		env,
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
		maxBuffer: PROBE_OUTPUT_LIMIT,
		stdio: ["ignore", "pipe", "ignore"],
	});
	return { status: result.status, stdout: result.stdout ?? "" };
};

/** Whether `candidate` is a regular file this process can execute. */
function isExecutableFile(candidate: string): boolean {
	try {
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function missing(name: string): OpenSesameAdapterError {
	return new OpenSesameAdapterError(
		"opensesame_bin_missing",
		`no executable file named ${name} on an absolute entry of PATH (empty and relative entries are not searched); give the path to opensesame as bin`,
	);
}

function untrusted(why: string): OpenSesameAdapterError {
	return new OpenSesameAdapterError(
		"opensesame_bin_untrusted",
		`${why}, so it is not started with the store passphrase; fix that, or give the path to opensesame as bin`,
	);
}

/** The resolved path of the program `bin` names, found and, when searched for, trusted. */
function locate(bin: string, entries: readonly string[], trust: Trust): string {
	if (bin.includes(path.sep) || bin.includes("/")) {
		const real = trust.fs.realpath(path.resolve(bin));
		if (real === undefined || !isExecutableFile(real)) throw missing(bin);
		return real;
	}
	for (const entry of entries) {
		const candidate = path.join(entry, bin);
		if (!isExecutableFile(candidate)) continue;
		const why = placeProblem(entry, trust) ?? placeProblem(candidate, trust);
		if (why !== undefined) throw untrusted(why);
		const real = trust.fs.realpath(candidate);
		if (real === undefined) throw missing(bin);
		return real;
	}
	throw missing(bin);
}

/** The `opensesame` to start: found, checked and identified, or a typed refusal. Returns its resolved path. */
export function trustedOpenSesame(input: TrustInput): string {
	const trust = input.trust ?? nodeTrust();
	const platform = input.platform ?? process.platform;
	const resolved = locate(
		input.bin,
		absolutePathEntries(input.env.PATH, platform),
		trust,
	);
	const answer = (input.probe ?? nodeProbe)(resolved, {
		PATH: trustedPath(input.env.PATH, trust, platform, input.env),
	});
	if (answer.status !== 0 || !IDENTITY.test(answer.stdout)) {
		throw new OpenSesameAdapterError(
			"opensesame_bin_untrusted",
			`${resolved} did not answer --version as opensesame X.Y.Z, so it is not started with the store passphrase`,
		);
	}
	return resolved;
}
