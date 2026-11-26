import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createDriver,
  stableDigest
} from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const NON_IAC_DRIVER_ADAPTERS_VERSION = "hobo.non-iac-driver-adapters/v1";

const DEFAULT_WEBHOOK_SECRET = "fixture-custom-webhook-secret";
const DEFAULT_WEBHOOK_SVID = "spiffe://hobo.test/ns/providers/sa/custom-webhook-driver";
const PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g;

export class NonIacDriverAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "NonIacDriverAdapterError";
    this.code = code;
    this.details = details;
  }
}

export function createNonIacDriverAdapters(options = {}) {
  return [
    createTemplateDriverAdapter(options.template),
    createEchoDriverAdapter(options.echo),
    createContainerDriverAdapter(options.container),
    createCustomWebhookDriverAdapter(options.webhook)
  ];
}

export function selectDriverForResourceDefinition(definition, adapters) {
  const registry = new Map();
  for (const adapter of adapters ?? []) {
    const driver = createDriver(adapter);
    registry.set(driver.id, driver);
  }

  const selected = registry.get(definition?.driver);
  if (!selected) {
    throw new NonIacDriverAdapterError(
      "driver-not-registered",
      `driver ${definition?.driver ?? "<missing>"} is not registered`
    );
  }
  return selected;
}

export function createTemplateDriverAdapter(options = {}) {
  return createDriver({
    id: "template",
    async provision(input) {
      const { context, inputs } = normalizeProvisionInput(input);
      const manifests = inputs.manifests ?? inputs.definition?.with?.manifests ?? options.manifests;
      if (!Array.isArray(manifests) || manifests.length === 0) {
        throw new NonIacDriverAdapterError(
          "template-manifests-required",
          "template driver requires a non-empty manifest set"
        );
      }

      const scope = {
        context,
        inputs,
        outputs: inputs.outputs ?? {},
        resources: inputs.resources ?? {}
      };
      const rendered = manifests.map((manifest) => renderTemplateValue(manifest, scope));
      const renderedDigest = stableDigest(rendered);

      return {
        outputs: {
          manifestCount: rendered.length,
          renderedDigest
        },
        manifests: rendered,
        state: {
          driver: "template",
          renderedDigest,
          templateNames: rendered.map(manifestName)
        }
      };
    },
    destroy() {},
    refresh({ state }) {
      return clone(state ?? null);
    }
  });
}

export function createEchoDriverAdapter() {
  return createDriver({
    id: "echo",
    async provision(input) {
      const { inputs } = normalizeProvisionInput(input);
      rejectEchoMutation(inputs);
      const connection = requirePlainObject(inputs.connection, {
        code: "missing-echo-connection",
        message: "echo driver requires inputs.connection outputs"
      });

      return {
        outputs: clone(connection),
        manifests: [],
        state: {
          readOnly: true,
          outputs: clone(connection)
        }
      };
    },
    destroy() {},
    refresh(input) {
      const { inputs, state } = normalizeRefreshInput(input);
      rejectEchoMutation(inputs);
      const previous = pickConnectionLike(state);
      const observed = isPlainObject(inputs.connection) ? clone(inputs.connection) : clone(previous);
      const drift = {
        mode: "read-only",
        changed: stableDigest(previous) !== stableDigest(observed),
        previous: clone(previous),
        observed: clone(observed)
      };

      return {
        outputs: observed,
        state: clone(state ?? null),
        drift,
        provisioningAttempted: false
      };
    }
  });
}

export function createContainerDriverAdapter(options = {}) {
  const executor = options.executor ?? createFixtureContainerExecutor();

  return createDriver({
    id: "container",
    async provision(input) {
      const { context, inputs } = normalizeProvisionInput(input);
      const script = requirePlainObject(inputs.script, {
        code: "container-script-required",
        message: "container driver requires inputs.script"
      });
      if (!isNonEmptyString(script.id)) {
        throw new NonIacDriverAdapterError(
          "container-script-required",
          "container driver requires inputs.script.id"
        );
      }

      const sandbox = normalizeSandbox(inputs.sandbox);
      assertEgressWithinScope(script.egress ?? [], sandbox.network.allowedEgress);

      const request = {
        apiVersion: NON_IAC_DRIVER_ADAPTERS_VERSION,
        context: clone(context),
        script: clone(script),
        sandbox
      };
      const result = await runContainerExecutor(executor, request);
      if (result.status && result.status !== "succeeded") {
        throw new NonIacDriverAdapterError(
          "container-executor-failed",
          result.reason ?? "container Executor returned a failed result",
          { status: result.status }
        );
      }

      const outputs = requirePlainObject(result.outputs, {
        code: "container-outputs-required",
        message: "container Executor must return outputs"
      });
      const sandboxDigest = stableDigest(sandbox);

      return {
        outputs: clone(outputs),
        manifests: clone(result.manifests ?? []),
        state: {
          driver: "container",
          scriptId: script.id,
          execId: result.execId ?? `container-${stableDigest({ script, context }).slice(0, 12)}`,
          sandboxDigest
        }
      };
    },
    destroy() {},
    refresh({ state }) {
      return clone(state ?? null);
    }
  });
}

