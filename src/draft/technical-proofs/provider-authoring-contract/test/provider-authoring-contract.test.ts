import assert from "node:assert/strict";
import { test } from "vitest";

import {
  auditProviderCatalog,
  createOptionBuilder,
  createFixtureAzureProvider,
  createFixtureAwsProvider,
  defineProvider,
  resolveProviderOptions,
  validateProviderPackage
} from "../src/provider-authoring-contract.js";

test("fixture provider exports factory, scoped .with builders, typed client, and capability manifest", () => {
  const aws = createFixtureAwsProvider({ account: "dev-account" });
  const validation = validateProviderPackage(aws);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(aws.id, "aws");
  assert.deepEqual(
    Object.keys(aws.with).sort(),
    ["fargate", "rds"]
  );

  const optionBlock = aws.with.rds({
    instanceClass: "db.t4g.micro",
    negotiation: "require"
  });
  assert.deepEqual(optionBlock, {
    providerId: "aws",
    port: "database",
    optionName: "rds",
    negotiation: "require",
    options: {
      instanceClass: "db.t4g.micro"
    }
  });

  const client = aws.client("database", { endpoint: "postgres://local" });
  assert.equal(client.port, "database");
  assert.equal(client.providerId, "aws");
  assert.equal(client.connectionString, "postgres://local");

  assert.deepEqual(aws.capabilityManifest(), {
    providerId: "aws",
    capabilities: [
      { port: "database", stability: "stable" },
      { port: "compute", stability: "stable" }
    ],
    auth: { mode: "brokered" },
    optionBuilders: ["rds", "fargate"]
  });
});

test("only the resolved provider's option blocks survive merge", () => {
  const aws = createFixtureAwsProvider();
  const azure = createFixtureAzureProvider();

  const result = resolveProviderOptions(aws, [
    aws.with.rds({ instanceClass: "db.t4g.micro" }),
    azure.with.postgres({ sku: "B_Standard_B1ms" })
  ]);

  assert.deepEqual(result.merged, {
    database: {
      optionName: "rds",
      negotiation: "prefer",
      options: {
        instanceClass: "db.t4g.micro"
      }
    }
  });
  assert.deepEqual(result.dropped, [
    {
      providerId: "azure",
      port: "database",
      optionName: "postgres",
      reason: "option block belongs to unresolved provider azure"
    }
  ]);
});

test(".with builders that target undeclared provider ports fail closed", () => {
  assert.throws(
    () =>
      defineProvider({
        id: "bad-provider",
        capabilities: [{ port: "database", stability: "stable" }],
        with: {
          queue: createOptionBuilder("bad-provider", "queue", "queue")
        },
        client(port) {
          return { port, providerId: "bad-provider" };
        },
        capabilityManifest({ id, capabilities, optionBuilders }) {
          return { providerId: id, capabilities, auth: { mode: "brokered" }, optionBuilders };
        }
      }),
    /option builder queue references undeclared port queue/
  );
});

test("same-named option builders across providers are reported as unqualified conflicts", () => {
  const aws = createFixtureAwsProvider();
  const cloud = defineProvider({
    id: "cloud",
    capabilities: [{ port: "database", stability: "stable" }],
    with: {
      rds: createOptionBuilder("cloud", "database", "rds")
    },
    client(port) {
      return { port, providerId: "cloud" };
    },
    capabilityManifest({ id, capabilities, optionBuilders }) {
      return { providerId: id, capabilities, auth: { mode: "brokered" }, optionBuilders };
    }
  });

  const audit = auditProviderCatalog([aws, cloud]);

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.conflicts, [
    {
      optionName: "rds",
      providers: ["aws", "cloud"],
      reason: "unqualified option builder name is ambiguous; use provider-scoped access"
    }
  ]);
});

test("client() returning an untyped surface fails provider validation", () => {
  const badProvider = defineProvider({
    id: "bad-client",
    capabilities: [{ port: "database", stability: "stable" }],
    with: {
      database: createOptionBuilder("bad-client", "database", "database")
    },
    client() {
      return {};
    },
    capabilityManifest({ id, capabilities, optionBuilders }) {
      return { providerId: id, capabilities, auth: { mode: "brokered" }, optionBuilders };
    }
  });

  const validation = validateProviderPackage(badProvider);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /client\(database\) returned untyped surface/);
});

test("package self-reference imports the provider factory surface", async () => {
  const module = await import("@hobo-draft/provider-authoring-contract");

  assert.equal(module.createFixtureAwsProvider instanceof Function, true);
  assert.equal(module.createFixtureAwsProvider().id, "aws");
});

test("client() and option merge reject same-provider blocks for undeclared ports", () => {
  const aws = createFixtureAwsProvider();

  assert.throws(
    () => aws.client("queue", {}),
    /provider aws does not declare port queue/
  );
  assert.throws(
    () =>
      resolveProviderOptions(aws, [
        {
          providerId: "aws",
          port: "queue",
          optionName: "queue",
          negotiation: "prefer",
          options: {}
        }
      ]),
    /option block queue references undeclared port queue/
  );
});

test("catalog audit detects duplicate unqualified builder optionName even with different property keys", () => {
  const aws = createFixtureAwsProvider();
  const cloud = defineProvider({
    id: "cloud",
    capabilities: [{ port: "database", stability: "stable" }],
    with: {
      managedDatabase: createOptionBuilder("cloud", "database", "rds")
    },
    client(port) {
      return { port, providerId: "cloud" };
    },
    capabilityManifest({ id, capabilities, optionBuilders }) {
      return { providerId: id, capabilities, auth: { mode: "brokered" }, optionBuilders };
    }
  });

  const audit = auditProviderCatalog([aws, cloud]);

  assert.equal(audit.ok, false);
  assert.deepEqual(audit.conflicts, [
    {
      optionName: "rds",
      providers: ["aws", "cloud"],
      reason: "unqualified option builder name is ambiguous; use provider-scoped access"
    }
  ]);
});
