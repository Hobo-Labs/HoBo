import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createGatewayStub,
  gatewayPort,
  service,
  trafficSplit,
  web,
} from "../src/gateway-contract.js";

test("gateway terminates TLS and routes by host plus longest path", () => {
  const gateway = gatewayPort("shop-edge")
    .terminateTls({ minVersion: "TLS1.2" })
    .route("shop.com", "/", web("shop-ui"))
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

  const response = createGatewayStub(gateway).handle({
    scheme: "https",
    host: "shop.com",
    path: "/api/orders",
    method: "POST",
  });

  assert.equal(response.tls.terminated, true);
  assert.equal(response.route.host, "shop.com");
  assert.equal(response.route.path, "/api");
  assert.deepEqual(response.target, service("checkout-api"));
  assert.deepEqual(response.split.steps, [
    { target: "checkout-v1", weight: 95 },
    { target: "checkout-v2", weight: 5 },
  ]);
});

test("root path route catches unmatched paths on the same host", () => {
  const gateway = gatewayPort("shop-edge")
    .terminateTls()
    .route("shop.com", "/", web("shop-ui"))
    .build();

  const response = createGatewayStub(gateway).handle({
    scheme: "https",
    host: "shop.com",
    path: "/pricing",
    method: "GET",
  });

  assert.equal(response.route.path, "/");
  assert.deepEqual(response.target, web("shop-ui"));
});

test("traffic split weights must sum to 100 percent", () => {
  assert.throws(
    () =>
      trafficSplit([
        { target: "checkout-v1", weight: 90 },
        { target: "checkout-v2", weight: 5 },
      ]),
    /sum to 100/i,
  );
});

test("traffic split rejects non-positive weights even when the total is 100", () => {
  assert.throws(
    () =>
      trafficSplit([
        { target: "checkout-v1", weight: 125 },
        { target: "checkout-v2", weight: -25 },
      ]),
    /positive/i,
  );
});

test("CORS defaults closed when no vertical origins are declared", () => {
  const gateway = gatewayPort("internal-edge").terminateTls().build();

  assert.deepEqual(gateway.cors, {
    allowOrigins: [],
    methods: [],
    credentials: false,
  });
});

test("mounted vertical UIs derive CORS origins and keep provider options scoped to gateway", () => {
  const gateway = gatewayPort("shop-edge")
    .terminateTls()
    .with({ waf: "managed", rateLimit: { requestsPerMinute: 600 }, ddos: "standard" })
    .mount("shop.com", "/checkout", web("checkout-ui", { origin: "https://checkout.shop.com" }))
    .mount("shop.com", "/account", web("account-ui", { origin: "https://account.shop.com" }))
    .build();

  assert.deepEqual(gateway.providerOptions, {
    waf: "managed",
    rateLimit: { requestsPerMinute: 600 },
    ddos: "standard",
  });
  assert.deepEqual(gateway.cors, {
    allowOrigins: ["https://account.shop.com", "https://checkout.shop.com"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  });

  const response = createGatewayStub(gateway).handle({
    scheme: "https",
    host: "shop.com",
    path: "/checkout/cart",
    method: "GET",
  });

  assert.deepEqual(response.target, web("checkout-ui", { origin: "https://checkout.shop.com" }));
});

test("malformed vertical origins are rejected instead of opening CORS", () => {
  assert.throws(
    () =>
      gatewayPort("shop-edge")
        .terminateTls()
        .mount("shop.com", "/checkout", web("checkout-ui", { origin: "https://checkout.shop.com/path" }))
        .build(),
    /invalid origin/i,
  );
});
