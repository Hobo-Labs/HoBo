import path from "node:path";

import { UsageError } from "./errors.js";
import { verbNames } from "./verbs.js";

export interface CliFlags {
	readonly json: boolean;
	readonly camp: string | null;
	readonly cwd: string;
	readonly verbose: boolean;
	readonly quiet: boolean;
	readonly help: boolean;
	readonly to: string | null;
	readonly rollback: boolean;
	readonly seed: boolean;
	readonly restore: string | null;
	readonly strategy: string | null;
	readonly target: string | null;
	readonly check: boolean;
	readonly last: boolean;
	readonly offline: boolean;
	readonly template: string | null;
	readonly force: boolean;
	readonly hold: boolean;
	readonly runtime: string | null;
	readonly config: string | null;
	readonly policies: string | null;
	readonly request: string | null;
	readonly init: boolean;
	readonly once: boolean;
	/** `hobo dev --serve`: force the long-lived server without a TTY. */
	readonly serve: boolean;
	readonly port: string | null;
	readonly home: string | null;
	readonly host: string | null;
	/** Target broker URI for `up` / `claim` (alias of --broker-uri). */
	readonly broker: string | null;
	/** Alias of --broker. */
	readonly brokerUri: string | null;
	/** Anonymous / temporary remote deploy (aliases of each other). */
	readonly anonymous: boolean;
	readonly temporary: boolean;
	/** Claim token for remote `hobo claim --broker --token`. */
	readonly token: string | null;
	/** `hobo serve control --demo`: drive the world read model from the simulator. */
	readonly demo: boolean;
	/** Deterministic simulator seed for `--demo` (ADR-0147 demo mode). */
	readonly demoSeed: string | null;
	/** Target region for residency-aware preflight (`hobo verify --region`). */
	readonly region: string | null;
	readonly budgetId?: string | null;
}

export interface CliRequest {
	readonly verb: string | null;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly help: boolean;
	readonly flags: CliFlags;
}

export interface ParseArgvOptions {
	readonly cwd?: string;
}

export function parseArgv(
	argv: readonly string[],
	options: ParseArgvOptions = {},
): CliRequest {
	const flags = {
		json: false,
		// SAFETY: `camp: null as string | null,` is required at this I/O or test boundary.
		camp: null as string | null,
		cwd: path.resolve(options.cwd ?? process.cwd()),
		verbose: false,
		quiet: false,
		help: false,
		// SAFETY: `to: null as string | null,` is required at this I/O or test boundary.
		to: null as string | null,
		rollback: false,
		seed: false,
		// SAFETY: `restore: null as string | null,` is required at this I/O or test boundary.
		restore: null as string | null,
		// SAFETY: `strategy: null as string | null,` is required at this I/O or test boundary.
		strategy: null as string | null,
		// SAFETY: `target: null as string | null,` is required at this I/O or test boundary.
		target: null as string | null,
		check: false,
		last: false,
		offline: false,
		// SAFETY: `template: null as string | null,` is required at this I/O or test boundary.
		template: null as string | null,
		force: false,
		hold: false,
		// SAFETY: `runtime: null as string | null,` is required at this I/O or test boundary.
		runtime: null as string | null,
		// SAFETY: `config: null as string | null,` is required at this I/O or test boundary.
		config: null as string | null,
		// SAFETY: `policies: null as string | null,` is required at this I/O or test boundary.
		policies: null as string | null,
		// SAFETY: `request: null as string | null,` is required at this I/O or test boundary.
		request: null as string | null,
		init: false,
		once: false,
		serve: false,
		// SAFETY: `port: null as string | null,` is required at this I/O or test boundary.
		port: null as string | null,
		// SAFETY: `home: null as string | null,` is required at this I/O or test boundary.
		home: null as string | null,
		// SAFETY: `host: null as string | null,` is required at this I/O or test boundary.
		host: null as string | null,
		// SAFETY: `broker: null as string | null,` is required at this I/O or test boundary.
		broker: null as string | null,
		// SAFETY: `brokerUri: null as string | null,` is required at this I/O or test boundary.
		brokerUri: null as string | null,
		anonymous: false,
		temporary: false,
		// SAFETY: `token: null as string | null,` is required at this I/O or test boundary.
		token: null as string | null,
		demo: false,
		// SAFETY: `demoSeed: null as string | null,` is required at this I/O or test boundary.
		demoSeed: null as string | null,
		// SAFETY: `region: null as string | null,` is required at this I/O or test boundary.
		region: null as string | null,
		// SAFETY: mutable parser field is populated only by takeValue's string boundary.
		budgetId: null as string | null,
	};
	const args: string[] = [];
	let verb: string | null = null;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === undefined) {
			continue;
		}

		if (token === "--") {
			if (verb === "ci") args.push("--");
			args.push(...argv.slice(index + 1));
			break;
		}

		if (token.startsWith("-")) {
			if (verb === "ci" && token.startsWith("--cwd=")) {
				const value = token.slice("--cwd=".length);
				if (!value) throw new UsageError("--cwd requires a directory.");
				flags.cwd = path.resolve(value);
				continue;
			}
			if (
				verb === "ci" &&
				(token === "--format" ||
					token === "-F" ||
					token.startsWith("--format="))
			) {
				const format = token.startsWith("--format=")
					? token.slice("--format=".length)
					: takeValue(argv, index, token);
				if (format !== "json") {
					throw new UsageError('CI output format must be "json".');
				}
				flags.json = true;
				if (!token.startsWith("--format=")) index += 1;
				continue;
			}
			// CI owns its strict subcommand parser. Keep its options intact while
			// the shell continues to own output, working directory, and help.
			if (
				verb === "ci" &&
				!["--json", "--cwd", "--verbose", "-q", "--help", "-h"].includes(token)
			) {
				args.push(token);
				continue;
			}
			index = parseOption(argv, index, flags, verb);
			continue;
		}

		if (!verb) {
			verb = token;
			continue;
		}

		args.push(token);
	}

	if (flags.to && flags.rollback) {
		throw new UsageError(
			'--to cannot be combined with --rollback. Use one revision selector for "hobo up".',
			["Pass either `--to <revision>` or `--rollback`, not both."],
		);
	}

	return {
		verb,
		args,
		cwd: flags.cwd,
		help: flags.help,
		flags,
	};
}

