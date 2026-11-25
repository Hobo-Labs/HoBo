import { isJsonObject, type JsonObject } from "./json.js";
export const FIXTURE_ID = "dx.lifecycle.hello-bindle.v1" as const;
export const BINDLE = "examples/hello-bindle" as const;
export const PROOF_NOTE = "docs/design/proofs/cli-cloud-yard-path/README.md" as const;

export const GATEWAY_ROUTES = [
  "POST /v1/auth/login",
  "POST /v1/commands/plan",
  "POST /v1/commands/deploy",
  "POST /v1/commands/destroy",
  "GET /v1/projections/deploy/:id",
  "GET /v1/streams/logs/:deploymentId",
] as const;

export const CLOUD_COMMANDS = [
  "login",
  "plan",
  "deploy",
  "destroy",
  "inspect deploy",
  "logs",
] as const;

export type CloudCommand = (typeof CLOUD_COMMANDS)[number];
export type CommandStatus = "success" | "blocked" | "error";
export type ProofMode = "reference-fixture" | "simulated";

export type ActionableError = {
  readonly code: string;
  readonly cause: string;
  readonly remediation: readonly [string, string, ...string[]];
  readonly correlationId: string;
};

export type LoginResult = {
  readonly svid: string;
  readonly scopes: readonly string[];
  readonly proofMode: ProofMode;
};

export type PlanWarning = {
  readonly code: string;
  readonly message: string;
};

export type PlanResult = {
  readonly deploymentPlanId: string;
  readonly warnings: readonly PlanWarning[];
  readonly status: CommandStatus;
  readonly error?: ActionableError;
};

export type DeployResult = {
  readonly deploymentId: string;
  readonly deploymentSetId: string;
  readonly status: CommandStatus;
  readonly error?: ActionableError;
};

export type DestroyResult = {
  readonly deploymentId: string;
  readonly status: CommandStatus;
  readonly error?: ActionableError;
};

export type InspectDeployResult = {
  readonly deploymentId: string;
  readonly projectionSeq: number;
  readonly state: string;
  readonly status: CommandStatus;
  readonly error?: ActionableError;
};

export type LogLine = {
  readonly stream: string;
  readonly message: string;
  readonly timestamp: string;
};

export type LogsResult = {
  readonly lines: readonly LogLine[];
  readonly status: CommandStatus;
  readonly error?: ActionableError;
};

export type JourneyStep = {
  readonly command: `hobo ${CloudCommand}`;
  readonly status: CommandStatus;
  readonly fixtureId: typeof FIXTURE_ID;
};

// domain-view: parse-produced draft-proof record; its wire form is the CliCloudYardPathRecord proto message in data-models/.
export type CliCloudYardPathRecord = {
  readonly issue: "HOBO-625";
  readonly phase: "M1";
  readonly fixtureId: typeof FIXTURE_ID;
  readonly bindle: typeof BINDLE;
  readonly proofNote: typeof PROOF_NOTE;
  readonly j1Journey: readonly JourneyStep[];
  readonly gatewayRoutes: readonly (typeof GATEWAY_ROUTES)[number][];
  readonly scopeOut: readonly string[];
};

type GatewayRequest =
  | { route: "POST /v1/auth/login"; body: { mode: "dev-svid-stub"; bindle: string } }
  | {
      route: "POST /v1/commands/plan";
      authorization: string;
      body: { bindle: string; camp: string; fixtureId: string; deploymentPlanId?: string };
    }
  | {
      route: "POST /v1/commands/deploy";
      authorization: string;
      body: { deploymentPlanId: string; bindle: string };
    }
  | {
      route: "POST /v1/commands/destroy";
      authorization: string;
      body: { deploymentId: string; bindle: string };
    }
  | { route: "GET /v1/projections/deploy/:id"; authorization: string; deploymentId: string }
  | { route: "GET /v1/streams/logs/:deploymentId"; authorization: string; deploymentId: string };

type GatewayResponse =
  | { status: 200 | 202; body: JsonObject }
  | { status: 401 | 403 | 404; body: { status: CommandStatus; error: ActionableError } };

