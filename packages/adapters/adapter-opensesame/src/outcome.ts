/**
 * How one `opensesame dev --agent run` ended, read from what it leaves: its
 * exit status and the lines it prints on stderr. This is the process boundary
 * the pact in contracts/ pins.
 *
 * What the binary really does (apps/cli/src/dev_run.rs, dev_supervise.rs,
 * dev_surrogate.rs, dev_credentials.rs, log_sink.rs), and where the status
 * alone is not enough:
 *
 * - the child's own status is passed through; a child killed by a signal is 1;
 * - a tripwire (`surrogate.misdirected`) exits 77, and so can a child, so 77
 *   counts as a tripwire only beside OpenSesame's own line;
 * - SIGTERM or SIGHUP to OpenSesame exits 143 or 129 after revoking the run,
 *   and so can a child, so the same rule applies;
 * - every refusal before the child starts (pin mismatch, an unreadable entry,
 *   a scope the plugin will not issue, a schema that does not parse) is a
 *   fatal error: `Error: <message>` on stderr, status 1;
 * - a run with no plugin, no entry or no brokerable connection starts anyway,
 *   exits as the child does, and hands the child a placeholder. Only a line
 *   on stderr says so, which is why that line is read at all: a green exit
 *   with a placeholder is the false pass this adapter exists to refuse.
 *
 * Only sentences in the shape OpenSesame writes (the closed set below) are read,
 * and a refusal needs a failing status beside it. The `opensesame: ` sentences
 * (tripwire, signal, placeholders) and the pin-mismatch sentence are matched
 * anywhere in the stderr, because OpenSesame prints its end-of-run line with no
 * newline before it and a child's unterminated last write, or a spinner ending
 * on a carriage return, leaves it glued to the child's text; the other `Error:`
 * classes are printed before the child exists and so start a line.
 *
 * The child shares stderr, so it can forge or hide. It can print any of these
 * sentences, which gains it a fail-closed kind (a tripwire, a refusal, a
 * placeholder) and never a pass, and nothing it wrote survives except the exit
 * status it chose. And a descendant that outlives OpenSesame's stop keeps
 * writing after OpenSesame's last line, enough to push it out of the start and
 * the end a capture retains, which would turn a tripwire into a `child_exit` of
 * the same status. So the `opensesame: ` sentences are not read from the
 * capture alone: `createOutcomeScan` sees every chunk as it arrives and keeps
 * one sentence of each shape (at most six, each within the limit), which no later
 * write can evict. What stays impossible to prevent here: a forged sentence is
 * classified only beside the exit status the child chose, so it is a fail-closed
 * kind and never a pass; and OpenSesame writes its tripwire sentence in several
 * `write(2)` calls, so a writer that gets in between them breaks the sentence and
 * the typed tripwire is lost to `child_exit` (the failing status is kept). A
 * status of 77, 143 or 129 is advisory beside its line, since a child can return
 * them itself. The gate that a surrogate was really delivered is the
 * SecretsPort, which checks the child's own variable and the run's markers.
 *
 * No text produced by the child, or by a line it could have forged, is ever
 * copied into a `ProxiedRunOutcome` or an error: the notice is a fixed sentence
 * chosen by the kind. Any other `Error:` line is the child's own failure
 * (every uncaught Node exception starts that way) and is reported as a
 * `child_exit` with the status and no words.
 */

import { constants } from "node:os";
import { create } from "@bufbuild/protobuf";

import {
	type ProxiedRunOutcome,
	ProxiedRunOutcomeSchema,
} from "./_generated/adapter_opensesame_pb.js";
import {
	OpenSesameAdapterError,
	type OpenSesameAdapterErrorCode,
} from "./errors.js";
import {
	createSentenceScan,
	type SentenceScan,
	sentencesOf,
} from "./sentences.js";

export const OUTCOME_KINDS = [
	"child_exit",
	"tripwire",
	"signalled",
	"placeholders_only",
	"scope_unbounded",
	"schema_refused",
	"plugin_pin_mismatch",
	"store_unreadable",
	"bridge_missing",
] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

const TRIPWIRE_EXIT = 77;

/**
 * OpenSesame's own sentences after its `opensesame: ` prefix. They are matched
 * anywhere in the retained stderr, not only at the start of a line: it prints
 * its end-of-run line after it has stopped the child with no newline before it,
 * so a child whose last write had none (a partial write, a spinner ending on a
 * carriage return) leaves the line glued to its own text. A child that prints one
 * of them on purpose gains only a fail-closed kind, as it could at column 0.
 */
const TRIPWIRE = /^surrogate\.misdirected: /u;
const SIGTERM_LINE = /^SIGTERM: the run is ended/u;
const SIGHUP_LINE = /^SIGHUP: the run is ended/u;
const PLACEHOLDER_LINES: readonly RegExp[] = [
	/^.*delivering placeholders/u,
	/^\S+ will keep its placeholder/u,
	/^\S+ has no token to redeem/u,
];
/** Every shape of sentence the outcome is read from; a scan keeps one of each. */
export const OWN_SENTENCES: readonly RegExp[] = [
	TRIPWIRE,
	SIGTERM_LINE,
	SIGHUP_LINE,
	...PLACEHOLDER_LINES,
];
const PIN =
	/^Error: the surrogate-proxy plugin no longer matches its install pin/u;
