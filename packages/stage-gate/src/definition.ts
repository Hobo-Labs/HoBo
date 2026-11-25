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

const AI_BDD_INFRASTRUCTURE = 3;

const CHECK_MARGIN_MS = 60_000;

export function defineReleaseGate(): StageGateDefinition {
	const script = "packages/stage-gate/scripts/check-acceptance.mts";
	const [plansFresh, replay, evidenceIntact] = RELEASE_CHECK_IDS;
	const notRunExitCodes = [AI_BDD_INFRASTRUCTURE];
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
