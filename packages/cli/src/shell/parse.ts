import path from "node:path";

import { UsageError } from "./errors.js";
import {
	acceptedOptions,
	resolveSubcommand,
	type SubcommandOptions,
	type SubcommandOptionValue,
	VERB_SUBCOMMANDS,
	type VerbSubcommandTable,
} from "./subcommands.js";
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
	readonly serve: boolean;
	readonly port: string | null;
	readonly home: string | null;
	readonly host: string | null;
	readonly broker: string | null;
	readonly brokerUri: string | null;
	readonly anonymous: boolean;
	readonly temporary: boolean;
	readonly token: string | null;
	readonly demo: boolean;
	readonly demoSeed: string | null;
	readonly region: string | null;
	readonly budgetId?: string | null;
	readonly whatIf?: boolean;
	readonly mode?: string | null;
	readonly relay?: string | null;
	readonly subcommandOptions?: SubcommandOptions;
}

type MutableParserFlags = {
	-readonly [Key in keyof Omit<CliFlags, "subcommandOptions">]-?: CliFlags[Key];
};

export interface CliRequest {
	readonly verb: string | null;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly help: boolean;
	readonly flags: CliFlags & { readonly subcommandOptions: SubcommandOptions };
}

export interface ParseArgvOptions {
	readonly cwd?: string;
}

const RAW_ARG_VERBS: ReadonlySet<string> = new Set(["ci", "cd"]);

export function parseArgv(
	argv: readonly string[],
	options: ParseArgvOptions = {},
): CliRequest {
	const flags: MutableParserFlags = {
		json: false,
		camp: null,
		cwd: path.resolve(options.cwd ?? process.cwd()),
		verbose: false,
		quiet: false,
		help: false,
		to: null,
		rollback: false,
		seed: false,
		restore: null,
		strategy: null,
		target: null,
		check: false,
		last: false,
		offline: false,
		template: null,
		force: false,
		hold: false,
		runtime: null,
		config: null,
		policies: null,
		request: null,
		init: false,
		once: false,
		serve: false,
		port: null,
		home: null,
		host: null,
		broker: null,
		brokerUri: null,
		anonymous: false,
		temporary: false,
		token: null,
		demo: false,
		demoSeed: null,
		region: null,
		budgetId: null,
		whatIf: false,
		mode: null,
		relay: null,
	};
	const args: string[] = [];
	const subcommandOptions = new Map<string, SubcommandOptionValue>();
	let verb: string | null = null;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === undefined) {
			continue;
		}

		if (token === "--") {
			if (RAW_ARG_VERBS.has(verb ?? "")) args.push("--");
			args.push(...argv.slice(index + 1));
			break;
		}

		if (token.startsWith("-")) {
			if (RAW_ARG_VERBS.has(verb ?? "") && token.startsWith("--cwd=")) {
				const value = token.slice("--cwd=".length);
				if (!value) throw new UsageError("--cwd requires a directory.");
				flags.cwd = path.resolve(value);
				continue;
			}
			if (
				RAW_ARG_VERBS.has(verb ?? "") &&
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

			if (
				RAW_ARG_VERBS.has(verb ?? "") &&
				!["--json", "--cwd", "--verbose", "-q", "--help", "-h"].includes(token)
			) {
				args.push(token);
				continue;
			}
			const verbTable = verb === null ? undefined : VERB_SUBCOMMANDS.get(verb);
			if (verbTable) {
				const taken = takeSubcommandOption(
					argv,
					index,
					verbTable,
					subcommandOptions,
				);
				if (taken !== undefined) {
					index = taken;
					continue;
				}
				if (verbTable.strict && !STRICT_GLOBAL_FLAGS.has(token))
					throw unknownOption(token, verb);
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
	if (verb === "up" && flags.rollback && flags.mode) {
		throw new UsageError(
			"--mode cannot be combined with --rollback; rollback restores the previous Set exactly.",
		);
	}
	if (verb === "up" && flags.whatIf && (flags.to || flags.rollback)) {
		throw new UsageError(
			"--what-if cannot preview a selected revision or rollback yet.",
		);
	}

	const verbTable = verb === null ? undefined : VERB_SUBCOMMANDS.get(verb);
	if (verbTable) refuseUndeclared(verbTable, verb, args, subcommandOptions);

	return {
		verb,
		args,
		cwd: flags.cwd,
		help: flags.help,
		flags: {
			...flags,
			subcommandOptions: Object.freeze(Object.fromEntries(subcommandOptions)),
		},
	};
}

const STRICT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
	"--json",
	"--cwd",
	"--verbose",
	"-q",
	"--help",
	"-h",
]);

function takeSubcommandOption(
	argv: readonly string[],
	index: number,
	verbTable: VerbSubcommandTable,
	into: Map<string, SubcommandOptionValue>,
): number | undefined {
	const token = argv[index];
	if (token === undefined || !token.startsWith("--")) return undefined;
	const equals = token.indexOf("=");
	const name = token.slice(2, equals === -1 ? undefined : equals);
	const kind = verbTable.options.get(name);
	if (kind === undefined) return undefined;
	if (kind === "switch") {
		if (equals !== -1)
			throw new UsageError(`Option "--${name}" takes no value.`, [
				`Pass --${name} on its own.`,
			]);
		into.set(name, true);
		return index;
	}
	if (equals === -1) {
		into.set(name, takeValue(argv, index, token));
		return index + 1;
	}
	const inline = token.slice(equals + 1);
	if (inline === "")
		throw new UsageError(`Option "--${name}" requires a value.`, [
			`Provide a value immediately after --${name}.`,
		]);
	into.set(name, inline);
	return index;
}

function refuseUndeclared(
	verbTable: VerbSubcommandTable,
	verb: string | null,
	args: readonly string[],
	options: ReadonlyMap<string, SubcommandOptionValue>,
): void {
	const subcommand = resolveSubcommand(verbTable, args);

	if (subcommand === undefined) return;
	const accepted = acceptedOptions(verbTable, subcommand);
	for (const name of options.keys())
		if (!accepted.has(name)) throw unknownOption(`--${name}`, verb, subcommand);
}

function parseOption(
	argv: readonly string[],
	index: number,
	flags: MutableParserFlags,
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
			if (verb === "broker") {
				const key =
					token === "--config"
						? "config"
						: token === "--policies"
							? "policies"
							: "request";
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
			if (verb === "dev") {
				flags.serve = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--demo":
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
			if (verb === "verify" || verb === "up" || verb === "plan") {
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
		case "--what-if":
		case "--dry-run":
		case "--preview":
			if (verb === "up" || verb === "down") {
				flags.whatIf = true;
				return index;
			}
			throw unknownOption(token, verb);
		case "--mode":
			if (verb === "up" || verb === "plan") {
				const mode = takeValue(argv, index, token);
				if (mode !== "incremental" && mode !== "complete")
					throw new UsageError('--mode must be "incremental" or "complete".');
				flags.mode = mode;
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
				flags.broker = takeValue(argv, index, token);
				return index + 1;
			}
			throw unknownOption(token, verb);
		case "--relay":
			if (verb === "login") {
				flags.relay = takeValue(argv, index, token);
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

function unknownOption(
	token: string,
	verb: string | null,
	subcommand?: string,
): UsageError {
	const helpTarget = verb ? `hobo ${verb} --help` : "hobo --help";
	const scope = verb && subcommand ? ` for "hobo ${verb} ${subcommand}"` : "";
	return new UsageError(
		`Unknown option "${token}"${scope}. Run "${helpTarget}".`,
		[`Run \`${helpTarget}\` to see supported flags.`],
	);
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