export function createFixtureContainerExecutor(options = {}) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(clone(request));
      return {
        status: "succeeded",
        execId: options.execId ?? `exec-${stableDigest(request).slice(0, 12)}`,
        outputs: clone(request.script.outputs ?? options.outputs ?? {}),
        manifests: clone(options.manifests ?? [])
      };
    }
  };
}

export function createCustomWebhookDriverAdapter(options = {}) {
  const secret = options.secret ?? DEFAULT_WEBHOOK_SECRET;
  const service = options.service ?? createFixtureWebhookService({ secret });
  const svid = options.svid ?? DEFAULT_WEBHOOK_SVID;
  const url = options.url ?? "fixture://custom-webhook/provision";

  return createDriver({
    id: "custom-webhook",
    async provision(input) {
      const { context, inputs } = normalizeProvisionInput(input);
      const body = {
        apiVersion: NON_IAC_DRIVER_ADAPTERS_VERSION,
        context: clone(context),
        payload: clone(inputs.body ?? inputs.payload ?? inputs)
      };
      const signed = options.signer
        ? options.signer({ body: clone(body), context: clone(context), inputs: clone(inputs) })
        : signSvidRequest({ body, svid, secret });
      const headers = {
        "content-type": "application/json",
        "x-hobo-body-digest": signed.bodyDigest ?? stableDigest(body),
        "x-hobo-signature": signed.signature,
        "x-hobo-svid": signed.svid
      };
      const response = await callWebhookService(service, {
        method: "POST",
        url,
        headers,
        body
      });
      if (response.statusCode && response.statusCode >= 400) {
        throw new NonIacDriverAdapterError(
          "custom-webhook-request-failed",
          `custom-webhook service returned HTTP ${response.statusCode}`,
          { statusCode: response.statusCode }
        );
      }
      const outputs = requirePlainObject(response.outputs, {
        code: "custom-webhook-outputs-required",
        message: "custom-webhook service must return outputs"
      });

      return {
        outputs: clone(outputs),
        manifests: clone(response.manifests ?? []),
        state: {
          driver: "custom-webhook",
          requestDigest: stableDigest({ body, headers: { ...headers, "x-hobo-signature": "<redacted>" } }),
          svid: signed.svid
        }
      };
    },
    destroy() {},
    refresh({ state }) {
      return clone(state ?? null);
    }
  });
}

export function createFixtureWebhookService(options = {}) {
  const secret = options.secret ?? DEFAULT_WEBHOOK_SECRET;
  const trustDomain = options.trustDomain ?? "spiffe://hobo.test";
  const requests = [];

  return {
    requests,
    async handle(request) {
      requests.push(clone(request));
      if (!verifySvidRequest({ request, secret, trustDomain })) {
        throw new NonIacDriverAdapterError(
          "invalid-svid-signature",
          "custom-webhook request has an invalid or forged SVID signature"
        );
      }
      return {
        statusCode: 200,
        outputs: clone(options.outputs ?? request.body?.payload?.outputs ?? {}),
        manifests: clone(options.manifests ?? [])
      };
    }
  };
}

export function signSvidRequest({ body, svid, secret }) {
  const bodyDigest = stableDigest(body);
  return {
    svid,
    bodyDigest,
    signature: hmacSignature({ svid, bodyDigest, secret })
  };
}

export function verifySvidRequest({ request, secret, trustDomain = "spiffe://hobo.test" }) {
  const svid = request?.headers?.["x-hobo-svid"];
  const signature = request?.headers?.["x-hobo-signature"];
  const bodyDigest = request?.headers?.["x-hobo-body-digest"];
  if (!isNonEmptyString(svid) || !isNonEmptyString(signature) || !isNonEmptyString(bodyDigest)) {
    return false;
  }
  if (!svid.startsWith(`${trustDomain}/`)) {
    return false;
  }
  if (bodyDigest !== stableDigest(request.body)) {
    return false;
  }
  return safeEqual(signature, hmacSignature({ svid, bodyDigest, secret }));
}

function normalizeProvisionInput(input) {
  return {
    context: clone(input?.context ?? {}),
    inputs: clone(input?.inputs ?? {})
  };
}

function normalizeRefreshInput(input) {
  return {
    context: clone(input?.context ?? {}),
    inputs: clone(input?.inputs ?? {}),
    state: clone(input?.state)
  };
}

function renderTemplateValue(value, scope) {
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateValue(item, scope));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplateValue(item, scope)])
    );
  }
  if (!isJsonString(value)) {
    return value;
  }
  return renderTemplateString(value, scope);
}

