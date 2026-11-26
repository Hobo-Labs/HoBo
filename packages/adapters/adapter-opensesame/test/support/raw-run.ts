import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProxiedRunOutcome } from "../../src/_generated/adapter_opensesame_pb.js";
import { parseOutcome } from "../../src/outcome.js";

/**
 * Run `opensesame dev --agent --schema <text> run -- true` with a schema the
 * adapter would never render (no scope), which is how the refusals of the
 * binary itself are reached. Returns how the adapter reads the end of it.
 */
export function runRawSchema(
	bin: string,
	env: NodeJS.ProcessEnv,
	schema: string,
): ProxiedRunOutcome {
	const dir = mkdtempSync(join(tmpdir(), "hobo-opensesame-raw-"));
	try {
		const file = join(dir, ".env.schema");
		writeFileSync(file, schema, { mode: 0o600 });
		const result = spawnSync(
			bin,
			["dev", "--agent", "--schema", file, "run", "--", "true"],
			{ env, encoding: "utf8", timeout: 120_000 },
		);
		return parseOutcome(result.status, result.signal, result.stderr);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A schema with an entry that declares no scope: the plugin must refuse to issue it. */
export const UNBOUNDED_SCHEMA = `# @defaultSensitive=false
# ---

# @required @sensitive
VERCEL_TOKEN=opensesameConnection(conn://acme/vercel, projection=legacy-token)
`;

/** A scope with paths but no methods: the schema must not parse. */
export const PATHS_WITHOUT_METHODS_SCHEMA = `# @defaultSensitive=false
# ---

# @required @sensitive
VERCEL_TOKEN=opensesameConnection(conn://acme/vercel, projection=legacy-token, paths="/v9/projects")
`;