const SESSION = {
  svid: "svid-dev-hello-bindle",
  scopes: ["deploy:write", "projection:read", "logs:read"],
} as const;

const DEPLOYMENT = {
  id: "deploy-hello-bindle-001",
  deploymentSetId: "deployment-set.hello-bindle.v1",
  planId: "deployment-plan.hello-bindle.v1",
  projectionSeq: 42,
  state: "ready",
} as const;

export function createYardGateway() {
  let destroyed = false;

  return {
    request(input: GatewayRequest): GatewayResponse {
      switch (input.route) {
        case "POST /v1/auth/login":
          return {
            status: 200,
            body: {
              svid: SESSION.svid,
              scopes: [...SESSION.scopes],
              proofMode: "reference-fixture",
            },
          };

        case "POST /v1/commands/plan": {
          if (!isAuthorized(input.authorization)) {
            return unauthorized("corr-hobo-625-plan-auth");
          }
          if (input.body.deploymentPlanId === "deployment-plan.gatekeeper-denied") {
            return gatekeeperDenied("corr-hobo-625-plan-gatekeeper");
          }
          return {
            status: 200,
            body: {
              deploymentPlanId: DEPLOYMENT.planId,
              warnings: [
                {
                  code: "plan.cross-camp-hop",
                  message:
                    "hello-bindle routes through a cross-camp hop in the reference fixture.",
                },
              ],
              status: "success",
            },
          };
        }

        case "POST /v1/commands/deploy": {
          if (!isAuthorized(input.authorization)) {
            return unauthorized("corr-hobo-625-deploy-auth");
          }
          if (input.body.deploymentPlanId === "deployment-plan.gatekeeper-denied") {
            return gatekeeperDenied("corr-hobo-625-gatekeeper-denied");
          }
          if (destroyed) {
            return {
              status: 404,
              body: {
                status: "error",
                error: actionableError({
                  code: "deploy.destroyed",
                  cause: "Deployment target was destroyed and cannot be redeployed without a fresh plan.",
                  remediation: [
                    "Run hobo plan against examples/hello-bindle to produce a new DeploymentPlan.",
                    "Retry hobo deploy with the refreshed deploymentPlanId from plan output.",
                  ],
                  correlationId: "corr-hobo-625-destroyed",
                }),
              },
            };
          }
          return {
            status: 202,
            body: {
              deploymentId: DEPLOYMENT.id,
              deploymentSetId: DEPLOYMENT.deploymentSetId,
              status: "success",
            },
          };
        }

        case "POST /v1/commands/destroy": {
          if (!isAuthorized(input.authorization)) {
            return unauthorized("corr-hobo-625-destroy-auth");
          }
          destroyed = true;
          return {
            status: 202,
            body: {
              deploymentId: input.body.deploymentId,
              status: "success",
            },
          };
        }

        case "GET /v1/projections/deploy/:id": {
          if (!isAuthorized(input.authorization)) {
            return unauthorized("corr-hobo-625-inspect-auth");
          }
          if (input.deploymentId === "deploy-stale-evidence") {
            return {
              status: 403,
              body: {
                status: "blocked",
                error: actionableError({
                  code: "projection.stale",
                  cause: "Deployment evidence is older than the accepted freshness window.",
                  remediation: [
                    "Wait for the Yard projection host to catch up or rerun hobo inspect deploy.",
                    "Attach correlation id corr-hobo-625-stale to a support-safe bundle if the lag persists.",
                  ],
                  correlationId: "corr-hobo-625-stale",
                }),
              },
            };
          }
          if (destroyed) {
            return {
              status: 404,
              body: {
                status: "error",
                error: actionableError({
                  code: "projection.not-found",
                  cause: "No deployment projection exists for the requested id after destroy.",
                  remediation: [
                    "Confirm the deployment id from hobo deploy --json output.",
                    "Run hobo deploy again if the topology should be live.",
                  ],
                  correlationId: "corr-hobo-625-projection-missing",
                }),
              },
            };
          }
          return {
            status: 200,
            body: {
              deploymentId: DEPLOYMENT.id,
              projectionSeq: DEPLOYMENT.projectionSeq,
              state: DEPLOYMENT.state,
              status: "success",
            },
          };
        }

        case "GET /v1/streams/logs/:deploymentId": {
          if (!isAuthorized(input.authorization)) {
            return unauthorized("corr-hobo-625-logs-auth");
          }
          return {
            status: 200,
            body: {
              lines: [
                {
                  stream: "stdout",
                  message: "hello-bindle service ready on local-yard",
                  timestamp: "2026-07-01T12:00:00.000Z",
                },
                {
                  stream: "event",
                  message: "resource.api.provisioned deployment-set.hello-bindle.v1",
                  timestamp: "2026-07-01T12:00:01.000Z",
                },
              ],
              status: "success",
            },
          };
        }
      }
    },
  };
}

