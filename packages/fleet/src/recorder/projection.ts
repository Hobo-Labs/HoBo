import type { AuthorityDeps } from "../ports.js";
export function projection(_deps: Pick<AuthorityDeps, "now">) {
	return { async tick() {}, async caughtUp() {} };
}
