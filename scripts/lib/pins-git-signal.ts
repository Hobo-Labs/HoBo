import { constants } from "node:os";

export function exitStatus(
	code: number | null,
	signal: NodeJS.Signals | null,
): number {
	if (code !== null) return code;
	return 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0));
}

export const REPEATED_SIGNALS = [
	"SIGHUP",
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGUSR2",
	"SIGALRM",
] as const;

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

export function endedBySignal(
	code: number | null,
	signal: NodeJS.Signals | null,
	wrapped: boolean,
): NodeJS.Signals | null {
	if (signal !== null) return signal;
	return wrapped && code !== null ? (EXIT_STATUSES.get(code) ?? null) : null;
}
