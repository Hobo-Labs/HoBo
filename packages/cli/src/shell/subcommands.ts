export type SubcommandOptionKind = "value" | "switch";

export type SubcommandOptionValue = string | true;

// public-contract: the parsed subcommand options on CliFlags.
export type SubcommandOptions = Readonly<Record<string, SubcommandOptionValue>>;

export type VerbSubcommandTable = Readonly<{
	options: ReadonlyMap<string, SubcommandOptionKind>;
	common: readonly string[];
	subcommands: ReadonlyMap<string, readonly string[]>;
	strict: boolean;
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

export function acceptedOptions(
	verbTable: VerbSubcommandTable,
	subcommand: string,
): ReadonlySet<string> {
	return new Set([
		...verbTable.common,
		...(verbTable.subcommands.get(subcommand) ?? []),
	]);
}
