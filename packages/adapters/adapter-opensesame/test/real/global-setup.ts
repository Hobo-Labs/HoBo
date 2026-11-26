import { resolveKit } from "./kit.js";

/**
 * The real lane's first act: find the kit or stop the whole run with the way
 * to build one. Nothing in test/real is collected, let alone skipped, without it.
 */
export function setup(): void {
	resolveKit(process.env);
}
