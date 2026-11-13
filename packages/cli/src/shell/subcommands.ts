/**
 * Subcommand-declared options (plan 0024; packages/hobo/CD.md).
 *
 * Some verbs are a family of subcommands, each with its own flags:
 * `hobo deploy freight record --file`, `hobo deploy agent token --camp-set`,
 * `hobo incident open --signal`, `hobo serve cd --simulate`. The shell owns
 * their parsing so every caller (the binary, MCP, tests) gets the same typed
 * result: a flag is a declared value or a declared switch, never free-form
 * passthrough. A flag the resolved subcommand does not declare is refused with
 * the shell's ordinary `Unknown option` usage error.
 *
 * A strict verb accepts nothing else beside the shell's global flags
 * (`--json`, `--cwd`, `--verbose`, `-q`, `--help`). A non-strict verb keeps
 * its existing verb-scoped shell flags (`serve --port`) and only routes the
 * names declared here through the table.
 */

/** A value flag takes the next token (or `--name=value`); a switch takes none. */
export type SubcommandOptionKind = "value" | "switch";

/** A parsed declared option: the value, or `true` for a switch. */
export type SubcommandOptionValue = string | true;

/**
 * Parsed declared options by name (without `--`). A plain JSON object, so a
 * command reading its flags as JSON (`@hobo/hobo`'s CD commands) reads these
 * the same way.
 */
// public-contract: the parsed subcommand options on CliFlags.
export type SubcommandOptions = Readonly<Record<string, SubcommandOptionValue>>;

export type VerbSubcommandTable = Readonly<{
	/** Option name (without `--`) and its kind; the only names this table accepts. */
	options: ReadonlyMap<string, SubcommandOptionKind>;
	/** Options every subcommand of the verb takes. */
	common: readonly string[];
	/** Subcommand words (space-joined) and the options each declares. */
	subcommands: ReadonlyMap<string, readonly string[]>;
	/** Strict: only global shell flags beside the declared options. */
	strict: boolean;
	/** The subcommand a run with no subcommand words resolves to. */
	defaultSubcommand?: string;
}>;

type TableInput = Readonly<{
	options: readonly (readonly [string, SubcommandOptionKind])[];
	common: readonly string[];
	subcommands: readonly (readonly [string, readonly string[]])[];
	strict: boolean;
	defaultSubcommand?: string;
}>;

function table(input: TableInput): VerbSubcommandTable {
	const options = new Map(input.options);
	const subcommands = new Map(input.subcommands);
	for (const name of [
		...input.common,
		...input.subcommands.flatMap(([, names]) => names),
	])
		if (!options.has(name))
			throw new Error(`subcommand option --${name} is not declared`);
	return Object.freeze({
		options,
		common: Object.freeze([...input.common]),
		subcommands,
		strict: input.strict,
		...(input.defaultSubcommand === undefined
			? undefined
			: { defaultSubcommand: input.defaultSubcommand }),
	});
}

const value = (name: string) => [name, "value"] as const;
const flag = (name: string) => [name, "switch"] as const;

/**
 * `hobo deploy` (packages/hobo/src/cd-deploy.ts `CD_DEPLOY_SUBCOMMANDS`; a
 * parity test there keeps both lists equal). `--yard` names a topology file
 * (a Yard module or a delivery module exporting `yards`/`camps`).
 */
