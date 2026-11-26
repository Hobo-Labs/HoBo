import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";

export const ALLOW_TRIPLE_EFFECTS_VERSION = "hobo.allow-triple-effects/v1";

type IamVerbMap = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
type JsonValue = null | boolean | number | string | readonly JsonValue[] | Readonly<Record<string, JsonValue>>;

const IAM_VERB_MAP = {
  "wasi:keyvalue": {
    get: ["dynamodb:GetItem", "dynamodb:BatchGetItem"],
    set: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
    delete: ["dynamodb:DeleteItem"],
  },
  "wasi:blobstore": {
    read: ["s3:GetObject", "s3:ListBucket"],
    write: ["s3:PutObject", "s3:DeleteObject"],
    delete: ["s3:DeleteObject"],
  },
  "wasi:messaging": {
    publish: ["sns:Publish"],
    subscribe: ["sns:Subscribe", "sqs:ReceiveMessage"],
  },
} satisfies IamVerbMap;

export type AllowDeclaration = Readonly<{
  resourceId: string;
  port: string;
  componentId: string;
  verbs: readonly string[];
  bindle?: string;
}>;

export type IamEffect = Readonly<{
  policyId: string;
  subject: string;
  actions: readonly string[];
  resourcePattern: string;
}>;

export type LinkTableEffect = Readonly<{
  componentId: string;
  import: string;
  to: string;
  allowedVerbs: readonly string[];
  denyByDefault: true;
}>;

export type TokenScopeCeiling = Readonly<{
  resource: string;
  port: string;
  verbs: readonly string[];
}>;

export type AllowTripleEffects = Readonly<{
  iam: IamEffect;
  linkTable: LinkTableEffect;
  tokenScopeCeiling: TokenScopeCeiling;
}>;

export type TokenScopeRequest = Readonly<{
  provider: string;
  scope: Readonly<{
    port: string;
    resource: string;
    action: string;
  }>;
}>;

export type TokenBrokerResult =
  | Readonly<{ ok: true; grantId: string; tokenRef: string; scopes: readonly string[]; auditEvent: ReturnType<typeof createIdentityEvent> }>
  | Readonly<{ ok: false; reason: string; auditEvent: ReturnType<typeof createIdentityEvent> }>;

export class AllowTripleEffectsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "AllowTripleEffectsError";
  }
}

export function compileAllowTripleEffects(
  declaration: AllowDeclaration,
  options: Readonly<{ provider?: string }> = {},
): AllowTripleEffects {
  assertDeclaration(declaration);

  const verbs = sortedUnique(declaration.verbs);
  const actions = mapVerbsToIamActions(declaration.port, verbs);
  const bindle = declaration.bindle ?? "bindle";
  const provider = options.provider ?? "aws";

  return Object.freeze({
    iam: Object.freeze({
      policyId: `${bindle}-${declaration.resourceId}-${verbs.join("-")}`,
      subject: `component:${declaration.componentId}`,
      actions,
      resourcePattern: iamResourcePattern(
        provider,
        declaration.port,
        bindle,
        declaration.resourceId,
      ),
    }),
    linkTable: Object.freeze({
      componentId: declaration.componentId,
      import: declaration.port,
      to: declaration.resourceId,
      allowedVerbs: verbs,
      denyByDefault: true as const,
    }),
    tokenScopeCeiling: Object.freeze({
      resource: declaration.resourceId,
      port: declaration.port,
      verbs,
    }),
  });
}

export function compileBindleAllowTriples(input: {
  bindle: string;
  componentId: string;
  declarations: readonly AllowDeclaration[];
  provider?: string;
}): readonly AllowTripleEffects[] {
  return Object.freeze(
    input.declarations.map((declaration) =>
      compileAllowTripleEffects(
        {
          ...declaration,
          bindle: input.bindle,
          componentId: input.componentId,
        },
        { provider: input.provider },
      ),
    ),
  );
}

export function assertGoldenTriple(
  actual: AllowTripleEffects,
  golden: AllowTripleEffects,
): void {
  assertDeepEqual(actual.iam, golden.iam, "iam");
  assertDeepEqual(actual.linkTable, golden.linkTable, "linkTable");
  assertDeepEqual(actual.tokenScopeCeiling, golden.tokenScopeCeiling, "tokenScopeCeiling");
}

