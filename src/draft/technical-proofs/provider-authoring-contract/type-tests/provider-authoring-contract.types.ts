import {
  createOptionBuilder,
  defineProvider,
  mergeResolvedProviderOptions,
  type CapabilitySpec,
  type PortClient,
  type ProviderOptionBlock
} from "../src/provider-authoring-contract.js";
import { type JsonValue } from "../src/json.js";

type AwsRdsOptions = {
  instanceClass: string;
};

type AzurePostgresOptions = {
  sku: string;
};

type AwsClients = {
  database: PortClient<"database", "aws"> & { query(sql: string): Promise<unknown[]> };
  compute: PortClient<"compute", "aws"> & { invoke(name: string): Promise<void> };
};

const aws = defineProvider<"aws", readonly [
  CapabilitySpec<"database">,
  CapabilitySpec<"compute">
], AwsClients, {
  readonly rds: ReturnType<typeof createOptionBuilder<"aws", "database", AwsRdsOptions>>;
  readonly fargate: ReturnType<typeof createOptionBuilder<"aws", "compute", { cpu: number }>>;
}>({
  id: "aws",
  capabilities: [
    { port: "database", stability: "stable" },
    { port: "compute", stability: "stable" }
  ] as const,
  with: {
    rds: createOptionBuilder<"aws", "database", AwsRdsOptions>("aws", "database", "rds"),
    fargate: createOptionBuilder<"aws", "compute", { cpu: number }>("aws", "compute", "fargate")
  },
  client(port) {
    if (port === "database") {
      return { port, providerId: "aws", query: async () => [] };
    }
    return { port, providerId: "aws", invoke: async () => undefined };
  },
  capabilityManifest() {
    return {
      providerId: "aws",
      capabilities: [
        { port: "database", stability: "stable" },
        { port: "compute", stability: "stable" }
      ],
      auth: { mode: "brokered" },
      optionBuilders: ["rds", "fargate"]
    };
  }
});

const azureBlock: ProviderOptionBlock<"azure", "database", AzurePostgresOptions> = {
  providerId: "azure",
  port: "database",
  optionName: "postgres",
  negotiation: "prefer",
  options: { sku: "B_Standard_B1ms" }
};

mergeResolvedProviderOptions(aws, [aws.with.rds({ instanceClass: "db.t4g.micro" })]);

// @ts-expect-error scoped option builder names are exact.
aws.with.typo({ instanceClass: "db.t4g.micro" });

// @ts-expect-error scoped option builder payloads preserve provider-specific option types.
aws.with.rds({ sku: "B_Standard_B1ms" });

// @ts-expect-error azure option blocks cannot be merged into the resolved aws provider.
mergeResolvedProviderOptions(aws, [azureBlock]);

// @ts-expect-error provider option builders cannot target undeclared ports.
defineProvider<"bad", readonly [CapabilitySpec<"database">], { database: PortClient<"database", "bad"> }, {
  readonly queue: ReturnType<typeof createOptionBuilder<"bad", "queue", { fifo: boolean }>>;
}>({
  id: "bad",
  capabilities: [{ port: "database", stability: "stable" }] as const,
  with: {
    queue: createOptionBuilder<"bad", "queue", { fifo: boolean }>("bad", "queue", "queue")
  },
  client() {
    return { port: "database", providerId: "bad" };
  },
  capabilityManifest() {
    return {
      providerId: "bad",
      capabilities: [{ port: "database", stability: "stable" }],
      auth: { mode: "brokered" },
      optionBuilders: ["queue"]
    };
  }
});

type BadClients = { database: JsonValue };
// @ts-expect-error JsonValue is not an acceptable typed client surface.
defineProvider<"unknown-client", readonly [CapabilitySpec<"database">], BadClients, {
  readonly database: ReturnType<typeof createOptionBuilder<"unknown-client", "database", {}>>;
}>({
  id: "unknown-client",
  capabilities: [{ port: "database", stability: "stable" }] as const,
  with: {
    database: createOptionBuilder<"unknown-client", "database", {}>(
      "unknown-client",
      "database",
      "database"
    )
  },
  client() {
    return {};
  },
  capabilityManifest() {
    return {
      providerId: "unknown-client",
      capabilities: [{ port: "database", stability: "stable" }],
      auth: { mode: "brokered" },
      optionBuilders: ["database"]
    };
  }
});
