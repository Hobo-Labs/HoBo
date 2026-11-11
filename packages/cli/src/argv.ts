/**
 * `@hobo/cli/argv`: the verb catalogue and argv parser, without the CLI.
 *
 * The root export evaluates every command, the codegen engine and the
 * compiler. A caller that only needs to tell which verb an argv names
 * (the `hobo` binary's OpenSesame relaunch check runs before anything is
 * composed) imports this instead.
 */
export { parseArgv } from "./shell/parse.js";
export { CANONICAL_VERBS } from "./shell/verbs.js";