export type YardGateway = ReturnType<typeof createYardGateway>;

export function formatActionableError(error: ActionableError) {
  return {
    code: error.code,
    cause: error.cause,
    remediation: [...error.remediation],
    correlationId: error.correlationId,
    human: [
      `blocked: ${error.code}`,
      `cause: ${error.cause}`,
      `next: ${error.remediation[0]}`,
      `then: ${error.remediation[1]}`,
      `correlation: ${error.correlationId}`,
    ].join("\n"),
    json: error,
  };
}

export function runHoboLogin(gateway: YardGateway, options: { bindle?: string } = {}) {
  const response = gateway.request({
    route: "POST /v1/auth/login",
    body: { mode: "dev-svid-stub", bindle: options.bindle ?? BINDLE },
  });
  assertSuccessStatus(response.status, "login");
  // SAFETY: `const body = response.body as LoginResult;` is required at this I/O or test boundary.
  const body = response.body as LoginResult;
  return {
    command: "hobo login" as const,
    exitCode: 0 as const,
    result: body,
    stdout: `logged in with dev SVID ${body.svid} (${body.scopes.join(", ")})`,
  };
}

export function runHoboPlan(
  gateway: YardGateway,
  input: { authorization: string; camp?: string; deploymentPlanId?: string },
) {
  const response = gateway.request({
    route: "POST /v1/commands/plan",
    authorization: input.authorization,
    body: {
      bindle: BINDLE,
      camp: input.camp ?? "local-yard",
      fixtureId: FIXTURE_ID,
      deploymentPlanId: input.deploymentPlanId,
    },
  });

  if (response.status === 401 || response.status === 403) {
    return blockedCliResult("hobo plan", response.body.error);
  }
  assertSuccessStatus(response.status, "plan");

  // SAFETY: `const body = response.body as PlanResult;` is required at this I/O or test boundary.
  const body = response.body as PlanResult;
  return {
    command: "hobo plan" as const,
    exitCode: 0 as const,
    result: body,
    stdout: [
      `DeploymentPlan: ${body.deploymentPlanId}`,
      ...body.warnings.map((warning) => `warning[${warning.code}]: ${warning.message}`),
    ].join("\n"),
  };
}

export function runHoboDeploy(
  gateway: YardGateway,
  input: { authorization: string; deploymentPlanId: string },
) {
  const response = gateway.request({
    route: "POST /v1/commands/deploy",
    authorization: input.authorization,
    body: { deploymentPlanId: input.deploymentPlanId, bindle: BINDLE },
  });

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return blockedCliResult("hobo deploy", response.body.error);
  }
  assertSuccessStatus(response.status, "deploy");

  // SAFETY: `const body = response.body as DeployResult;` is required at this I/O or test boundary.
  const body = response.body as DeployResult;
  return {
    command: "hobo deploy" as const,
    exitCode: 0 as const,
    result: body,
    stdout: `deployed ${body.deploymentId} via ${body.deploymentSetId}`,
  };
}

export function runHoboDestroy(
  gateway: YardGateway,
  input: { authorization: string; deploymentId: string },
) {
  const response = gateway.request({
    route: "POST /v1/commands/destroy",
    authorization: input.authorization,
    body: { deploymentId: input.deploymentId, bindle: BINDLE },
  });

  if (response.status === 401 || response.status === 403) {
    return blockedCliResult("hobo destroy", response.body.error);
  }
  assertSuccessStatus(response.status, "destroy");

  // SAFETY: `const body = response.body as DestroyResult;` is required at this I/O or test boundary.
  const body = response.body as DestroyResult;
  return {
    command: "hobo destroy" as const,
    exitCode: 0 as const,
    result: body,
    stdout: `destroyed ${body.deploymentId}`,
  };
}

