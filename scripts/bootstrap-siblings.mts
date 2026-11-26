#!/usr/bin/env node
/**
 * Obtain, check and move the pins in tools/pins/siblings.json.
 *
 *   node --experimental-strip-types scripts/bootstrap-siblings.mts [options]
 *
 *   (no verb)                     initialise every git pin (the submodule at its gitlink)
 *   --status [--offline|--online] report every pin; exit 1 when one has drifted
 *   --fetch [name...]             initialise git pins; download and verify asset pins
 *   --bump <name> <ref> [--repo URL] [--drop TARGET]... [--entry NAME] [--member PATH]
 *                                 move one pin: a git pin's gitlink (staged), or an
 *                                 asset pin to a release tag (siblings.json rewritten);
 *                                 a release of <name>_<tag>_<os>_<arch>.tar.gz archives
 *                                 is pinned by the archive, running its member PATH
 *                                 (default <name>)
 *
 *   --reference <dir>             borrow objects from a local clone (no download for what it has)
 *   --root <dir>                  the repository to act on (default: the one holding this script)
 *
 * Runs before `pnpm install`: erasable TypeScript, node builtins only, and
 * `git` on PATH. Exit 0 ok, 1 a check or an operation failed, 2 wrong usage.
 *
 * HOBO_PINS_NET_TIMEOUT_MS bounds every network wait (default 120000, at most
 * 600000); running out is NET_TIMEOUT, with nothing staged or kept.
 *
 * HOBO_PINS_ALLOW_LOCAL=1 additionally accepts loopback http URLs and local
 * repository paths in the manifest. The tests set it; nothing else should.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	isArchiveMember,
	isFileName,
	type Pins,
	PinsError,
	parsePins,
} from "./lib/pins.ts";
import { git } from "./lib/pins-git.ts";
import { netTimeoutMs } from "./lib/pins-net.ts";
import {
	PINS_FILE,
	type Request,
	runBump,
	runFetch,
	runInit,
	runStatus,
} from "./lib/pins-verbs.ts";

const USAGE = `usage: bootstrap-siblings.mts [--root DIR] [--reference DIR]
         [--status [--offline|--online] | --fetch [name...] | --bump NAME REF [--repo URL] [--drop TARGET]... [--entry NAME] [--member PATH]]
         [--force]`;

const OPTIONS = {
	root: { type: "string" },
	reference: { type: "string" },
	repo: { type: "string" },
	drop: { type: "string", multiple: true },
	entry: { type: "string" },
	member: { type: "string" },
	force: { type: "boolean" },
	status: { type: "boolean" },
	offline: { type: "boolean" },
	online: { type: "boolean" },
	fetch: { type: "boolean" },
	bump: { type: "boolean" },
} as const;

function usage(message: string): never {
	throw new PinsError("USAGE", `${message}\n${USAGE}`);
}

/** pnpm passes the `--` of `pnpm run pins:status -- --online` through; no pin name or ref starts with a dash. */
function withoutSeparator(args: readonly string[]): string[] {
	const at = args.indexOf("--");
	return at === -1 ? [...args] : [...args.slice(0, at), ...args.slice(at + 1)];
}

function readArgs(args: readonly string[]) {
	try {
		return parseArgs({
			args: withoutSeparator(args),
			allowPositionals: true,
			options: OPTIONS,
		});
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}
}

function parseRequest(args: readonly string[]): Request {
	const { values, positionals } = readArgs(args);
	const verbs = (["status", "fetch", "bump"] as const).filter(
		(verb) => values[verb] === true,
	);
	if (verbs.length > 1)
		usage(
			`${verbs.map((verb) => `--${verb}`).join(" and ")} cannot be combined`,
		);
	const verb = verbs[0] ?? "init";
	if (values.offline === true && values.online === true)
		usage("--offline and --online cannot be combined");
	if ((values.offline === true || values.online === true) && verb !== "status")
		usage("--offline and --online belong to --status");
	if (values.repo !== undefined && verb !== "bump")
		usage("--repo belongs to --bump");
	if (values.drop !== undefined && verb !== "bump")
		usage("--drop belongs to --bump");
	if (values.force === true && verb === "status")
		usage(
			"--force belongs to the verbs that move a submodule, not to --status",
		);
	if (values.entry !== undefined && verb !== "bump")
		usage("--entry belongs to --bump");
	if (values.entry !== undefined && !isFileName(values.entry))
		usage(`--entry ${values.entry} is not a plain file name`);
	if (values.member !== undefined && verb !== "bump")
		usage("--member belongs to --bump");
	if (values.member !== undefined && !isArchiveMember(values.member))
		usage(`--member ${values.member} is not a relative path of plain segments`);
	if (verb === "bump" && positionals.length !== 2)
		usage("--bump takes a pin name and a ref");
	if (verb !== "bump" && verb !== "fetch" && positionals.length > 0)
		usage(`unexpected argument ${positionals[0]}`);
	const reference =
		values.reference === undefined ? undefined : resolve(values.reference);
	if (
		reference !== undefined &&
		(!existsSync(reference) ||
			git(reference, ["rev-parse", "--git-dir"]).status !== 0)
	) {
		usage(`--reference ${reference} is not a git repository`);
	}
	netTimeoutMs(); // a bad HOBO_PINS_NET_TIMEOUT_MS is a usage error before anything runs
	const here = fileURLToPath(new URL("..", import.meta.url));
	return {
		verb,
		root: resolve(values.root ?? here),
		reference,
		online: values.online === true,
		repo: values.repo,
		drop: values.drop ?? [],
		entry: values.entry,
		member: values.member,
		force: values.force === true,
		names: positionals,
		allowLocal: process.env.HOBO_PINS_ALLOW_LOCAL === "1",
	};
}

function loadPins(request: Request): Pins {
	const file = join(request.root, PINS_FILE);
	if (!existsSync(file)) {
		throw new PinsError(
			"PINS_MALFORMED",
			`${PINS_FILE} not found under ${request.root}`,
		);
	}
	return parsePins(readFileSync(file, "utf8"), {
		allowLocal: request.allowLocal,
	});
}

async function main(args: readonly string[]): Promise<number> {
	const request = parseRequest(args);
	const pins = loadPins(request);
	switch (request.verb) {
		case "status":
			return await runStatus(request, pins);
		case "bump":
			return await runBump(request, pins);
		case "fetch":
			return await runFetch(request, pins);
		default:
			return await runInit(request, pins);
	}
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	if (error instanceof PinsError) {
		console.error(`ERR ${error.message}`);
		process.exitCode = error.code === "USAGE" ? 2 : 1;
	} else if (error instanceof Error && process.env.HOBO_PINS_DEBUG !== "1") {
		// A system error (a path that is the wrong kind, a timeout) is one line,
		// not a stack; HOBO_PINS_DEBUG=1 shows the stack.
		console.error(
			`ERR ${"code" in error ? String(error.code) : error.name}: ${error.message}`,
		);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