/** The same sentence anywhere; the pin check runs before the child exists, but a line is a line. */
const PIN_ANYWHERE =
	/Error: the surrogate-proxy plugin no longer matches its install pin/u;
const STORE =
	/^Error: the sealed entry \S+ \(for [A-Z][A-Z0-9_]*\) (?:cannot be read|is empty)/u;
const SCOPE =
	/^Error: the surrogate-proxy plugin refused the run and issued nothing: \S+ has no bounded scope/u;
const BRIDGE_SCOPE = /^Error: env-spec parse failed: /u;
/**
 * The parser or `node` is missing. An older OpenSesame ran a bare `node` and
 * said `os error 2`; a newer one searches only PATH directories others cannot
 * write (and, since its #1461, group-writable only by root's group or the
 * caller's own), and says it found "no usable `node`" there. A bad
 * `OPENSESAME_NODE` is `NODE_OVERRIDE` below.
 */
const BRIDGE_NOT_FOUND =
	/Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|No such file or directory|os error 2|ENOENT|no usable `node`/u;
/**
 * An `OPENSESAME_NODE` OpenSesame refuses to run (its #1461): every such error
 * is `OPENSESAME_NODE <why>` after `env-spec parse failed: `, whatever the why
 * (empty, not absolute, missing, not a regular file, not executable). Anchored
 * to the start of the error, so a schema error that mentions the name is not it.
 */
const NODE_OVERRIDE = /^Error: env-spec parse failed: OPENSESAME_NODE /u;
const SCHEMA = /^Error: (?:env-spec parse failed|resolve failed): /u;
/** Every other fatal sentence OpenSesame writes about its plugin before the command starts. */
const PLUGIN_REFUSAL = /^Error: the surrogate-proxy plugin /u;

/**
 * The only words a notice ever holds: one fixed sentence per kind. None is
 * built from a line of output, so none can carry what a child printed.
 */
const NOTICE = {
	child_exit: "",
	tripwire:
		"OpenSesame revoked the run: a surrogate was sent to a host that is not its provider's, and the command was stopped",
	signalled:
		"OpenSesame was told to stop: the run was revoked and the command stopped",
	placeholders_only:
		"OpenSesame gave the command a placeholder, not a surrogate",
	scope_unbounded:
		"the surrogate-proxy plugin would not issue a surrogate with no bounded scope",
	schema_refused:
		"OpenSesame or its plugin refused the schema or the run before the command started",
	plugin_pin_mismatch: "the surrogate-proxy plugin changed since it was pinned",
	store_unreadable: "the sealed entry for the connection cannot be read",
	bridge_missing:
		"OpenSesame could not run the env-spec bridge (node, OPENSESAME_NODE, or @env-spec/parser)",
} as const satisfies Readonly<Record<OutcomeKind, string>>;

function outcome(
	kind: OutcomeKind,
	exitCode: number,
	notice: string,
): ProxiedRunOutcome {
	return Object.freeze(
		create(ProxiedRunOutcomeSchema, { kind, exitCode, notice }),
	);
}

/** Lines for the `Error:` block, which is printed before the child exists and so starts a line. */
function linesOf(stderr: string): string[] {
	return stderr.split(/\r\n|\r|\n/u);
}

/** The fatal error is the last thing OpenSesame prints: its line and what follows. */
function errorBlock(lines: readonly string[]): string[] {
	const start = lines
		.map((line) => line.startsWith("Error: "))
		.lastIndexOf(true);
	return start < 0 ? [] : lines.slice(start);
}

function classifyError(block: readonly string[]): OutcomeKind | undefined {
	const first = block[0] ?? "";
	const whole = block.join("\n");
	if (PIN.test(first)) return "plugin_pin_mismatch";
	if (STORE.test(first)) return "store_unreadable";
	if (SCOPE.test(first)) return "scope_unbounded";
	if (NODE_OVERRIDE.test(first)) return "bridge_missing";
	if (BRIDGE_SCOPE.test(first) && BRIDGE_NOT_FOUND.test(whole)) {
		return "bridge_missing";
	}
	if (SCHEMA.test(first) || PLUGIN_REFUSAL.test(first)) return "schema_refused";
	return undefined;
}

/**
 * A reader to feed every chunk of stderr to as it arrives, for the sentences
 * `parseOutcome` is read from. A capture keeps the start and the end of a long
 * stream; a child (or a descendant that outlives OpenSesame's stop) that writes
 * enough past OpenSesame's last line pushes that line out of both. This keeps
 * each shape of sentence once it has been seen, so nothing written after can.
 */
export function createOutcomeScan(): SentenceScan {
	return createSentenceScan(OWN_SENTENCES);
}

/**
 * Read a finished run. `exitCode` is null when OpenSesame itself was ended by
 * `signal`; `stderr` is what it and its child wrote there (the retained start
 * and end of it); `sentences` are the sentences a scan of the whole stream
 * kept, which are read in place of the ones found in `stderr` when given.
 */