export function runHoboInspectDeploy(
  gateway: YardGateway,
  input: { authorization: string; deploymentId: string },
) {
  const response = gateway.request({
    route: "GET /v1/projections/deploy/:id",
    authorization: input.authorization,
    deploymentId: input.deploymentId,
  });

  if (response.status === 403 || response.status === 404) {
    return blockedCliResult("hobo inspect deploy", response.body.error);
  }
  assertSuccessStatus(response.status, "inspect deploy");

  // SAFETY: `const body = response.body as InspectDeployResult;` is required at this I/O or test boundary.
  const body = response.body as InspectDeployResult;
  return {
    command: "hobo inspect deploy" as const,
    exitCode: 0 as const,
    result: body,
    stdout: `deployment ${body.deploymentId} ${body.state} at projection seq ${body.projectionSeq}`,
  };
}

export function runHoboLogs(
  gateway: YardGateway,
  input: { authorization: string; deploymentId: string; follow?: boolean },
) {
  const response = gateway.request({
    route: "GET /v1/streams/logs/:deploymentId",
    authorization: input.authorization,
    deploymentId: input.deploymentId,
  });

  if (response.status === 401) {
    return blockedCliResult("hobo logs", response.body.error);
  }
  assertSuccessStatus(response.status, "logs");

  // SAFETY: `const body = response.body as LogsResult;` is required at this I/O or test boundary.
  const body = response.body as LogsResult;
  return {
    command: "hobo logs" as const,
    exitCode: 0 as const,
    result: body,
    stdout: body.lines.map((line) => `[${line.stream}] ${line.message}`).join("\n"),
  };
}

export function runJ1HelloBindleJourney(gateway: YardGateway = createYardGateway()) {
  const login = runHoboLogin(gateway);
  const authorization = `Bearer ${login.result.svid}`;
  const plan = runHoboPlan(gateway, { authorization });
  const deploy = runHoboDeploy(gateway, {
    authorization,
    deploymentPlanId: plan.result.deploymentPlanId,
  });
  const inspect = runHoboInspectDeploy(gateway, {
    authorization,
    deploymentId: deploy.result.deploymentId,
  });

  const steps: JourneyStep[] = [
    step("login", login.exitCode === 0 ? "success" : "error"),
    step("plan", plan.exitCode === 0 ? "success" : "error"),
    step("deploy", deploy.exitCode === 0 ? "success" : "error"),
    step("inspect deploy", inspect.exitCode === 0 ? "success" : "error"),
  ];

  return {
    fixtureId: FIXTURE_ID,
    bindle: BINDLE,
    login,
    plan,
    deploy,
    inspect,
    steps,
    ok: steps.every((journeyStep) => journeyStep.status === "success"),
  };
}

export function runFullCloudCommandSurface(gateway: YardGateway = createYardGateway()) {
  const journey = runJ1HelloBindleJourney(gateway);
  const authorization = `Bearer ${journey.login.result.svid}`;
  const logs = runHoboLogs(gateway, {
    authorization,
    deploymentId: journey.deploy.result.deploymentId,
    follow: true,
  });
  const destroy = runHoboDestroy(gateway, {
    authorization,
    deploymentId: journey.deploy.result.deploymentId,
  });

  return {
    ...journey,
    logs,
    destroy,
    commands: [...CLOUD_COMMANDS],
  };
}

export function createCliCloudYardPathRecord(): CliCloudYardPathRecord {
  return deepFreeze({
    issue: "HOBO-625",
    phase: "M1",
    fixtureId: FIXTURE_ID,
    bindle: BINDLE,
    proofNote: PROOF_NOTE,
    j1Journey: [
      step("login", "success"),
      step("plan", "success"),
      step("deploy", "success"),
      step("inspect deploy", "success"),
    ],
    gatewayRoutes: [...GATEWAY_ROUTES],
    scopeOut: [
      "No production packages/cli binary.",
      "No live Yard process or real cloud provider.",
      "No merged packages/cloud Gateway implementation.",
      "No real OIDC login or credential storage.",
    ],
  });
}

