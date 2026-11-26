import { createHash } from "node:crypto";

const SENSITIVE_CLASSES = new Set(["pii", "secret"]);

export function evaluateTrajectoryPrivacy(policy, request) {
  const denials = collectCaptureDenials(request);
  const effectiveRetentionDays = resolveEffectiveRetentionDays(policy, request);

  if (denials.length > 0) {
    return {
      capture: false,
      denials,
      effectiveRetentionDays,
      fields: [],
      auditEvents: denials.map((denial) => denial.event)
    };
  }

  const optedOutFields = new Set(request.tenantPolicy?.optOut?.fields ?? []);
  const fields = request.payload
    .filter((field) => !optedOutFields.has(field.path))
    .map((field) => transformField(request, field));

  return {
    capture: true,
    denials: [],
    effectiveRetentionDays,
    fields,
    auditEvents: [
      "training.TrajectoryPrivacyEvaluated",
      fields.some((field) => SENSITIVE_CLASSES.has(field.classification))
        ? "training.TrajectorySensitivePayloadRedacted"
        : "training.TrajectoryCaptured"
    ]
  };
}

export function authorizeRawTrajectoryAccess(policy, request) {
  const denials = [];
  const classes = new Set(request.classes ?? []);

  if (request.run?.tenantId !== request.requester?.tenantId) {
    denials.push({
      code: "cross_tenant_raw_access",
      event: "training.RawTrajectoryAccessDenied"
    });
  }

  if (
    request.requester?.providerKind === "external" &&
    [...classes].some((classification) => SENSITIVE_CLASSES.has(classification))
  ) {
    denials.push({
      code: "external_sensitive_raw_access",
      event: "training.RawTrajectoryAccessDenied"
    });
  }

  if (!policy.defaults.rawAccessPurposes.includes(request.requester?.purpose)) {
    denials.push({
      code: "purpose_not_allowed",
      event: "training.RawTrajectoryAccessDenied"
    });
  }

  if (!request.requester?.approvalId) {
    denials.push({
      code: "approval_required",
      event: "training.RawTrajectoryAccessDenied"
    });
  }

  if (classes.has("secret")) {
    denials.push({
      code: "secret_raw_access_denied",
      event: "training.RawTrajectoryAccessDenied"
    });
  }

  return {
    allowed: denials.length === 0,
    denials,
    auditEvents:
      denials.length === 0
        ? ["training.RawTrajectoryAccessApproved"]
        : ["training.RawTrajectoryAccessDenied"]
  };
}

export function createOptimizerPayload(decision) {
  if (!decision.capture) {
    return {
      fields: [],
      instructions: ["Capture denied; optimizer must not train on this trajectory."]
    };
  }

  return {
    fields: decision.fields.flatMap((field) => {
      if (field.classification === "secret") {
        return [];
      }

      if (field.classification === "pii") {
        return [
          {
            path: field.path,
            classification: field.classification,
            redaction: field.redaction,
            tokenRef: field.tokenRef
          }
        ];
      }

      return [field];
    }),
    instructions: [
      "Optimizer must not dereference tokenized PII or sealed secret references.",
      "External optimizer and judge providers receive redacted trajectories only."
    ]
  };
}

function collectCaptureDenials(request) {
  const denials = [];

  if (request.run?.trace?.sampled === false) {
    denials.push({
      code: "trace_sampled_out",
      event: "training.TrajectorySampledOut"
    });
  }

  if (request.store?.tenantId !== request.run?.tenantId) {
    denials.push({
      code: "cross_tenant_trajectory_store",
      event: "training.TrajectoryCaptureDenied"
    });
  }

  if (request.optimizer?.tenantId !== request.run?.tenantId) {
    denials.push({
      code: "cross_tenant_optimizer",
      event: "training.TrajectoryCaptureDenied"
    });
  }

  const optOut = request.tenantPolicy?.optOut ?? {};
  if ((optOut.tenants ?? []).includes(request.run?.tenantId)) {
    denials.push({
      code: "tenant_opted_out",
      event: "training.TrajectoryOptedOut"
    });
  }

  if ((optOut.methods ?? []).includes(request.run?.methodId)) {
    denials.push({
      code: "method_opted_out",
      event: "training.TrajectoryOptedOut"
    });
  }

  if ((optOut.users ?? []).includes(request.run?.userId)) {
    denials.push({
      code: "user_opted_out",
      event: "training.TrajectoryOptedOut"
    });
  }

  return denials;
}

function resolveEffectiveRetentionDays(policy, request) {
  const candidates = [
    policy.defaults.trajectoryRetentionDays,
    request.run?.trace?.retentionDays,
    request.run?.requestedTrajectoryRetentionDays,
    request.tenantPolicy?.maxTrajectoryRetentionDays
  ].filter((value) => Number.isInteger(value) && value > 0);

  return Math.min(...candidates);
}

function transformField(request, field) {
  switch (field.classification) {
    case "public":
      return {
        path: field.path,
        classification: field.classification,
        value: field.value
      };
    case "internal":
      return {
        path: field.path,
        classification: field.classification,
        redaction: "minimized",
        hashRef: stableRef("hash", request, field)
      };
    case "pii":
      return {
        path: field.path,
        classification: field.classification,
        redaction: "tokenized",
        tokenRef: stableRef("tok", request, field),
        encryptedRef: encryptedRef(request, field)
      };
    case "secret":
      return {
        path: field.path,
        classification: field.classification,
        redaction: "sealed",
        encryptedRef: encryptedRef(request, field)
      };
    default:
      return {
        path: field.path,
        classification: "unknown",
        redaction: "omitted",
        hashRef: stableRef("hash", request, field)
      };
  }
}

function encryptedRef(request, field) {
  const safePath = field.path.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `enc://${request.run.tenantId}/${request.run.id}/${safePath}/${digest(field)}`;
}

function stableRef(prefix, request, field) {
  return `${prefix}:${digest({
    tenantId: request.run.tenantId,
    runId: request.run.id,
    path: field.path,
    value: field.value
  })}`;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