export function parseOutcome(
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	stderr: string,
	sentences?: readonly string[],
): ProxiedRunOutcome {
	if (signal !== null) {
		const number = constants.signals[signal];
		const name = number === undefined ? "a signal" : signal;
		return outcome(
			"signalled",
			128 + (number ?? 0),
			`OpenSesame was ended by ${name}; the command it started may still be running with a live surrogate`,
		);
	}
	const status = exitCode ?? 1;
	const own = sentences ?? sentencesOf(stderr);

	if (status === TRIPWIRE_EXIT && own.some((line) => TRIPWIRE.test(line))) {
		return outcome("tripwire", status, NOTICE.tripwire);
	}
	if (
		(status === 143 && own.some((line) => SIGTERM_LINE.test(line))) ||
		(status === 129 && own.some((line) => SIGHUP_LINE.test(line)))
	) {
		const name = status === 143 ? "SIGTERM" : "SIGHUP";
		return outcome("signalled", status, `${name}: ${NOTICE.signalled}`);
	}
	if (status !== 0 && PIN_ANYWHERE.test(stderr)) {
		return outcome("plugin_pin_mismatch", status, NOTICE.plugin_pin_mismatch);
	}
	if (status !== 0) {
		const kind = classifyError(errorBlock(linesOf(stderr)));
		if (kind !== undefined) return outcome(kind, status, NOTICE[kind]);
	}
	if (
		own.some((line) => PLACEHOLDER_LINES.some((pattern) => pattern.test(line)))
	) {
		return outcome("placeholders_only", status, NOTICE.placeholders_only);
	}
	return outcome("child_exit", status, NOTICE.child_exit);
}

const ERROR_FOR = {
	child_exit: "child_exit",
	tripwire: "tripwire_misdirected",
	signalled: "signalled",
	placeholders_only: "placeholders_only",
	scope_unbounded: "scope_unbounded",
	schema_refused: "launch_invalid",
	plugin_pin_mismatch: "plugin_pin_mismatch",
	store_unreadable: "store_unreadable",
	bridge_missing: "bridge_missing",
} as const satisfies Readonly<Record<OutcomeKind, OpenSesameAdapterErrorCode>>;

const WHAT_HAPPENED = {
	child_exit: "the proxied command exited with a failing status",
	tripwire:
		"a surrogate was sent to a host that is not its provider's; the run was revoked and the child stopped",
	// What happened to the command is in the notice, which differs: asked to stop, OpenSesame revoked and stopped it; killed, it may still run.
	signalled: "OpenSesame was ended by a signal",
	placeholders_only:
		"the proxied command holds a placeholder, not a surrogate: install and enable the surrogate-proxy plugin and seal the token with `opensesame pass insert`",
	scope_unbounded:
		"the plugin would not issue a surrogate with no bounded scope",
	schema_refused: "OpenSesame refused the generated .env.schema",
	plugin_pin_mismatch:
		"the surrogate-proxy plugin changed since it was pinned; reinstall it (there is no fallback to placeholders)",
	store_unreadable: "the sealed entry for the connection cannot be read",
	bridge_missing:
		"OpenSesame cannot read the schema: it needs a node it trusts, found in a PATH directory that others cannot write or, where your OpenSesame reads OPENSESAME_NODE, the absolute path in that variable (list it in passEnv), and the env-spec bridge with @env-spec/parser (OPENSESAME_ENV_PARSE)",
} as const satisfies Readonly<Record<OutcomeKind, string>>;

function kindOf(run: ProxiedRunOutcome): OutcomeKind {
	const kind = OUTCOME_KINDS.find((known) => known === run.kind);
	if (kind === undefined) {
		throw new OpenSesameAdapterError("launch_invalid", "unknown outcome kind");
	}
	return kind;
}

/** The typed refusal for a run, or `undefined` for a child that exited 0. */
export function outcomeError(
	run: ProxiedRunOutcome,
): OpenSesameAdapterError | undefined {
	const kind = kindOf(run);
	if (kind === "child_exit" && run.exitCode === 0) return undefined;
	// Every part is a fixed sentence or a number: none is the child's text.
	const detail =
		kind === "signalled"
			? ` (${run.notice})`
			: kind === "child_exit"
				? ` (status ${run.exitCode})`
				: "";
	return new OpenSesameAdapterError(
		ERROR_FOR[kind],
		`${WHAT_HAPPENED[kind]}${detail}`,
	);
}

/**
 * The status a process relaunched under OpenSesame should exit with: the
 * child's own, a tripwire's 77 or a signal's 128+n as OpenSesame returned it,
 * and 1 for anything that left placeholders or never started the child. When
 * OpenSesame itself was killed by a signal the status is 128+n of that signal,
 * and the command it started may still be running with its surrogate: the
 * notice says so, and nothing here can stop it.
 */
export function exitCodeOf(run: ProxiedRunOutcome): number {
	const kind = kindOf(run);
	if (kind === "child_exit" || kind === "tripwire" || kind === "signalled") {
		return run.exitCode;
	}
	return 1;
}
