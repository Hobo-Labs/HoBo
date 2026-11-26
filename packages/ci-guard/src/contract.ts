import type { JsonValue } from "./json.js";

// public-contract: top-level `$schema` identity for CI fabric JSON validated by ci-guard.
export const CI_FABRIC_SCHEMA = "hobo.ciFabric/v1" as const;

const REQUIRED_PR_CHECKS = [
	"build",
	"typecheck",
	"lint",
	"unit",
	"conformance",
] as const;

export type RequiredPrCheck = (typeof REQUIRED_PR_CHECKS)[number];

export interface ArtifactCacheEntry {
	readonly kind: "wasm" | "oci";
	readonly path: string;
	readonly keyFrom?: readonly string[];
}

// domain-view: readonly parse target narrowed to the RequiredPrCheck union; data-models/ci_fabric.proto PullRequestGate is its wire form.
export interface PullRequestGate {
	readonly blocksPullRequest: boolean;
	readonly requiredChecks: readonly RequiredPrCheck[];
}

export interface WorkflowContract {
	readonly name: string;
	readonly path: string;
	readonly triggers: {
		readonly pullRequest: boolean;
		readonly schedule: string;
		readonly workflowDispatch: boolean;
		readonly mergeGroup?: boolean;
	};
	readonly pullRequestGate: PullRequestGate;
	readonly artifactCache: {
		readonly entries: readonly ArtifactCacheEntry[];
	};
}

export interface E2eCostGate {
	readonly kind: "pull-request-label" | "schedule" | "manual";
	readonly label?: string;
	readonly cron?: string;
}

// domain-view: readonly parse target with required nested selector; data-models/ci_fabric.proto CloudRole is its wire form.
export interface CloudRole {
	readonly name: string;
	readonly allowedActions: readonly string[];
	readonly resourceSelector: {
		readonly fixture: string;
		readonly runLabel: string;
	};
}

export interface E2eAuth {
	readonly mode: "oidc-federation";
	readonly audience: string;
	readonly tokenBroker: string;
	readonly forbidsStoredSecrets: boolean;
	readonly allowedTrustDomain: string;
	readonly cloudRole: CloudRole;
}

export interface E2eTeardown {
	readonly command: string;
	readonly always: boolean;
	readonly orphanSweeper: {
		readonly enabled: boolean;
		readonly maxAgeMinutes: number;
		readonly selector: string;
	};
}

export interface E2eQuarantine {
	readonly label: string;
	readonly lane: string;
	readonly continueOnError: boolean;
	readonly blocksPullRequest: boolean;
}

export interface EnvVars {
	readonly [key: string]: string;
}

export interface E2eContract {
	readonly name: string;
	readonly fixture: string;
	readonly permissions: {
		readonly contents: "read";
		readonly "id-token": "write";
	};
	readonly env: EnvVars;
	readonly gatedBy: readonly E2eCostGate[];
	readonly auth: E2eAuth;
	readonly deploy: {
		readonly command: string;
		readonly asserts: readonly string[];
	};
	readonly teardown: E2eTeardown;
	readonly quarantine: E2eQuarantine;
}

// domain-view: readonly parse-produced aggregate pinned to the literal CI_FABRIC_SCHEMA; data-models/ci_fabric.proto CiFabricContract is its wire form.
export interface CiFabricContract {
	readonly schema: typeof CI_FABRIC_SCHEMA;
	readonly workflow: WorkflowContract;
	readonly e2e: E2eContract;
}

export interface CiFabricErrorDetails {
	readonly schema?: JsonValue;
	readonly violations?: readonly {
		readonly code: string;
		readonly message: string;
	}[];
}

export class CiFabricContractError extends Error {
	readonly code: string;
	readonly details: CiFabricErrorDetails;

	constructor(
		code: string,
		message: string,
		details: CiFabricErrorDetails = {},
	) {
		super(message);
		this.name = "CiFabricContractError";
		this.code = code;
		this.details = details;
	}
}

