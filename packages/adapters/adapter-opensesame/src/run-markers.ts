/**
 * What a proxied run leaves in the child's environment, named once: the port
 * (which checks them) and the launch (which sets them) both import from here,
 * and neither imports the other.
 */

// public-contract: the environment marker a proxied run sets on everything it starts, and refuses to find already set.
export const CHILD_MARKER = "HOBO_OPENSESAME_CHILD";

// public-contract: `osr_` and 32 lower-case hex digits, the shape of what OpenSesame's plugin issues.
export const SURROGATE_PATTERN = "^osr_[0-9a-f]{32}$";

const surrogateRe = new RegExp(SURROGATE_PATTERN, "u");

/** Whether `value` is shaped like a surrogate the plugin issues. */
export function isSurrogate(value: string): boolean {
	return surrogateRe.test(value);
}
