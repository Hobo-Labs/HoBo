/**
 * The signals that end hobo-code: the launcher (`hobo-code.mjs`) passes them
 * on, the shell quits on them, `session serve` stops on them, and a composed
 * `hobo-yard-*` store is removed on them (`@hobo/hobo`'s
 * `removeOwnedDirsOnSignals`, which reads them through the package export
 * `@hobo/code/ending-signals`).
 *
 * One list, in plain JavaScript beside the launcher, so the launcher can read
 * it before anything is built.
 */
export const ENDING_SIGNALS = Object.freeze([
	"SIGINT",
	"SIGTERM",
	"SIGHUP",
	"SIGQUIT",
]);
