/**
 * The real call path this proof exercises: preflight → deploy → parse.
 *
 * Everything untrusted (caller input, ambient env, executor response) crosses
 * src/parse.ts first, so this module only ever handles parsed derived types.
 * The lifecycle follows #ShipTransitions in architecture/deploy_adapter.cue,
 * and refusal is fail-closed: no credentials means no deploy attempt, never a
 * silent mock.
 */
import {
	type ConvexSpawn,
	deployConvexApp,
	describeWorkOsAuthKit,
} from "@hobo/provider-convex";

import {
	assertShipTransition,
	type ConvexAppRoot,
	type DeployMode,
	type DeploymentName,
	type DeployReceipt,
	type DeployRequest,
	parseConvexAppRoot,
	parseDeploymentName,
	parseDeployReceipt,
	parseDeployRequest,
	parseShipPreflight,
	type ShipPreflight,
} from "./parse.ts";

/** Default deployment name in packages/providers/provider-convex/src/deploy.ts. */
export const DEFAULT_DEPLOYMENT_NAME = "hobo-swaghaus";

export type ShipInput = {
	readonly root: string;
	readonly deploymentName?: string;
	readonly mock?: boolean;
	readonly deployKey?: string;
	readonly selfHostedUrl?: string;
	readonly selfHostedAdminKey?: string;
	/** Presence-only env source for the WorkOS AuthKit preflight. */
	readonly env?: Record<string, string | undefined>;
	readonly spawn?: ConvexSpawn;
};

export type ShipOutcome =
	| {
			readonly phase: "deployed";
			readonly request: DeployRequest;
			readonly preflight: ShipPreflight;
			readonly receipt: DeployReceipt;
		}
	| {
			readonly phase: "refused";
			readonly root: ConvexAppRoot;
			readonly deploymentName: DeploymentName;
			readonly preflight: ShipPreflight;
			readonly reason: string;
		};

function shipMode(input: ShipInput): DeployMode {
	if (input.mock) return "mock";
	return input.selfHostedUrl && input.selfHostedAdminKey
		? "self-hosted"
		: "cloud";
}

/**
 * Presence-only preflight: WorkOS AuthKit env from `describeWorkOsAuthKit`
 * plus the Convex deploy credential requirement. Names only — no values leave
 * this function, and none reach an event or a log line.
 */
export function preflightSwaghausShip(input: ShipInput): ShipPreflight {
	const mode = shipMode(input);
	const env = input.env ?? {};
	const workos = describeWorkOsAuthKit(env);
	const credentialed =
		Boolean(input.deployKey?.trim()) ||
		Boolean(input.selfHostedUrl?.trim() && input.selfHostedAdminKey?.trim());
	const missing = [
		...workos.missing,
		...(credentialed ? [] : ["CONVEX_DEPLOY_KEY"]),
	];
	const remediation = credentialed
		? workos.remediation
		: `${workos.remediation} Convex deploy credentials are broker-minted: supply CONVEX_DEPLOY_KEY, or CONVEX_SELF_HOSTED_URL plus CONVEX_SELF_HOSTED_ADMIN_KEY.`;

	return parseShipPreflight({ missing, remediation, mode });
}

/**
 * Ship a Convex app (swaghaus) through the thin provider executor.
 *
 * Phases: `requested` → `preflighted` → (`refused` | `deploying` → `deployed`).
 * The refusal happens on the preflight, so a `DeployRequest` — which by
 * construction carries either credentials or the explicit mock flag — is only
 * ever built for a ship that may proceed. The mock lane skips the credential
 * requirement but is marked `mocked` in the parsed receipt, so no caller can
 * mistake it for a real ship.
 */
export async function shipSwaghausConvexApp(
	input: ShipInput,
): Promise<ShipOutcome> {
	const root = parseConvexAppRoot(input.root);
	const deploymentName = parseDeploymentName(
		input.deploymentName ?? DEFAULT_DEPLOYMENT_NAME,
	);
	assertShipTransition("requested", "preflighted");

	const preflight = preflightSwaghausShip(input);
	if (preflight.mode !== "mock" && !preflight.live) {
		assertShipTransition("preflighted", "refused");
		return Object.freeze({
			phase: "refused" as const,
			root,
			deploymentName,
			preflight,
			reason: preflight.remediation,
		});
	}

	const request = parseDeployRequest({
		root,
		deploymentName,
		mock: preflight.mode === "mock",
		deployKey: input.deployKey,
		selfHostedUrl: input.selfHostedUrl,
		selfHostedAdminKey: input.selfHostedAdminKey,
	});
	assertShipTransition("preflighted", "deploying");
	const response = await deployConvexApp({
		root: request.root,
		deploymentName: request.deploymentName,
		...(request.mock ? { mock: true } : undefined),
		...(input.deployKey ? { deployKey: input.deployKey } : undefined),
		...(input.selfHostedUrl ? { selfHostedUrl: input.selfHostedUrl } : undefined),
		...(input.selfHostedAdminKey
			? { selfHostedAdminKey: input.selfHostedAdminKey }
			: undefined),
		...(input.spawn ? { spawn: input.spawn } : undefined),
	});
	assertShipTransition("deploying", "deployed");

	return Object.freeze({
		phase: "deployed" as const,
		request,
		preflight,
		receipt: parseDeployReceipt(response),
	});
}
