/**
 * Which of this process's Node options reach the run it relaunches itself as
 * under OpenSesame (ADR-0170, credentials-opensesame.ts).
 *
 * The relaunch runs this same invocation again, so a Node option it is given
 * acts again in the command, after the adapter built the command's
 * environment from an allowlist: `--env-file=.env` re-reads the file, and
 * `--require dotenv/config` does the same from code, so a token the allowlist
 * kept back (a `CLOUDFLARE_API_TOKEN`) comes back beside the surrogate. An
 * option is passed on only when it is on the lists below, none of which reads
 * environment or code from disk, or when it is the one loader a hobo started
 * from source needs: `--import` of the TypeScript loader @hobo/hobo itself
 * depends on (tsx), resolved to the same file. NODE_OPTIONS, which the
 * allowlist passes on as a `NODE_*` name, is reduced by the same rule.
 * Everything else is left out and named, never with its value.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Options that take no value and read nothing: diagnostics, strictness, type stripping, which CA store. */
const FLAGS: ReadonlySet<string> = new Set([
	"--no-warnings",
	"--no-deprecation",
	"--trace-warnings",
	"--trace-deprecation",
	"--throw-deprecation",
	"--pending-deprecation",
	"--trace-uncaught",
	"--enable-source-maps",
	"--experimental-strip-types",
	"--no-experimental-strip-types",
	"--experimental-transform-types",
	"--use-openssl-ca",
	"--use-bundled-ca",
	"--use-system-ca",
]);

/** Options passed on only as `--name=value`: a size, a limit, a mode, a warning code. */
const VALUED: ReadonlySet<string> = new Set([
	"--max-old-space-size",
	"--stack-size",
	"--stack-trace-limit",
	"--unhandled-rejections",
	"--disable-warning",
]);

export type NodeOptionsInput = Readonly<{
	/** This process's `process.execArgv`. */
	execArgv: readonly string[];
	/** This process's NODE_OPTIONS. */
	nodeOptions: string | undefined;
	/** Where a relative or bare `--import` is resolved from, as Node resolves it. */
	cwd: string;
	/** The TypeScript loader that may be imported. Defaults to the tsx @hobo/hobo depends on. */
	typeScriptLoader?: string | undefined;
}>;

export type NodeOptionsForRun = Readonly<{
	/** The options from `execArgv` that are passed on, in order. */
	execArgv: readonly string[];
	/** NODE_OPTIONS as it is passed on; undefined when none of it is. */
	nodeOptions: string | undefined;
	/** What was left out, by option name (`--env-file`, `-r`) or `NODE_OPTIONS`, never a value. */
	left: readonly string[];
}>;

interface NodeOption {
	readonly name: string;
	/** The text after `=`, when there is one. */
	readonly inline: string | undefined;
	/** The option as it was given: one token, or the option and its value. */
	readonly tokens: readonly string[];
}

/**
 * The options in `tokens`. Node puts the script and its arguments after its own
 * options, so a token that does not start with `-` is the preceding option's value.
 */
function optionsOf(tokens: readonly string[]): NodeOption[] {
	const options: NodeOption[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		const next = tokens[index + 1];
		const takesNext =
			token.startsWith("-") && next !== undefined && !next.startsWith("-");
		const equals = token.indexOf("=");
		options.push({
			name: equals === -1 ? token : token.slice(0, equals),
			inline: equals === -1 ? undefined : token.slice(equals + 1),
			tokens: takesNext ? [token, next] : [token],
		});
		if (takesNext) index += 1;
	}
	return options;
}

function defaultTypeScriptLoader(): string | undefined {
	try {
		return createRequire(import.meta.url).resolve("tsx");
	} catch {
		return undefined;
	}
}

/** Whether `specifier`, imported from `cwd`, is the file `target`. */
function resolvesTo(specifier: string, cwd: string, target: string): boolean {
	try {
		const path = specifier.startsWith("file:")
			? fileURLToPath(specifier)
			: createRequire(join(cwd, "[relaunch]")).resolve(specifier);
		return realpathSync(path) === realpathSync(target);
	} catch {
		return false;
	}
}

function passes(
	option: NodeOption,
	cwd: string,
	loader: string | undefined,
): boolean {
	const separate = option.tokens[1];
	if (FLAGS.has(option.name)) {
		return option.inline === undefined && separate === undefined;
	}
	if (VALUED.has(option.name)) {
		return option.inline !== undefined && separate === undefined;
	}
	if (option.name !== "--import" || loader === undefined) return false;
	const specifier = option.inline ?? separate;
	return specifier !== undefined && resolvesTo(specifier, cwd, loader);
}

function reduce(
	tokens: readonly string[],
	cwd: string,
	loader: string | undefined,
) {
	const kept: string[] = [];
	const left: string[] = [];
	for (const option of optionsOf(tokens)) {
		if (passes(option, cwd, loader)) kept.push(...option.tokens);
		else left.push(option.name);
	}
	return { kept, left };
}

/** The Node options a relaunch under OpenSesame is given, and what it is not. */
export function nodeOptionsForRun(input: NodeOptionsInput): NodeOptionsForRun {
	const loader =
		"typeScriptLoader" in input
			? input.typeScriptLoader
			: defaultTypeScriptLoader();
	const fromArgv = reduce(input.execArgv, input.cwd, loader);
	const text = input.nodeOptions?.trim() ?? "";
	if (text === "") {
		return {
			execArgv: fromArgv.kept,
			nodeOptions: undefined,
			left: fromArgv.left,
		};
	}
	// Node reads quotes and escapes in NODE_OPTIONS; rather than parse them, such a value is left out whole.
	if (/["'\\]/u.test(text)) {
		return {
			execArgv: fromArgv.kept,
			nodeOptions: undefined,
			left: [...fromArgv.left, "NODE_OPTIONS"],
		};
	}
	const fromEnv = reduce(text.split(/\s+/u), input.cwd, loader);
	return {
		execArgv: fromArgv.kept,
		nodeOptions: fromEnv.kept.length > 0 ? fromEnv.kept.join(" ") : undefined,
		left: [...fromArgv.left, ...fromEnv.left],
	};
}
