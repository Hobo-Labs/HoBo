/**
 * How a git's death by a signal is told: the status a shell reports for it
 * (128 + the signal's number), the six signals the deadline wrapper repeats,
 * and the statuses it exits with for the rest, which its caller reads back.
 *
 * Erasable TypeScript with node builtins only.
 */
import { constants } from "node:os";

/** An exit status as a shell reports it: 128 + the signal's number for a death by a signal. */
export function exitStatus(
	code: number | null,
	signal: NodeJS.Signals | null,
): number {
	if (code !== null) return code;
	return 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0));
}

/**
 * The signals the deadline wrapper repeats when its git dies of one: the ones
 * Node leaves at their default action (the wrapper's own SIGINT, SIGTERM and
 * SIGHUP listeners are dropped first) and that dump no core.
 */
export const REPEATED_SIGNALS = [
	"SIGHUP",
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGUSR2",
	"SIGALRM",
] as const;

/**
 * The signals a git can die of that the wrapper reports as the status 128 + N.
 * Their statuses (QUIT 131, ABRT 134, USR1 138, SEGV 139, PIPE 141, ...) are
 * read back as the signal: git exits with them only when a program it ran was
 * ended by that signal. 129 (git's usage error) and 130 are not among them.
 */
const EXIT_SIGNALS: readonly NodeJS.Signals[] = [
	"SIGQUIT",
	"SIGILL",
	"SIGTRAP",
	"SIGABRT",
	"SIGBUS",
	"SIGFPE",
	"SIGUSR1",
	"SIGSEGV",
	"SIGPIPE",
	"SIGSYS",
];

const EXIT_STATUSES: ReadonlyMap<number, NodeJS.Signals> = new Map(
	EXIT_SIGNALS.map((name): [number, NodeJS.Signals] => [
		128 + (constants.signals[name] ?? 0),
		name,
	]),
);

/**
 * The signal a git died of. A direct call, or a wrapper that repeated the
 * signal, reports it; a wrapped call also names it through the status 128 + N
 * the wrapper exits with for the signals it does not repeat.
 */
export function endedBySignal(
	code: number | null,
	signal: NodeJS.Signals | null,
	wrapped: boolean,
): NodeJS.Signals | null {
	if (signal !== null) return signal;
	return wrapped && code !== null ? (EXIT_STATUSES.get(code) ?? null) : null;
}
