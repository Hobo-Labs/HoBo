import { type JsonValue, type JsonObject } from "./json.js";
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

export function createOptionBuilder<
  const Id extends string,
  const Port extends PortKind,
  Options extends object
>(providerId: Id, port: Port, optionName: string): ProviderOptionBuilder<Id, Port, Options>;

export function defineProvider<
  const Id extends string,
  const Capabilities extends readonly CapabilitySpec[],
  Clients extends ClientMap<CapabilityPorts<Capabilities>, Id>,
  Builders extends ProviderOptionBuilders<Id, Capabilities>
>(spec: ProviderSpec<Id, Capabilities, Clients, Builders>): ProviderDefinition<Id, Capabilities, Clients, Builders>;

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
>;

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
>;

export function resolveProviderOptions<Id extends string>(
  provider: { readonly id: Id },
  optionBlocks: readonly ProviderOptionBlock<string, PortKind, object>[]
): {
  readonly merged: Record<string, { readonly optionName: string; readonly negotiation: Negotiation; readonly options: object }>;
  readonly dropped: readonly {
    readonly providerId: string;
    readonly port: PortKind;
    readonly optionName: string;
    readonly reason: string;
  }[];
};

export function mergeResolvedProviderOptions<const Provider extends { readonly id: string }>(
  provider: Provider,
  optionBlocks: readonly ProviderOptionBlock<Provider["id"], PortKind, object>[]
): ReturnType<typeof resolveProviderOptions>;

export function auditProviderCatalog(providers: readonly { readonly id: string; readonly with: JsonObject }[]): {
  readonly ok: boolean;
  readonly conflicts: readonly {
    readonly optionName: string;
    readonly providers: readonly string[];
    readonly reason: string;
  }[];
};

export function validateProviderPackage(provider: JsonValue): {
  readonly ok: boolean;
  readonly errors: readonly string[];
};
