import {
	aiBddTimeoutMsOf,
	DEFAULT_AI_BDD_TIMEOUT_MS,
} from "./acceptance-config.js";
import { RELEASE_CHECK_IDS } from "./record-constraints.js";
import type { StageGateCheck, StageGateDefinition } from "./types.js";

const NODE = process.execPath;
const TSX_IMPORT = "--import";
const TSX = "tsx";

function nodeTsxScript(
	scriptPath: string,
	...args: readonly string[]
): readonly string[] {
	return [NODE, TSX_IMPORT, TSX, scriptPath, ...args];
}

export function defineStageGateS0(): StageGateDefinition {
	const scriptsRoot = "packages/stage-gate/scripts";
	const checks: StageGateCheck[] = [
		{
			checkId: "boundary-lint",
			kind: "lint",
			command: ["pnpm", "run", "lint:boundaries"],
		},
		{
			checkId: "architecture-guard",
			kind: "guard",
			command: ["pnpm", "run", "architecture:guard"],
		},
		{
			checkId: "schema-drift",
			kind: "schema",
			command: ["pnpm", "run", "test:schema"],
		},
		{
			checkId: "contract-consumer",
			kind: "contract",
			command: ["pnpm", "run", "test:contract:consumer"],
		},
		{
			checkId: "contract-provider",
			kind: "contract",
			command: ["pnpm", "run", "test:contract:provider"],
		},
		{
			checkId: "conformance-self-test",
			kind: "conformance",
			command: ["pnpm", "--filter", "@hobo/conformance", "test"],
		},
		{
			checkId: "hello-bindle-determinism",
			kind: "build",
			command: nodeTsxScript(
				`${scriptsRoot}/check-hello-bindle-determinism.mts`,
			),
		},
		{
			checkId: "hello-bindle-health",
			kind: "build",
			command: nodeTsxScript(`${scriptsRoot}/check-hello-bindle-health.mts`),
		},
		{
			checkId: "sign-provenance-verify",
			kind: "sign",
			command: nodeTsxScript(`${scriptsRoot}/check-sign-verify.mts`),
		},
		{
			checkId: "tampered-artifact-refused",
			kind: "verify",
			command: nodeTsxScript(`${scriptsRoot}/check-tamper-refuse.mts`),
		},
	];

	return {
		gateId: "s0",
		checks,
	};
}

/** ai-bdd exit code 3: infrastructure (driver or model unavailable, a scenario ended `error`). */
const AI_BDD_INFRASTRUCTURE = 3;

/** Beyond ai-bdd's own bound, the time a check takes to start, judge and stop. */
const CHECK_MARGIN_MS = 60_000;

/**
 * The release gate (ADR-0172): ai-bdd's three replay-only commands against the
 * project in `HOBO_AI_BDD_PROJECT`, run by `HOBO_AI_BDD_CMD` (a JSON argv,
 * default `["ai-bdd"]`). Each check needs the one before it to have passed,
 * and an infrastructure exit is `not_run`. Commands are relative to the
 * repository root, like the S0 gate's. Each check runs one ai-bdd command,
 * which check-acceptance bounds by HOBO_AI_BDD_TIMEOUT_MS; the runner's own
 * bound is that plus a margin, a backstop that stops the check with SIGTERM
 * (check-acceptance then passes SIGTERM on to ai-bdd's process group, and
 * SIGKILL after AI_BDD_GRACE_MS). The backstop is read from the env the
 * runner runs the checks with, the same env the checks read their bound from.
 */
export function defineReleaseGate(): StageGateDefinition {
	const script = "packages/stage-gate/scripts/check-acceptance.mts";
	const [plansFresh, replay, evidenceIntact] = RELEASE_CHECK_IDS;
	const notRunExitCodes = [AI_BDD_INFRASTRUCTURE];
	// An unusable value is the check's own usage error (exit 2); the backstop uses the default.
	const timeoutMs = (env: NodeJS.ProcessEnv): number =>
		(aiBddTimeoutMsOf(env) ?? DEFAULT_AI_BDD_TIMEOUT_MS) + CHECK_MARGIN_MS;
	return {
		gateId: "release",
		checks: [
			{
				checkId: plansFresh,
				kind: "acceptance",
				command: nodeTsxScript(script, "plans-fresh"),
				notRunExitCodes,
				timeoutMs,
			},
			{
				checkId: replay,
				kind: "acceptance",
				command: nodeTsxScript(script, "replay"),
				requires: [plansFresh],
				notRunExitCodes,
				timeoutMs,
			},
			{
				checkId: evidenceIntact,
				kind: "acceptance",
				command: nodeTsxScript(script, "evidence-intact"),
				requires: [replay],
				notRunExitCodes,
				timeoutMs,
			},
		],
	};
}
