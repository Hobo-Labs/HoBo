import {
  createGoldenDecisionRequest,
  createRuleset,
  defineTypescriptRule,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import { createReferenceObligation } from "../../obligation-engine-contract/src/obligation-engine.js";

export const DEPLOY_TARGET = "prod";
export const DEPLOY_ACTION_ID = "hobo:delta:promote";
export const FIXED_DEPLOY_TIME = "2026-07-01T12:00:00.000Z";

export function producerConsumerSkewFixture() {
  return {
    target: DEPLOY_TARGET,
    deploymentId: "deployment:order-api-prod",
    camp: { enforcementMode: "strict" },
    eventLog: [
      {
        type: "deployment.Running",
        target: DEPLOY_TARGET,
        component: "worker",
        version: "1.4.2",
        consumes: [
          {
            producer: "api",
            channel: "order-events/order.created",
            contractVersion: "2.0.0",
            requiredFields: ["id", "tenantId", "total"],
          },
        ],
        produces: [],
      },
    ],
    proposedSet: {
      producers: [
        {
          component: "api",
          version: "1.8.0",
          channel: "order-events/order.created",
          contractVersion: "3.0.0",
          provides: ["id", "total"],
        },
      ],
      consumers: [],
    },
  };
}

export function unsafePolicyDenyFixture() {
  return {
    target: DEPLOY_TARGET,
    deploymentId: "deployment:checkout-prod",
    exposesPublicEndpoint: true,
    camp: { enforcementMode: "strict" },
    eventLog: [
      {
        type: "deployment.Running",
        target: DEPLOY_TARGET,
        component: "checkout-worker",
        version: "1.7.0",
        consumes: [
          {
            producer: "checkout-api",
            channel: "orders.http",
            contractVersion: "1.2.0",
            requiredFields: ["id", "tenantId", "total"],
          },
        ],
        produces: [],
      },
    ],
    proposedSet: {
      producers: [
        {
          component: "checkout-api",
          version: "2.4.0",
          channel: "orders.http",
          contractVersion: "1.3.0",
          provides: ["id", "tenantId", "total", "currency"],
        },
      ],
      consumers: [],
    },
    policyRuleset: createUnsafeChangeRuleset(),
  };
}

export function allowWithCanaryFixture() {
  return {
    target: DEPLOY_TARGET,
    deploymentId: "deployment:checkout-prod",
    camp: { enforcementMode: "strict" },
    eventLog: [
      {
        type: "deployment.Running",
        target: DEPLOY_TARGET,
        component: "checkout-worker",
        version: "1.7.0",
        consumes: [
          {
            producer: "checkout-api",
            channel: "orders.http",
            contractVersion: "1.2.0",
            requiredFields: ["id", "tenantId", "total"],
          },
        ],
        produces: [],
      },
    ],
    proposedSet: {
      producers: [
        {
          component: "checkout-api",
          version: "2.4.0",
          channel: "orders.http",
          contractVersion: "1.3.0",
          provides: ["id", "tenantId", "total", "currency"],
        },
      ],
      consumers: [],
    },
    policyRuleset: createCanaryObligationRuleset(),
  };
}

export function createDeployPolicyRequest(overrides = {}) {
  return createGoldenDecisionRequest({
    action: DEPLOY_ACTION_ID,
    resource: { kind: "deployment", id: "deployment:checkout-prod" },
    phase: "apply",
    context: {
      yard: "yard-prod",
      camp: DEPLOY_TARGET,
      provider: "mocked-reference",
    },
    ...overrides,
  });
}

function createUnsafeChangeRuleset() {
  return createRuleset({
    id: "policy-pack:gatekeeper-v1-unsafe-block",
    version: "1.0.0",
    rules: [
      defineTypescriptRule({
        id: "block-public-endpoint-without-auth",
        when: ({ request }) =>
          request.action === DEPLOY_ACTION_ID &&
          request.context?.exposesPublicEndpoint === true,
        decide: () => ({
          effect: "deny",
          reason: "public endpoint requires auth middleware before apply",
          violations: ["missing-auth-middleware"],
        }),
      }),
    ],
  });
}

function createCanaryObligationRuleset() {
  return createRuleset({
    id: "policy-pack:gatekeeper-v1-canary",
    version: "1.0.0",
    rules: [
      defineTypescriptRule({
        id: "prod-deploy-requires-canary",
        when: ({ request }) => request.action === DEPLOY_ACTION_ID,
        decide: () => ({
          effect: "require-approval",
          reason: "production deploy allowed but requires canary rollout",
          approvals: ["platform-sre"],
          obligations: [
            createReferenceObligation("require-canary", {
              id: "obl:canary:checkout-prod",
              effectId: "effect:canary:checkout-prod",
              deadline: "2026-07-01T18:00:00.000Z",
              metadata: { canaryPercent: 10 },
            }),
          ],
        }),
      }),
    ],
  });
}
