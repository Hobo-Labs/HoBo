import assert from "node:assert/strict";
import { test } from "vitest";

import {
  gatewayPort,
  service,
  trafficSplit,
  web,
} from "../../hobo-gateway-port/src/gateway-contract.js";
import {
  planGatewayRequest,
  realizeGateway,
} from "../src/gateway-realization.js";

test("realized gateway terminates TLS and routes by host plus path", () => {
  const gateway = gatewayPort("shop-edge")
    .terminateTls({ minVersion: "TLS1.2", certificateRef: "cert:shop.com" })
    .with({ waf: "managed", rateLimit: { requestsPerMinute: 600 } })
    .route("shop.com", "/", web("shop-ui"))
    .route("shop.com", "/api", service("checkout-api"))
    .build();

  const deployment = realizeGateway(gateway, {
    provider: "local-edge",
    health: { "checkout-api": "healthy", "shop-ui": "healthy" },
  });

  const response = planGatewayRequest(deployment, {
    scheme: "https",
    host: "shop.com",
    path: "/api/orders",
    method: "POST",
  });

  assert.equal(response.served, true);
  assert.equal(response.tls.terminated, true);
  assert.equal(response.listener.protocol, "https");
  assert.equal(response.route.path, "/api");
  assert.equal(response.target.id, "checkout-api");
  assert.deepEqual(deployment.providerOptions, {
    waf: "managed",
    rateLimit: { requestsPerMinute: 600 },
  });
});

test("weighted traffic split sends 95/5 traffic and flipping the split moves traffic", () => {
  const original = gatewayPort("shop-edge")
    .terminateTls()
    .route(
      "shop.com",
      "/api",
      service("checkout-api"),
      trafficSplit([
        { target: "checkout-v1", weight: 95 },
        { target: "checkout-v2", weight: 5 },
      ]),
    )
    .build();
  const flipped = gatewayPort("shop-edge")
    .terminateTls()
    .route(
      "shop.com",
      "/api",
      service("checkout-api"),
      trafficSplit([
        { target: "checkout-v1", weight: 5 },
        { target: "checkout-v2", weight: 95 },
      ]),
    )
    .build();

  const health = { "checkout-v1": "healthy", "checkout-v2": "healthy" };
  const originalDeployment = realizeGateway(original, { health });
  const flippedDeployment = realizeGateway(flipped, { health });

  const counts = { "checkout-v1": 0, "checkout-v2": 0 };
  for (let roll = 0; roll < 100; roll += 1) {
    const response = planGatewayRequest(originalDeployment, {
      scheme: "https",
      host: "shop.com",
      path: "/api/orders",
      method: "GET",
      roll,
    });
    counts[response.selectedBackend] += 1;
  }

  assert.deepEqual(counts, { "checkout-v1": 95, "checkout-v2": 5 });
  assert.equal(
    planGatewayRequest(originalDeployment, {
      scheme: "https",
      host: "shop.com",
      path: "/api/orders",
      method: "GET",
      roll: 50,
    }).selectedBackend,
    "checkout-v1",
  );
  assert.equal(
    planGatewayRequest(flippedDeployment, {
      scheme: "https",
      host: "shop.com",
      path: "/api/orders",
      method: "GET",
      roll: 50,
    }).selectedBackend,
    "checkout-v2",
  );
});

test("mounted vertical serves at its path and derives CORS origins", () => {
  const gateway = gatewayPort("shop-edge")
    .terminateTls()
    .mount("shop.com", "/checkout", web("checkout-ui", { origin: "https://checkout.shop.com" }))
    .mount("shop.com", "/account", web("account-ui", { origin: "https://account.shop.com" }))
    .build();

  const deployment = realizeGateway(gateway, {
    health: { "checkout-ui": "healthy", "account-ui": "healthy" },
  });

  assert.deepEqual(deployment.cors, {
    allowOrigins: ["https://account.shop.com", "https://checkout.shop.com"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  });

  const response = planGatewayRequest(deployment, {
    scheme: "https",
    host: "shop.com",
    path: "/checkout/cart",
    method: "GET",
  });

  assert.equal(response.served, true);
  assert.equal(response.target.id, "checkout-ui");
  assert.equal(response.route.path, "/checkout");
});

test("CORS defaults closed when no vertical origin is declared", () => {
  const deployment = realizeGateway(gatewayPort("internal-edge").terminateTls().build());

  assert.deepEqual(deployment.cors, {
    allowOrigins: [],
    methods: [],
    credentials: false,
  });
});

test("traffic split that does not sum to 100 percent is rejected at apply", () => {
  const invalidGateway = {
    id: "shop-edge",
    tls: { mode: "terminate" },
    providerOptions: {},
    cors: { allowOrigins: [], methods: [], credentials: false },
    routes: [
      {
        host: "shop.com",
        path: "/api",
        target: service("checkout-api"),
        split: {
          kind: "traffic-split",
          steps: [
            { target: "checkout-v1", weight: 90 },
            { target: "checkout-v2", weight: 5 },
          ],
        },
      },
    ],
  };

  assert.throws(() => realizeGateway(invalidGateway), /sum to 100/i);
});

test("unhealthy backend is not served as healthy", () => {
  const gateway = gatewayPort("shop-edge")
    .terminateTls()
    .route("shop.com", "/api", service("checkout-api"))
    .build();
  const deployment = realizeGateway(gateway, {
    health: { "checkout-api": "unhealthy" },
  });

  const response = planGatewayRequest(deployment, {
    scheme: "https",
    host: "shop.com",
    path: "/api/orders",
    method: "GET",
  });

  assert.equal(response.served, false);
  assert.equal(response.status, 503);
  assert.equal(response.reason, "backend-unhealthy");
  assert.equal(response.target.id, "checkout-api");
});