function renderTemplateString(value, scope) {
  const matches = [...value.matchAll(PLACEHOLDER_PATTERN)];
  if (matches.length === 0) {
    return value;
  }
  if (matches.length === 1 && matches[0][0] === value) {
    return clone(resolvePlaceholder(matches[0][1].trim(), scope));
  }
  return value.replace(PLACEHOLDER_PATTERN, (_match, expression) => {
    const resolved = resolvePlaceholder(expression.trim(), scope);
    if (resolved && isJsonObject(resolved)) {
      throw new NonIacDriverAdapterError(
        "template-placeholder-not-scalar",
        `template placeholder ${expression.trim()} cannot be interpolated as text`
      );
    }
    return String(resolved);
  });
}

function resolvePlaceholder(expression, scope) {
  if (expression.startsWith("context.")) {
    return requireResolved(expression, getByPath(scope.context, expression.slice("context.".length)));
  }
  if (expression.startsWith("inputs.")) {
    return requireResolved(expression, getByPath(scope.inputs, expression.slice("inputs.".length)));
  }
  if (expression.startsWith("outputs.")) {
    return requireResolved(expression, getByPath(scope.outputs, expression.slice("outputs.".length)));
  }
  if (expression.startsWith("resources.")) {
    return resolveResourcePlaceholder(expression, scope.resources);
  }
  throw unresolvedPlaceholder(expression);
}

function resolveResourcePlaceholder(expression, resources) {
  const tail = expression.slice("resources.".length);
  const outputMarker = ".outputs.";
  const outputIndex = tail.indexOf(outputMarker);
  if (outputIndex === -1) {
    throw unresolvedPlaceholder(expression);
  }

  const resourceRef = tail.slice(0, outputIndex);
  const outputPath = tail.slice(outputIndex + outputMarker.length);
  return requireResolved(
    expression,
    getByPath(resources?.[resourceRef]?.outputs ?? {}, outputPath)
  );
}

function requireResolved(expression, value) {
  if (value === undefined) {
    throw unresolvedPlaceholder(expression);
  }
  return value;
}

function unresolvedPlaceholder(expression) {
  return new NonIacDriverAdapterError(
    "unresolved-template-placeholder",
    `template placeholder ${expression} could not be resolved`
  );
}

function getByPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function rejectEchoMutation(inputs) {
  const mutationKeys = ["mutation", "desired", "patch", "create", "update", "delete"];
  const attemptedByKey = mutationKeys.some((key) => Object.hasOwn(inputs, key));
  const attemptedByAction =
    isNonEmptyString(inputs.action) && !["read", "refresh", "inspect"].includes(inputs.action);
  if (attemptedByKey || attemptedByAction) {
    throw new NonIacDriverAdapterError(
      "echo-read-only",
      "echo driver is read-only by default and cannot mutate external resources"
    );
  }
}

function normalizeSandbox(input) {
  const normalized = input ?? {};
  const allowedEgress = normalized.network?.allowedEgress ?? normalized.allowedEgress ?? [];
  return {
    runtime: normalized.runtime ?? "firecracker-executor",
    image: normalized.image ?? "ghcr.io/hobo/driver-runner:fixture",
    network: {
      allowedEgress: [...allowedEgress].sort()
    },
    mounts: clone(normalized.mounts ?? [])
  };
}

function assertEgressWithinScope(requestedEgress, allowedEgress) {
  const allowed = new Set(allowedEgress);
  const denied = [...requestedEgress].filter((target) => !allowed.has(target));
  if (denied.length > 0) {
    throw new NonIacDriverAdapterError(
      "container-egress-denied",
      `container script requested egress outside sandbox scope: ${denied.join(", ")}`,
      { denied }
    );
  }
}

async function runContainerExecutor(executor, request) {
  if (executor.run instanceof Function) {
    return executor.run(request);
  }
  if (executor.dispatch instanceof Function) {
    return executor.dispatch(request.script, {
      context: request.context,
      sandbox: request.sandbox
    });
  }
  throw new NonIacDriverAdapterError(
    "container-executor-required",
    "container driver requires an Executor with run or dispatch"
  );
}

async function callWebhookService(service, request) {
  if (service.handle instanceof Function) {
    return service.handle(request);
  }
  if (service instanceof Function) {
    return service(request);
  }
  throw new NonIacDriverAdapterError(
    "custom-webhook-service-required",
    "custom-webhook driver requires a service handle function"
  );
}

function hmacSignature({ svid, bodyDigest, secret }) {
  return createHmac("sha256", secret).update(`${svid}\n${bodyDigest}`).digest("hex");
}

function safeEqual(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right) || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function manifestName(manifest) {
  return manifest?.metadata?.name ?? manifest?.name ?? manifest?.kind ?? "<unnamed>";
}

function pickConnectionLike(value) {
  if (isPlainObject(value?.outputs)) return clone(value.outputs);
  if (isPlainObject(value?.connection)) return clone(value.connection);
  if (isPlainObject(value)) return clone(value);
  return {};
}

function requirePlainObject(value, { code, message }) {
  if (!isPlainObject(value)) {
    throw new NonIacDriverAdapterError(code, message);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value && isJsonObject(value) && !Array.isArray(value));
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
