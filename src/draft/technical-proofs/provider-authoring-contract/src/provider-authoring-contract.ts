import { isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export type PortKind = "database" | "compute" | "objectStore" | "queue" | "cache" | "dns";

export type Negotiation = "prefer" | "require";

export type Stability = "stable" | "preview" | "experimental" | "deprecated";

export type Outputs = JsonObject;

export interface CapabilitySpec<P extends PortKind = PortKind> {
  readonly port: P;
  readonly stability: Stability;
}

export interface PortClient<P extends PortKind, Id extends string = string> {
  readonly port: P;
  readonly providerId: Id;
}

export type ClientMap<Ports extends PortKind, Id extends string> = {
  readonly [P in Ports]: PortClient<P, Id>;
};

export interface CapabilityManifest<Id extends string = string> {
  readonly providerId: Id;
  readonly capabilities: readonly CapabilitySpec[];
  readonly auth: { readonly mode: "brokered" | "static" };
  readonly optionBuilders: readonly string[];
}

export interface ProviderOptionBlock<
  Id extends string,
  Port extends PortKind,
  Options extends object
> {
  readonly providerId: Id;
  readonly port: Port;
  readonly optionName: string;
  readonly negotiation: Negotiation;
  readonly options: Options;
}

export interface ProviderOptionBuilder<
  Id extends string,
  Port extends PortKind,
  Options extends object
> {
  (options: Options & { readonly negotiation?: Negotiation }): ProviderOptionBlock<Id, Port, Options>;
  readonly providerId: Id;
  readonly port: Port;
  readonly optionName: string;
}

type CapabilityPorts<Capabilities extends readonly CapabilitySpec[]> = Capabilities[number]["port"];

type ProviderOptionBuilders<
  Id extends string,
  Capabilities extends readonly CapabilitySpec[]
> = Record<string, ProviderOptionBuilder<Id, CapabilityPorts<Capabilities>, any>>;

export interface ProviderSpec<
  Id extends string,
  Capabilities extends readonly CapabilitySpec[],
  Clients extends ClientMap<CapabilityPorts<Capabilities>, Id>,
  Builders extends ProviderOptionBuilders<Id, Capabilities>
> {
  readonly id: Id;
  readonly capabilities: Capabilities;
  readonly with: Builders;
  readonly client: (port: CapabilityPorts<Capabilities>, outputs: Outputs) => Clients[CapabilityPorts<Capabilities>];
  readonly capabilityManifest: (input: {
    readonly id: Id;
    readonly capabilities: Capabilities;
    readonly optionBuilders: readonly string[];
  }) => CapabilityManifest<Id>;
}

export interface ProviderDefinition<
  Id extends string,
  Capabilities extends readonly CapabilitySpec[],
  Clients extends ClientMap<CapabilityPorts<Capabilities>, Id>,
  Builders extends ProviderOptionBuilders<Id, Capabilities>
> {
  readonly id: Id;
  readonly capabilities: Capabilities;
  readonly with: Builders;
  readonly client: <P extends CapabilityPorts<Capabilities>>(port: P, outputs: Outputs) => Clients[P];
  readonly capabilityManifest: () => CapabilityManifest<Id>;
}

type AnyProviderDefinition = ProviderDefinition<
  string,
  readonly CapabilitySpec[],
  ClientMap<PortKind, string>,
  ProviderOptionBuilders<string, readonly CapabilitySpec[]>
>;

type ResolvedProviderOption = {
  readonly optionName: string;
  readonly negotiation: Negotiation;
  readonly options: object;
};

type DroppedProviderOption = {
  readonly providerId: string;
  readonly port: PortKind;
  readonly optionName: string;
  readonly reason: string;
};

export function createOptionBuilder<
  const Id extends string,
  const Port extends PortKind,
  Options extends object = JsonObject
>(providerId: Id, port: Port, optionName: string): ProviderOptionBuilder<Id, Port, Options> {
  // SAFETY: `return Object.assign(` is required at this I/O or test boundary.
  return Object.assign(
    ({ negotiation = "prefer", ...options } = {}) => ({
      providerId,
      port,
      optionName,
      negotiation,
      // SAFETY: `options: options as Options` is required at this I/O or test boundary.
      options: options as Options
    }),
    {
      providerId,
      port,
      optionName
    }
  ) as ProviderOptionBuilder<Id, Port, Options>;
}

export function defineProvider<
  const Id extends string,
  const Capabilities extends readonly CapabilitySpec[],
  Clients extends ClientMap<CapabilityPorts<Capabilities>, Id>,
  Builders extends ProviderOptionBuilders<Id, Capabilities>
>(spec: ProviderSpec<Id, Capabilities, Clients, Builders>): ProviderDefinition<Id, Capabilities, Clients, Builders> {
  const capabilities = spec.capabilities;
  const declaredPorts = new Set(capabilities.map((capability) => capability.port));
  // SAFETY: `for (const [name, builder] of Object.entries(spec.with) as Array<[string, Builde` is required at this I/O or test boundary.
  for (const [name, builder] of Object.entries(spec.with) as Array<[string, Builders[keyof Builders]]>) {
    if (builder.providerId !== spec.id) {
      throw new Error(`option builder ${name} belongs to provider ${builder.providerId}, not ${spec.id}`);
    }
    if (!declaredPorts.has(builder.port)) {
      throw new Error(`option builder ${name} references undeclared port ${builder.port}`);
    }
  }

  const provider = {
    id: spec.id,
    capabilities,
    with: Object.freeze({ ...spec.with }),
    client<P extends CapabilityPorts<Capabilities>>(port: P, outputs: Outputs) {
      if (!declaredPorts.has(port)) {
        throw new Error(`provider ${spec.id} does not declare port ${port}`);
      }
      // SAFETY: `return spec.client(port, outputs) as Clients[P];` is required at this I/O or test boundary.
      return spec.client(port, outputs) as Clients[P];
    },
    capabilityManifest() {
      return spec.capabilityManifest({
        id: spec.id,
        capabilities,
        optionBuilders: Object.keys(spec.with)
      });
    }
  };

  // SAFETY: `return Object.freeze(provider) as ProviderDefinition<Id, Capabilities, Clients, ` is required at this I/O or test boundary.
  return Object.freeze(provider) as ProviderDefinition<Id, Capabilities, Clients, Builders>;
}

export function createFixtureAwsProvider(): ProviderDefinition<
  "aws",
  readonly [CapabilitySpec<"database">, CapabilitySpec<"compute">],
  {
    readonly database: PortClient<"database", "aws"> & { readonly connectionString: string };
    readonly compute: PortClient<"compute", "aws"> & { readonly endpoint: unknown };
  },
  {
    readonly rds: ProviderOptionBuilder<"aws", "database", { readonly instanceClass: string }>;
    readonly fargate: ProviderOptionBuilder<"aws", "compute", { readonly cpu?: number }>;
  }
> {
  return defineProvider<"aws", readonly [
    CapabilitySpec<"database">,
    CapabilitySpec<"compute">
  ], {
    readonly database: PortClient<"database", "aws"> & { readonly connectionString: string };
    readonly compute: PortClient<"compute", "aws"> & { readonly endpoint: unknown };
  }, {
    readonly rds: ProviderOptionBuilder<"aws", "database", { readonly instanceClass: string }>;
    readonly fargate: ProviderOptionBuilder<"aws", "compute", { readonly cpu?: number }>;
  }>({
    id: "aws",
    capabilities: [
      { port: "database", stability: "stable" },
      { port: "compute", stability: "stable" }
    ] as const,
    with: {
      rds: createOptionBuilder<"aws", "database", { readonly instanceClass: string }>("aws", "database", "rds"),
      fargate: createOptionBuilder<"aws", "compute", { readonly cpu?: number }>("aws", "compute", "fargate")
    },
    client(port, outputs) {
      if (port === "database") {
        return {
          port,
          providerId: "aws",
          // SAFETY: `connectionString: outputs.endpoint as string` is required at this I/O or test boundary.
          connectionString: outputs.endpoint as string
        };
      }
      return {
        port,
        providerId: "aws",
        endpoint: outputs.endpoint
      };
    },
    capabilityManifest({ id, capabilities, optionBuilders }) {
      return {
        providerId: id,
        capabilities,
        auth: { mode: "brokered" },
        optionBuilders
      };
    }
  });
}

export function createFixtureAzureProvider(): ProviderDefinition<
  "azure",
  readonly [CapabilitySpec<"database">, CapabilitySpec<"compute">],
  {
    readonly database: PortClient<"database", "azure"> & { readonly endpoint: unknown };
    readonly compute: PortClient<"compute", "azure"> & { readonly endpoint: unknown };
  },
  {
    readonly postgres: ProviderOptionBuilder<"azure", "database", { readonly sku: string }>;
    readonly containerApp: ProviderOptionBuilder<"azure", "compute", { readonly cpu?: number }>;
  }
> {
  return defineProvider<"azure", readonly [
    CapabilitySpec<"database">,
    CapabilitySpec<"compute">
  ], {
    readonly database: PortClient<"database", "azure"> & { readonly endpoint: unknown };
    readonly compute: PortClient<"compute", "azure"> & { readonly endpoint: unknown };
  }, {
    readonly postgres: ProviderOptionBuilder<"azure", "database", { readonly sku: string }>;
    readonly containerApp: ProviderOptionBuilder<"azure", "compute", { readonly cpu?: number }>;
  }>({
    id: "azure",
    capabilities: [
      { port: "database", stability: "stable" },
      { port: "compute", stability: "stable" }
    ] as const,
    with: {
      postgres: createOptionBuilder<"azure", "database", { readonly sku: string }>("azure", "database", "postgres"),
      containerApp: createOptionBuilder<"azure", "compute", { readonly cpu?: number }>("azure", "compute", "containerApp")
    },
    client(port, outputs) {
      return {
        port,
        providerId: "azure",
        endpoint: outputs.endpoint
      };
    },
    capabilityManifest({ id, capabilities, optionBuilders }) {
      return {
        providerId: id,
        capabilities,
        auth: { mode: "brokered" },
        optionBuilders
      };
    }
  });
}

export function resolveProviderOptions<Id extends string>(
  provider: { readonly id: Id; readonly capabilities?: readonly CapabilitySpec[] },
  optionBlocks: readonly ProviderOptionBlock<string, PortKind, object>[]
) {
  const merged: { [port: string]: ResolvedProviderOption } = {};
  const dropped: DroppedProviderOption[] = [];
  const declaredPorts = new Set((provider.capabilities ?? []).map((capability) => capability.port));

  for (const block of optionBlocks) {
    if (block.providerId !== provider.id) {
      dropped.push({
        providerId: block.providerId,
        port: block.port,
        optionName: block.optionName,
        reason: `option block belongs to unresolved provider ${block.providerId}`
      });
      continue;
    }
    if (declaredPorts.size > 0 && !declaredPorts.has(block.port)) {
      throw new Error(`option block ${block.optionName} references undeclared port ${block.port}`);
    }

    merged[block.port] = {
      optionName: block.optionName,
      negotiation: block.negotiation,
      options: block.options
    };
  }

  return { merged, dropped };
}

export function mergeResolvedProviderOptions<const Provider extends { readonly id: string; readonly capabilities?: readonly CapabilitySpec[] }>(
  provider: Provider,
  optionBlocks: readonly ProviderOptionBlock<Provider["id"], PortKind, object>[]
): ReturnType<typeof resolveProviderOptions> {
  return resolveProviderOptions(provider, optionBlocks);
}

export function auditProviderCatalog(providers: readonly { readonly id: string; readonly with: JsonObject }[]) {
  const providersByOption = new Map<string, string[]>();

  for (const provider of providers) {
    for (const builder of Object.values(provider.with)) {
      // SAFETY: `const optionName = (builder as { readonly optionName: string }).optionName;` is required at this I/O or test boundary.
      const optionName = (builder as { readonly optionName: string }).optionName;
      if (!providersByOption.has(optionName)) {
        providersByOption.set(optionName, []);
      }
      providersByOption.get(optionName)?.push(provider.id);
    }
  }

  const conflicts = [...providersByOption.entries()]
    .filter(([, providerIds]) => providerIds.length > 1)
    .map(([optionName, providerIds]) => ({
      optionName,
      providers: providerIds.sort(),
      reason: "unqualified option builder name is ambiguous; use provider-scoped access"
    }));

  return {
    ok: conflicts.length === 0,
    conflicts
  };
}

export function validateProviderPackage(provider: JsonValue) {
  const errors: string[] = [];
  // SAFETY: `const candidate = provider as Partial<AnyProviderDefinition> | null | undefined;` is required at this I/O or test boundary.
  const candidate = provider as Partial<AnyProviderDefinition> | null | undefined;

  if (!candidate?.id) {
    errors.push("provider id is required");
  }
  if (!Array.isArray(candidate?.capabilities) || candidate.capabilities.length === 0) {
    errors.push("provider must declare at least one capability");
  }
  if (!candidate?.with || !isJsonObject(candidate.with)) {
    errors.push("provider must export scoped .with option builders");
  }
  if (!(candidate?.client instanceof Function)) {
    errors.push("provider must export a runtime client(port, outputs) function");
  }
  if (!(candidate?.capabilityManifest instanceof Function)) {
    errors.push("provider must export capabilityManifest()");
  }

  if (candidate?.client instanceof Function) {
    for (const capability of candidate.capabilities ?? []) {
      const client = candidate.client(capability.port, { endpoint: "fixture://endpoint" });
      if (!client || client.port !== capability.port || client.providerId !== candidate.id) {
        errors.push(`client(${capability.port}) returned untyped surface`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}