export function validateActionableError(error: ActionableError) {
  const errors: string[] = [];
  if (!error.code) {
    errors.push("actionable error requires code");
  }
  if (!error.cause) {
    errors.push("actionable error requires cause");
  }
  if (!Array.isArray(error.remediation) || error.remediation.length < 2) {
    errors.push("NFR-017 requires at least two remediation steps");
  }
  if (!error.correlationId) {
    errors.push("actionable error requires correlation id");
  }
  return { ok: errors.length === 0, errors };
}

export function validateCliCloudYardPathRecord(record: CliCloudYardPathRecord) {
  const errors: string[] = [];

  if (record.issue !== "HOBO-625") {
    errors.push("issue must be HOBO-625");
  }
  if (record.fixtureId !== FIXTURE_ID) {
    errors.push(`fixture id must be ${FIXTURE_ID}`);
  }
  if (record.bindle !== BINDLE) {
    errors.push(`bindle must be ${BINDLE}`);
  }
  if (record.j1Journey.length !== 4) {
    errors.push("J1 journey must include login, plan, deploy, inspect deploy");
  }
  if (record.gatewayRoutes.length < GATEWAY_ROUTES.length) {
    errors.push("gateway routes must cover the cloud command path");
  }

  return { ok: errors.length === 0, errors };
}

export function rejectCloudPathScopeCreep(requests: readonly string[]) {
  return requests.flatMap((request) => {
    const reason = forbiddenReason(request);
    return reason ? [{ decision: "reject" as const, reason, request }] : [];
  });
}

function step(command: CloudCommand, status: CommandStatus): JourneyStep {
  return {
    command: `hobo ${command}`,
    status,
    fixtureId: FIXTURE_ID,
  };
}

function isAuthorized(authorization: string) {
  return authorization === `Bearer ${SESSION.svid}`;
}

function unauthorized(correlationId: string): GatewayResponse {
  return {
    status: 401,
    body: {
      status: "error",
      error: actionableError({
        code: "auth.missing-svid",
        cause: "Gateway rejected the request because no dev SVID was presented.",
        remediation: [
          "Run hobo login to obtain the dev SVID stub for the local Yard.",
          "Retry the command with Authorization: Bearer <svid> from login output.",
        ],
        correlationId,
      }),
    },
  };
}

function gatekeeperDenied(correlationId: string): GatewayResponse {
  return {
    status: 403,
    body: {
      status: "blocked",
      error: actionableError({
        code: "gatekeeper.denied",
        cause: "Gatekeeper denied deploy because policy pack spend-limit blocked provider dispatch.",
        remediation: [
          "Run hobo plan --json and review the Gatekeeper decision id in the output.",
          "Request a policy waiver or deploy to a camp inside the allowed spend envelope.",
        ],
        correlationId,
      }),
    },
  };
}

function actionableError(input: {
  code: string;
  cause: string;
  remediation: [string, string, ...string[]];
  correlationId: string;
}): ActionableError {
  return deepFreeze(input);
}

function blockedCliResult(command: `hobo ${CloudCommand}`, error: ActionableError) {
  const formatted = formatActionableError(error);
  return {
    command,
    exitCode: 1 as const,
    error: formatted.json,
    stdout: formatted.human,
  };
}

function assertSuccessStatus(status: number, label: string): asserts status is 200 | 202 {
  if (status !== 200 && status !== 202) {
    throw new Error(`${label} expected success status, received ${status}`);
  }
}

function forbiddenReason(request: string) {
  if (/\bproduction packages\/cli\b|\blive yard\b|\breal cloud\b/i.test(request)) {
    return "production CLI or live Yard execution is out of scope";
  }
  if (/credential store|real oidc|production gateway/i.test(request)) {
    return "real auth and production Gateway are out of scope";
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  // SAFETY: `for (const child of Object.values(value as JsonObject)) {` is required at this I/O or test boundary.
  for (const child of Object.values(value as JsonObject)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
