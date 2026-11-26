/**
 * The kit the real lane runs against: a directory holding a locally built
 * OpenSesame, because no release publishes one (and the plugin must be its
 * TEST build, which can be aimed at a loopback server and must never hold a
 * real credential).
 *
 *   <kit>/opensesame                          cargo build -p opensesame-cli
 *   <kit>/opensesame-surrogate-proxy          cargo build -p opensesame-surrogate-proxy --features upstream-override
 *   <kit>/bridge/opensesame-env-parse.mjs     OpenSesame's packages/env-spec-bridge/bin
 *   <kit>/bridge/node_modules/@env-spec/parser   @env-spec/parser@0.4.1, any package manager's layout
 *
 * `<kit>/bridge/opensesame-env-parse.mjs` is what every run hands OpenSesame as
 * OPENSESAME_ENV_PARSE, and the adapter refuses a bridge that is not an absolute
 * path in a trusted place (`src/trust.ts`: it and every directory above it owned
 * by you or root and not writable by group or others, outside the working
 * directory's tree, not under `node_modules/.bin`). So the kit must be built that
 * way too, or every run is `bridge_missing`: `umask 022` (or `chmod -R go-w`) and
 * an absolute path outside the package directory.
 *
 * The lane fails, never skips, when the kit is missing or wrong: a skipped
 * proof reads as a passed one.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { nodeTrust, placeProblem, type Trust } from "../../src/trust.js";

export const KIT_ENV = "HOBO_OPENSESAME_KIT";
export const TEST_BUILD_MARKER = "OPENSESAME_SURROGATE_TEST_UPSTREAM";

export type KitErrorCode =
	| "KIT_REQUIRED"
	| "KIT_INCOMPLETE"
	| "KIT_NOT_TEST_BUILD"
	| "KIT_UNTRUSTED";

export class KitError extends Error {
	readonly code: KitErrorCode;

	constructor(code: KitErrorCode, message: string) {
		super(message);
		this.name = "KitError";
		this.code = code;
	}
}

export type Kit = Readonly<{
	dir: string;
	opensesame: string;
	plugin: string;
	bridge: string;
}>;

export const BUILD_HELP = `build one with (from an OpenSesame checkout; CARGO_TARGET_DIR and CARGO_BUILD_JOBS to taste):
  cargo +1.88.0 build -p opensesame-cli --bin opensesame
  cargo +1.88.0 build -p opensesame-surrogate-proxy --features upstream-override --bin opensesame-surrogate-proxy
then copy both executables into the kit directory, copy packages/env-spec-bridge/bin/opensesame-env-parse.mjs to <kit>/bridge/ and put @env-spec/parser@0.4.1 in <kit>/bridge/node_modules.`;

/** What to do about a kit the adapter would refuse; the adapter's own message says why. */
const UNTRUSTED_HELP =
	'Every run hands OpenSesame OPENSESAME_ENV_PARSE=<kit>/bridge/opensesame-env-parse.mjs, and the adapter refuses a bridge that is not an absolute path in a place only you and root can write, outside the working directory\'s tree and not under node_modules/.bin, so every real run would be bridge_missing. Build the kit under "umask 022" (or run chmod -R go-w "$KIT"), at an absolute path outside the package directory';

export function resolveKit(
	env: NodeJS.ProcessEnv,
	trust: Trust = nodeTrust(),
): Kit {
	const dir = env[KIT_ENV];
	if (dir === undefined || dir === "") {
		throw new KitError(
			"KIT_REQUIRED",
			`${KIT_ENV} names the directory of a locally built OpenSesame kit and is not set; ${BUILD_HELP}`,
		);
	}
	const kit: Kit = {
		dir,
		opensesame: join(dir, "opensesame"),
		plugin: join(dir, "opensesame-surrogate-proxy"),
		bridge: join(dir, "bridge", "opensesame-env-parse.mjs"),
	};
	const wanted = [
		kit.opensesame,
		kit.plugin,
		kit.bridge,
		join(dir, "bridge", "node_modules", "@env-spec", "parser"),
	];
	const missing = wanted.filter((path) => !existsSync(path));
	if (missing.length > 0) {
		throw new KitError(
			"KIT_INCOMPLETE",
			`the kit at ${dir} lacks ${missing.map((path) => path.slice(dir.length + 1)).join(", ")}; ${BUILD_HELP}`,
		);
	}
	if (!isAbsolute(kit.bridge)) {
		throw new KitError(
			"KIT_UNTRUSTED",
			`${KIT_ENV} must be an absolute path (it is ${dir}): a relative one means the working directory. ${UNTRUSTED_HELP}`,
		);
	}
	const why = placeProblem(kit.bridge, trust);
	if (why !== undefined) {
		throw new KitError(
			"KIT_UNTRUSTED",
			`the kit's bridge cannot be used: ${why}. ${UNTRUSTED_HELP}`,
		);
	}
	if (!readFileSync(kit.plugin).includes(TEST_BUILD_MARKER)) {
		throw new KitError(
			"KIT_NOT_TEST_BUILD",
			`${kit.plugin} is not the plugin's test build (no ${TEST_BUILD_MARKER} in its bytes): a shipped build cannot be aimed at a loopback server, so this lane cannot use it`,
		);
	}
	return kit;
}