export const DEPLOY_SUBCOMMANDS: VerbSubcommandTable = table({
	strict: true,
	options: [
		value("format"),
		flag("simulate"),
		value("yard"),
		value("file"),
		value("bindle"),
		value("limit"),
		value("reason"),
		value("camp"),
		value("ttl-ms"),
		value("pipeline"),
		value("node"),
		value("source-camp"),
		value("strategy"),
		flag("propose"),
		value("idempotency-key"),
		value("to"),
		value("camp-set"),
		value("mode"),
		value("token"),
		value("jwk-file"),
		value("feed"),
		value("reconciler"),
		value("key-file"),
		value("svid-file"),
		value("window-ms"),
		value("campset"),
		value("key"),
		value("value"),
		value("effect"),
		value("management"),
		value("count"),
		value("station"),
	],
	common: ["format", "simulate", "yard"],
	subcommands: [
		["freight record", ["file"]],
		["freight list", ["bindle", "limit"]],
		["freight show", []],
		["freight yank", ["reason"]],
		["freight approve", ["camp", "reason", "ttl-ms"]],
		["source define", ["file"]],
		["source list", []],
		["source poll", []],
		["pipeline apply", ["file"]],
		["pipeline show", []],
		["pipeline list", []],
		["window define", ["file"]],
		["window list", []],
		["window override", ["camp", "reason", "ttl-ms"]],
		[
			"promote",
			[
				"camp",
				"pipeline",
				"node",
				"source-camp",
				"strategy",
				"propose",
				"idempotency-key",
			],
		],
		["status", ["camp", "limit"]],
		["logs", ["camp", "limit"]],
		["rollback", ["camp", "reason", "to", "idempotency-key"]],
		["reconcile", ["camp"]],
		[
			"preview create",
			["source-camp", "ttl-ms", "pipeline", "node", "idempotency-key"],
		],
		["preview list", []],
		["verify show", []],
		["agent token", ["camp-set", "camp", "mode", "ttl-ms"]],
		["agent enroll", ["token", "jwk-file"]],
		["agent approve-key", []],
		["agent accept", ["camp"]],
		["agent run", ["feed", "reconciler", "key-file", "svid-file", "camp"]],
		["agent revoke", ["reason"]],
		["publisher define", ["file"]],
		["metrics", ["window-ms", "camp"]],
		["campset define", ["file"]],
		["campset list", []],
		["camp list", ["campset"]],
		["camp show", []],
		["camp taint", ["key", "value", "effect", "reason"]],
		["camp untaint", ["key", "effect"]],
		["camp manage", ["management"]],
		["placement define", ["file"]],
		["placement decide", ["count", "pipeline", "node", "station"]],
		["placement show", []],
		["scores report", ["file"]],
		["fanout show", ["pipeline", "node"]],
		["fanout halt", ["reason"]],
		["fanout resume", []],
		["fanout rollback", ["reason"]],
		["failover list", ["camp", "limit"]],
		["failover approve", []],
		["rebalance", ["pipeline", "node", "reason", "idempotency-key"]],
		["compliance show", []],
		["hosting-status", []],
		["hosting-resume", []],
		["hosting-cancel", []],
		["hosting-resume-mutation", []],
	],
});

/** `hobo incident status|open` (packages/hobo/src/incident-command.ts). */
export const INCIDENT_SUBCOMMANDS: VerbSubcommandTable = table({
	strict: true,
	options: [
		value("format"),
		flag("simulate"),
		value("yard"),
		value("camp"),
		value("signal"),
		value("reason"),
	],
	common: ["format", "simulate", "yard"],
	subcommands: [
		["status", ["camp"]],
		["open", ["camp", "signal", "reason"]],
	],
	defaultSubcommand: "status",
});

/**
 * `hobo serve control|cd`. Not strict: `--port`, `--host`, `--home`, `--once`
 * and the demo flags stay the shell's serve-scoped flags.
 */
export const SERVE_SUBCOMMANDS: VerbSubcommandTable = table({
	strict: false,
	options: [flag("simulate"), value("yard")],
	common: [],
	subcommands: [
		["control", []],
		["cd", ["simulate", "yard"]],
	],
	defaultSubcommand: "control",
});

// public-contract: the verbs whose subcommands declare their own options.
export const VERB_SUBCOMMANDS: ReadonlyMap<string, VerbSubcommandTable> =
	new Map([
		["deploy", DEPLOY_SUBCOMMANDS],
		["incident", INCIDENT_SUBCOMMANDS],
		["serve", SERVE_SUBCOMMANDS],
	]);

/** The subcommand `args` names: two words first, then one, else the default. */
export function resolveSubcommand(
	verbTable: VerbSubcommandTable,
	args: readonly string[],
): string | undefined {
	const two = args.length >= 2 ? `${args[0]} ${args[1]}` : undefined;
	if (two !== undefined && verbTable.subcommands.has(two)) return two;
	const one = args[0];
	if (one === undefined) return verbTable.defaultSubcommand;
	return verbTable.subcommands.has(one) ? one : undefined;
}

/** The options a resolved subcommand accepts (its own plus the verb's common ones). */
export function acceptedOptions(
	verbTable: VerbSubcommandTable,
	subcommand: string,
): ReadonlySet<string> {
	return new Set([
		...verbTable.common,
		...(verbTable.subcommands.get(subcommand) ?? []),
	]);
}
