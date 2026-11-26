import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createTenantRoutingTable,
  routeTenantRequest,
} from "../src/per-app-tenant-routing.js";

function fixtureRoutingTable() {
  return createTenantRoutingTable({
    applicationDomain: "app.com",
    trustedGatewayHosts: ["app.com", "api.app.com"],
    wildcardCertificates: [
      {
        id: "cert-wildcard-app-com",
        pattern: "*.app.com",
        source: "acme-dns01",
        status: "issued",
      },
    ],
    tenants: [
      {
        id: "acme",
        subdomain: "acme",
        pathPrefix: "/t/acme",
        customDomains: [
          {
            host: "status.acme.com",
            resourceId: "domain:tenant/acme/status-acme-com",
            certificateRef: "cert://identity/status-acme-com",
            tenantScoped: true,
            verified: true,
          },
        ],
        placement: {
          mode: "pooled",
          camp: "camp-shared-us",
          region: "us-east-1",
        },
      },
      {
        id: "globex",
        subdomain: "globex",
        pathPrefix: "/t/globex",
        customDomains: [],
        placement: {
          mode: "siloed",
          camp: "camp-globex-eu",
          region: "eu-west-1",
        },
      },
      {
        id: "northwind",
        subdomain: "northwind",
        pathPrefix: "/t/northwind",
        customDomains: [],
        placement: {
          mode: "region-pooled",
          camp: "camp-us-central",
          region: "us-central1",
        },
      },
    ],
  });
}

test("resolves ctx.tenant from subdomain before the handler and binds the wildcard cert", () => {
  const handled = [];
  const response = routeTenantRequest(
    fixtureRoutingTable(),
    {
      scheme: "https",
      host: "acme.app.com",
      path: "/orders",
      jwt: { verified: true, tenant: "acme" },
    },
    (ctx) => {
      handled.push(ctx);
      return { tenantId: ctx.tenant.id };
    },
  );

  assert.equal(response.effect, "allow");
  assert.equal(response.resolvedBy, "subdomain");
  assert.equal(response.ctx.tenant.id, "acme");
  assert.equal(response.ctx.placement.camp, "camp-shared-us");
  assert.equal(response.certificate.pattern, "*.app.com");
  assert.equal(response.certificate.source, "acme-dns01");
  assert.equal(response.resolvedBeforeHandler, true);
  assert.equal(response.handlerResult.tenantId, "acme");
  assert.deepEqual(handled.map((ctx) => ctx.tenant.id), ["acme"]);
});

test("routes a tenant-scoped custom domain to its owning tenant", () => {
  const response = routeTenantRequest(fixtureRoutingTable(), {
    scheme: "https",
    host: "status.acme.com",
    path: "/health",
  });

  assert.equal(response.effect, "allow");
  assert.equal(response.resolvedBy, "custom-domain");
  assert.equal(response.ctx.tenant.id, "acme");
  assert.equal(response.domainResource.resourceId, "domain:tenant/acme/status-acme-com");
  assert.equal(response.domainResource.tenantScoped, true);
  assert.equal(response.certificate.certRef, "cert://identity/status-acme-com");
});

test("resolves ctx.tenant from the /t/:tenant path on a trusted gateway host", () => {
  const response = routeTenantRequest(fixtureRoutingTable(), {
    scheme: "https",
    host: "app.com",
    path: "/t/acme/dashboard",
  });

  assert.equal(response.effect, "allow");
  assert.equal(response.resolvedBy, "path");
  assert.equal(response.ctx.tenant.id, "acme");
  assert.equal(response.forwardedPath, "/dashboard");
});

test("verified JWT tenancy claim can resolve a trusted gateway request", () => {
  const response = routeTenantRequest(fixtureRoutingTable(), {
    scheme: "https",
    host: "api.app.com",
    path: "/graphql",
    jwt: { verified: true, tenant: "northwind" },
  });

  assert.equal(response.effect, "allow");
  assert.equal(response.resolvedBy, "jwt-claim");
  assert.equal(response.ctx.tenant.id, "northwind");
  assert.equal(response.ctx.placement.mode, "region-pooled");
  assert.equal(response.ctx.placement.region, "us-central1");
});

test("siloed tenant request selects its configured Camp and region", () => {
  const response = routeTenantRequest(fixtureRoutingTable(), {
    scheme: "https",
    host: "globex.app.com",
    path: "/api/orders",
  });

  assert.equal(response.effect, "allow");
  assert.equal(response.ctx.tenant.id, "globex");
  assert.deepEqual(response.placement, {
    mode: "siloed",
    camp: "camp-globex-eu",
    region: "eu-west-1",
  });
});

test("request with no resolvable tenant fails closed before handler invocation", () => {
  let handlerCalls = 0;
  const response = routeTenantRequest(
    fixtureRoutingTable(),
    {
      scheme: "https",
      host: "app.com",
      path: "/public",
    },
    () => {
      handlerCalls += 1;
    },
  );

  assert.equal(response.effect, "deny");
  assert.equal(response.reason, "tenant-unresolved");
  assert.equal(response.ctx, undefined);
  assert.equal(response.resolvedBeforeHandler, true);
  assert.equal(handlerCalls, 0);
});

test("host that does not match a tenant is rejected instead of defaulted", () => {
  const response = routeTenantRequest(fixtureRoutingTable(), {
    scheme: "https",
    host: "nobody.app.com",
    path: "/orders",
    jwt: { verified: true, tenant: "acme" },
  });

  assert.equal(response.effect, "deny");
  assert.equal(response.reason, "tenant-host-unknown");
  assert.equal(response.ctx, undefined);
});

test("tenancy-claim and host mismatch is denied before handler invocation", () => {
  let handlerCalls = 0;
  const response = routeTenantRequest(
    fixtureRoutingTable(),
    {
      scheme: "https",
      host: "acme.app.com",
      path: "/orders",
      jwt: { verified: true, tenant: "globex" },
    },
    () => {
      handlerCalls += 1;
    },
  );

  assert.equal(response.effect, "deny");
  assert.equal(response.reason, "tenant-claim-mismatch");
  assert.equal(handlerCalls, 0);
});