export function createHoboCiFabricContract(
	overrides: DeepPartial<CiFabricContract> = {},
): CiFabricContract {
	const base: CiFabricContract = {
		schema: CI_FABRIC_SCHEMA,
		workflow: {
			name: "hobo-ci",
			path: ".github/workflows/hobo-ci.yml",
			triggers: {
				pullRequest: true,
				schedule: "17 3 * * 1",
				workflowDispatch: true,
				mergeGroup: true,
			},
			pullRequestGate: {
				blocksPullRequest: true,
				requiredChecks: [...REQUIRED_PR_CHECKS],
			},
			artifactCache: {
				entries: [
					{
						kind: "wasm",
						path: "~/.cache/hobo/wasm",
						keyFrom: [
							"pnpm-lock.yaml",
							"packages/**/package.json",
							"wit/**/*.wit",
						],
					},
					{
						kind: "oci",
						path: "~/.cache/hobo/oci",
						keyFrom: [
							"pnpm-lock.yaml",
							"packages/**/package.json",
							"packages/**/src/**",
						],
					},
				],
			},
		},
		e2e: {
			name: "hello-bindle-e2e",
			fixture: "examples/hello-bindle",
			permissions: {
				contents: "read",
				"id-token": "write",
			},
			env: {},
			gatedBy: [
				{ kind: "pull-request-label", label: "hobo/e2e" },
				{ kind: "schedule", cron: "17 3 * * 1" },
				{ kind: "manual" },
			],
			auth: {
				mode: "oidc-federation",
				audience: "hobo:sandbox-cloud",
				tokenBroker: "https://sandbox.yard.example/.well-known/hobo/oidc/token",
				forbidsStoredSecrets: true,
				allowedTrustDomain: "spiffe://sandbox.yard/ci/github/hobo-labs/hobo",
				cloudRole: {
					name: "hobo-ci-hello-bindle-e2e",
					allowedActions: [
						"deployments:create",
						"deployments:read",
						"deployments:delete",
					],
					resourceSelector: {
						fixture: "hello-bindle",
						runLabel: "hobo.dev/github-run-id",
					},
				},
			},
			deploy: {
				command: "simulate up examples/hello-bindle --camp sandbox-ci",
				asserts: [
					"live-url.https",
					"live-url.http-2xx",
					"fixture.hello-bindle",
				],
			},
			teardown: {
				command: "simulate down examples/hello-bindle --camp sandbox-ci",
				always: true,
				orphanSweeper: {
					enabled: true,
					maxAgeMinutes: 60,
					selector: "hobo.dev/fixture=hello-bindle",
				},
			},
			quarantine: {
				label: "hobo/e2e-quarantine",
				lane: "hello-bindle-fixture-quarantine",
				continueOnError: true,
				blocksPullRequest: false,
			},
		},
	};

	return freezeContract(mergeContract(base, overrides));
}

type DeepPartial<T> = {
	readonly [K in keyof T]?: T[K] extends readonly (infer U)[]
		? readonly U[]
		: T[K] extends object
			? DeepPartial<T[K]>
			: T[K];
};

function mergeContract(
	base: CiFabricContract,
	overrides: DeepPartial<CiFabricContract>,
): CiFabricContract {
	return {
		schema: overrides.schema ?? base.schema,
		workflow: mergeWorkflow(base.workflow, overrides.workflow),
		e2e: mergeE2e(base.e2e, overrides.e2e),
	};
}

function mergeWorkflow(
	base: WorkflowContract,
	overrides: DeepPartial<WorkflowContract> | undefined,
): WorkflowContract {
	const triggers = overrides?.triggers;
	const gate = overrides?.pullRequestGate;
	const cache = overrides?.artifactCache;
	const mergeGroup = triggers?.mergeGroup ?? base.triggers.mergeGroup;
	return {
		name: overrides?.name ?? base.name,
		path: overrides?.path ?? base.path,
		triggers:
			mergeGroup === undefined
				? {
						pullRequest: triggers?.pullRequest ?? base.triggers.pullRequest,
						schedule: triggers?.schedule ?? base.triggers.schedule,
						workflowDispatch:
							triggers?.workflowDispatch ?? base.triggers.workflowDispatch,
					}
				: {
						pullRequest: triggers?.pullRequest ?? base.triggers.pullRequest,
						schedule: triggers?.schedule ?? base.triggers.schedule,
						workflowDispatch:
							triggers?.workflowDispatch ?? base.triggers.workflowDispatch,
						mergeGroup,
					},
		pullRequestGate: {
			blocksPullRequest:
				gate?.blocksPullRequest ?? base.pullRequestGate.blocksPullRequest,
			requiredChecks: [
				...(gate?.requiredChecks ?? base.pullRequestGate.requiredChecks),
			],
		},
		artifactCache: {
			entries: (cache?.entries ?? base.artifactCache.entries).map(
				cloneArtifactEntry,
			),
		},
	};
}

function cloneArtifactEntry(entry: ArtifactCacheEntry): ArtifactCacheEntry {
	if (entry.keyFrom === undefined) {
		return { kind: entry.kind, path: entry.path };
	}
	return { kind: entry.kind, path: entry.path, keyFrom: [...entry.keyFrom] };
}