export function createAllowScopedTokenBroker(
  ceilings: readonly TokenScopeCeiling[],
  options: Readonly<{ tenant?: string; actor?: { kind: string; id: string } }> = {},
) {
  const ceilingByResource = new Map(
    ceilings.map((ceiling) => [ceiling.resource, ceiling] as const),
  );
  const auditEvents: ReturnType<typeof createIdentityEvent>[] = [];

  return Object.freeze({
    requestToken(input: {
      requestId: string;
      subject: Readonly<{ kind: string; id: string; delegatedBy?: { kind: string; id: string } }>;
      request: TokenScopeRequest;
      correlationId?: string;
    }): TokenBrokerResult {
      const ceiling = ceilingByResource.get(input.request.scope.resource);
      const scopeKey = tokenScopeKey(input.request);

      if (!ceiling || ceiling.port !== input.request.scope.port) {
        const auditEvent = recordDenied({
          requestId: input.requestId,
          subject: input.subject,
          target: input.request.provider,
          reason: `resource ${input.request.scope.resource} is outside allow ceiling`,
          correlationId: input.correlationId,
          tenant: options.tenant,
          actor: options.actor,
        });
        auditEvents.push(auditEvent);
        return Object.freeze({ ok: false, reason: auditEvent.data.reason, auditEvent });
      }

      if (!ceiling.verbs.includes(input.request.scope.action)) {
        const auditEvent = recordDenied({
          requestId: input.requestId,
          subject: input.subject,
          target: input.request.provider,
          reason: `requested action ${input.request.scope.action} exceeds .allow() ceiling [${ceiling.verbs.join(", ")}]`,
          correlationId: input.correlationId,
          tenant: options.tenant,
          actor: options.actor,
        });
        auditEvents.push(auditEvent);
        return Object.freeze({ ok: false, reason: auditEvent.data.reason, auditEvent });
      }

      const grantId = `grant-${input.requestId}`;
      const auditEvent = createIdentityEvent(
        "token.Granted",
        {
          grantId,
          subject: input.subject,
          target: input.request.provider,
          audience: input.request.provider,
          scopes: [scopeKey],
          tokenRef: `tokenref://${grantId}`,
          expiresAt: "2026-07-01T13:00:00.000Z",
        },
        {
          tenant: options.tenant,
          actor: options.actor,
          correlationId: input.correlationId,
        },
      );
      validateIdentityEvent(auditEvent);
      auditEvents.push(auditEvent);

      return Object.freeze({
        ok: true,
        grantId,
        tokenRef: auditEvent.data.tokenRef,
        scopes: auditEvent.data.scopes,
        auditEvent,
      });
    },

    getAuditEvents(): readonly ReturnType<typeof createIdentityEvent>[] {
      return Object.freeze([...auditEvents]);
    },
  });
}

function recordDenied(input: {
  requestId: string;
  subject: Readonly<{ kind: string; id: string; delegatedBy?: { kind: string; id: string } }>;
  target: string;
  reason: string;
  correlationId?: string;
  tenant?: string;
  actor?: { kind: string; id: string };
}) {
  const auditEvent = createIdentityEvent(
    "token.Denied",
    {
      requestId: input.requestId,
      subject: input.subject,
      target: input.target,
      reason: input.reason,
    },
    {
      tenant: input.tenant,
      actor: input.actor,
      correlationId: input.correlationId,
    },
  );
  validateIdentityEvent(auditEvent);
  return auditEvent;
}

function mapVerbsToIamActions(port: string, verbs: readonly string[]): readonly string[] {
  const portMap = IAM_VERB_MAP[port];
  if (!portMap) {
    throw new AllowTripleEffectsError(
      "allow.port-unknown",
      `No IAM verb map registered for port ${port}.`,
      { port },
    );
  }

  const unknown = verbs.filter((verb) => !portMap[verb]);
  if (unknown.length > 0) {
    throw new AllowTripleEffectsError(
      "allow.verb-unknown",
      `Unknown verbs for ${port}: ${unknown.join(", ")}.`,
      { port, unknown },
    );
  }

  return sortedUnique(verbs.flatMap((verb) => portMap[verb] ?? []));
}

function iamResourcePattern(
  provider: string,
  port: string,
  bindle: string,
  resourceId: string,
): string {
  if (provider !== "aws") {
    return `provider://${provider}/${bindle}/${resourceId}`;
  }

  switch (port) {
    case "wasi:keyvalue":
      return `arn:aws:dynamodb:*:*:table/${bindle}-${resourceId}`;
    case "wasi:blobstore":
      return `arn:aws:s3:::${bindle}-${resourceId}/*`;
    case "wasi:messaging":
      return `arn:aws:sns:*:*:${bindle}-${resourceId}`;
    default:
      return `provider://${provider}/${bindle}/${resourceId}`;
  }
}

function tokenScopeKey(request: TokenScopeRequest): string {
  return `${request.provider}:${request.scope.port}:${request.scope.resource}:${request.scope.action}`;
}

function assertDeclaration(declaration: AllowDeclaration): void {
  if (!declaration.resourceId || !declaration.port || !declaration.componentId) {
    throw new AllowTripleEffectsError(
      "allow.declaration-invalid",
      "AllowDeclaration requires resourceId, port, and componentId.",
      { declaration },
    );
  }
  if (!Array.isArray(declaration.verbs) || declaration.verbs.length === 0) {
    throw new AllowTripleEffectsError(
      "allow.verbs-empty",
      ".allow() must declare at least one verb.",
      { resourceId: declaration.resourceId },
    );
  }
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function assertDeepEqual(
  actual: Readonly<Record<string, JsonValue>>,
  expected: Readonly<Record<string, JsonValue>>,
  label: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new AllowTripleEffectsError(
      "allow.golden-mismatch",
      `Golden triple mismatch at ${label}.`,
      { label, actual, expected },
    );
  }
}