function parseOption(
	argv: readonly string[],
	index: number,
	flags: {
		json: boolean;
		camp: string | null;
		cwd: string;
		verbose: boolean;
		quiet: boolean;
		help: boolean;
		to: string | null;
		rollback: boolean;
		seed: boolean;
		restore: string | null;
		strategy: string | null;
		target: string | null;
		check: boolean;
		last: boolean;
		offline: boolean;
		template: string | null;
		force: boolean;
		hold: boolean;
		runtime: string | null;
		config: string | null;
		policies: string | null;
		request: string | null;
		init: boolean;
		once: boolean;
		serve: boolean;
		port: string | null;
		home: string | null;
		host: string | null;
		broker: string | null;
		brokerUri: string | null;
		anonymous: boolean;
		temporary: boolean;
		token: string | null;
		demo: boolean;
		demoSeed: string | null;
		region: string | null;
		budgetId: string | null;
	},
	verb: string | null,
): number {
	const token = argv[index];
	if (token === undefined) {
		return index;
	}

	switch (token) {
		case "--json":
			flags.json = true;
			return index;
		case "--camp":
			flags.camp = takeValue(argv, index, token);
			return index + 1;
		case "--cwd":
			flags.cwd = path.resolve(takeValue(argv, index, token));
			return index + 1;
		case "--verbose":
			flags.verbose = true;
			return index;
		case "-q":
			flags.quiet = true;
			return index;
		case "--help":
		case "-h":
			flags.help = true;
			return index;
		case "--to":
			flags.to = takeValue(argv, index, token);
			return index + 1;
		case "--rollback":
			flags.rollback = true;
			return index;
		case "--seed":
			flags.seed = true;
			return index;
		case "--restore":
			flags.restore = takeValue(argv, index, token);
			return index + 1;
		case "--strategy":
			flags.strategy = takeValue(argv, index, token);
			return index + 1;
		case "--target":
			flags.target = takeValue(argv, index, token);
			return index + 1;
		case "--check":
			flags.check = true;
			return index;
		case "--last":
			flags.last = true;
			return index;
		case "-t":
		case "--template":
			flags.template = takeValue(argv, index, token);
			return index + 1;
		case "--force":
			flags.force = true;
			return index;
		case "--hold":
			flags.hold = true;
			return index;
		case "--runtime":
			flags.runtime = takeValue(argv, index, token);
			return index + 1;
		case "--config":
		case "--policies":
		case "--request":
			// Broker-scoped value flags (cli-spec.md `broker` row).
			if (verb === "broker") {
				// SAFETY: `const key = token.slice(2) as "config" | "policies" | "request";` is required at this I/O or test boundary.
				const key = token.slice(2) as "config" | "policies" | "request";
				flags[key] = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--init":
			if (verb === "broker") {
				flags.init = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--offline":
			if (verb === "doctor") {
				flags.offline = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--once":
			if (verb === "dev" || verb === "serve") {
				flags.once = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--serve":
			// `hobo dev --serve`: long-lived dev server for non-TTY callers.
			if (verb === "dev") {
				flags.serve = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--demo":
			// `hobo serve control --demo` (ADR-0147): seeded world simulator,
			// always rendered with the SIMULATED badge.
			if (verb === "serve") {
				flags.demo = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--demo-seed":
			if (verb === "serve") {
				flags.demoSeed = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--region":
			if (verb === "verify" || verb === "up") {
				flags.region = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--budget":
		case "--budget-id":
			if (verb === "up" || verb === "plan" || verb === "down") {
				flags.budgetId = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--port":
			if (verb === "dev" || verb === "yard" || verb === "serve") {
				flags.port = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--home":
			// Yard/dev install root; also `up`/`claim`/`login` for HOBO_HOME
			// profile and `serve` for the control-plane store it projects from.
			if (
				verb === "yard" ||
				verb === "dev" ||
				verb === "up" ||
				verb === "claim" ||
				verb === "login" ||
				verb === "serve"
			) {
				flags.home = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--host":
			if (verb === "yard" || verb === "dev" || verb === "serve") {
				flags.host = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--broker":
			if (verb === "up" || verb === "claim" || verb === "login") {
				// Canonical flag; --broker-uri is an accepted alias.
				flags.broker = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--broker-uri":
			if (verb === "up" || verb === "claim" || verb === "login") {
				flags.brokerUri = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--anonymous":
			if (verb === "up") {
				flags.anonymous = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--temporary":
			// Alias of --anonymous (Cloudflare wrangler deploy --temporary style).
			if (verb === "up") {
				flags.temporary = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--token":
			if (verb === "claim") {
				flags.token = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		default:
			throw unknownOption(token, verb);
	}
}

function takeValue(
	argv: readonly string[],
	index: number,
	flag: string,
): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new UsageError(`Option "${flag}" requires a value.`, [
			`Provide a value immediately after ${flag}.`,
		]);
	}
	return value;
}

function unknownOption(token: string, verb: string | null): UsageError {
	const helpTarget = verb ? `hobo ${verb} --help` : "hobo --help";
	return new UsageError(`Unknown option "${token}". Run "${helpTarget}".`, [
		`Run \`${helpTarget}\` to see supported flags.`,
	]);
}

export function unknownVerbMessage(input: string): string {
	const suggestion = nearestVerb(input);
	return `Unknown verb "${input}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Run "hobo --help".`;
}

export function assertKnownVerb(verb: string): void {
	if (!verbNames.has(verb)) {
		throw new UsageError(unknownVerbMessage(verb));
	}
}

function nearestVerb(input: string): string | null {
	let best: { candidate: string; distance: number } | null = null;
	for (const candidate of verbNames) {
		const distance = levenshtein(input, candidate);
		if (!best || distance < best.distance) {
			best = { candidate, distance };
		}
	}
	// Short verbs are cheap to fat-finger into another valid word: only suggest
	// on distance ≤1 for inputs up to 4 chars, ≤2 for longer ones.
	return best && best.distance <= (input.length <= 4 ? 1 : 2)
		? best.candidate
		: null;
}

function levenshtein(left: string, right: string): number {
	const distances = Array.from({ length: left.length + 1 }, () =>
		Array<number>(right.length + 1).fill(0),
	);
	for (let row = 0; row <= left.length; row += 1) {
		const rowValues = distances[row];
		if (rowValues) {
			rowValues[0] = row;
		}
	}
	for (let column = 0; column <= right.length; column += 1) {
		const firstRow = distances[0];
		if (firstRow) {
			firstRow[column] = column;
		}
	}

	for (let row = 1; row <= left.length; row += 1) {
		for (let column = 1; column <= right.length; column += 1) {
			const currentRow = distances[row];
			const previousRow = distances[row - 1];
			if (!currentRow || !previousRow) {
				continue;
			}
			const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
			currentRow[column] = Math.min(
				(currentRow[column - 1] ?? 0) + 1,
				(previousRow[column] ?? 0) + 1,
				(previousRow[column - 1] ?? 0) + substitutionCost,
			);
		}
	}

	return distances[left.length]?.[right.length] ?? Number.POSITIVE_INFINITY;
}