function mergeE2e(
	base: E2eContract,
	overrides: DeepPartial<E2eContract> | undefined,
): E2eContract {
	const permissions = overrides?.permissions;
	const deploy = overrides?.deploy;
	return {
		name: overrides?.name ?? base.name,
		fixture: overrides?.fixture ?? base.fixture,
		permissions: {
			contents: permissions?.contents ?? base.permissions.contents,
			"id-token": permissions?.["id-token"] ?? base.permissions["id-token"],
		},
		env: mergeEnv(base.env, overrides?.env),
		gatedBy: [...(overrides?.gatedBy ?? base.gatedBy)],
		auth: mergeAuth(base.auth, overrides?.auth),
		deploy: {
			command: deploy?.command ?? base.deploy.command,
			asserts: [...(deploy?.asserts ?? base.deploy.asserts)],
		},
		teardown: mergeTeardown(base.teardown, overrides?.teardown),
		quarantine: mergeQuarantine(base.quarantine, overrides?.quarantine),
	};
}

function mergeEnv(
	base: EnvVars,
	overrides: DeepPartial<EnvVars> | undefined,
): EnvVars {
	const env: { [key: string]: string } = {};
	for (const [key, value] of Object.entries(base)) {
		env[key] = value;
	}
	if (overrides === undefined) {
		return env;
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	return env;
}

function mergeAuth(
	base: E2eAuth,
	overrides: DeepPartial<E2eAuth> | undefined,
): E2eAuth {
	const role = overrides?.cloudRole;
	const selector = role?.resourceSelector;
	return {
		mode: overrides?.mode ?? base.mode,
		audience: overrides?.audience ?? base.audience,
		tokenBroker: overrides?.tokenBroker ?? base.tokenBroker,
		forbidsStoredSecrets:
			overrides?.forbidsStoredSecrets ?? base.forbidsStoredSecrets,
		allowedTrustDomain:
			overrides?.allowedTrustDomain ?? base.allowedTrustDomain,
		cloudRole: {
			name: role?.name ?? base.cloudRole.name,
			allowedActions: [
				...(role?.allowedActions ?? base.cloudRole.allowedActions),
			],
			resourceSelector: {
				fixture: selector?.fixture ?? base.cloudRole.resourceSelector.fixture,
				runLabel:
					selector?.runLabel ?? base.cloudRole.resourceSelector.runLabel,
			},
		},
	};
}

function mergeTeardown(
	base: E2eTeardown,
	overrides: DeepPartial<E2eTeardown> | undefined,
): E2eTeardown {
	const sweeper = overrides?.orphanSweeper;
	return {
		command: overrides?.command ?? base.command,
		always: overrides?.always ?? base.always,
		orphanSweeper: {
			enabled: sweeper?.enabled ?? base.orphanSweeper.enabled,
			maxAgeMinutes: sweeper?.maxAgeMinutes ?? base.orphanSweeper.maxAgeMinutes,
			selector: sweeper?.selector ?? base.orphanSweeper.selector,
		},
	};
}

function mergeQuarantine(
	base: E2eQuarantine,
	overrides: DeepPartial<E2eQuarantine> | undefined,
): E2eQuarantine {
	return {
		label: overrides?.label ?? base.label,
		lane: overrides?.lane ?? base.lane,
		continueOnError: overrides?.continueOnError ?? base.continueOnError,
		blocksPullRequest: overrides?.blocksPullRequest ?? base.blocksPullRequest,
	};
}

function freezeContract(contract: CiFabricContract): CiFabricContract {
	Object.freeze(contract.workflow.triggers);
	Object.freeze(contract.workflow.pullRequestGate.requiredChecks);
	Object.freeze(contract.workflow.pullRequestGate);
	for (const entry of contract.workflow.artifactCache.entries) {
		if (entry.keyFrom !== undefined) {
			Object.freeze(entry.keyFrom);
		}
		Object.freeze(entry);
	}
	Object.freeze(contract.workflow.artifactCache.entries);
	Object.freeze(contract.workflow.artifactCache);
	Object.freeze(contract.workflow);
	Object.freeze(contract.e2e.permissions);
	Object.freeze(contract.e2e.env);
	Object.freeze(contract.e2e.gatedBy);
	Object.freeze(contract.e2e.auth.cloudRole.allowedActions);
	Object.freeze(contract.e2e.auth.cloudRole.resourceSelector);
	Object.freeze(contract.e2e.auth.cloudRole);
	Object.freeze(contract.e2e.auth);
	Object.freeze(contract.e2e.deploy.asserts);
	Object.freeze(contract.e2e.deploy);
	Object.freeze(contract.e2e.teardown.orphanSweeper);
	Object.freeze(contract.e2e.teardown);
	Object.freeze(contract.e2e.quarantine);
	Object.freeze(contract.e2e);
	return Object.freeze(contract);
}

export { REQUIRED_PR_CHECKS };
