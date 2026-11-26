export const CONFIG_SCHEMA_VERSION = "hobo.config/v1" as const;

export type ConfigValueType = "string" | "number" | "boolean";

export type ConfigEntry<TType extends ConfigValueType = ConfigValueType> = {
  readonly kind: "from-binding" | "secret-ref" | "env";
  readonly type: TType;
  readonly required: boolean;
  readonly sensitivity: "secretless" | "secret" | "config";
  readonly source: {
    readonly kind: "binding" | "secret-ref" | "camp-env";
    readonly ref?: string;
    readonly devOnly: boolean;
  };
  readonly defaultType?: TType;
};

export type ConfigContract<TEntries extends Record<string, ConfigEntry> = Record<string, ConfigEntry>> = {
  readonly schema: typeof CONFIG_SCHEMA_VERSION;
  readonly entries: TEntries;
};

// domain-view: parse-produced draft-proof record; its wire form is the ConfigManifestEntry proto message in data-models/.
export type ConfigManifestEntry = {
  readonly type: ConfigValueType;
  readonly required: boolean;
  readonly sensitivity: "secretless" | "secret" | "config";
  readonly source: {
    readonly kind: "binding" | "secret-ref" | "camp-env";
    readonly ref: string;
    readonly devOnly: boolean;
  };
  readonly defaultType?: ConfigValueType;
  readonly productionDeployable?: false;
};

// domain-view: parse-produced draft-proof record; its wire form is the ConfigManifest proto message in data-models/.
export type ConfigManifest = {
  readonly schema: typeof CONFIG_SCHEMA_VERSION;
  readonly entries: Record<string, ConfigManifestEntry>;
};

export type ConfigAccessors<TContract extends ConfigContract> = {
  readonly [Key in keyof TContract["entries"] & string]: () => Promise<ConfigValue<TContract["entries"][Key]>>;
};

export type ConfigValue<TEntry extends ConfigEntry> =
  TEntry["type"] extends "number" ? number :
  TEntry["type"] extends "boolean" ? boolean :
  string;

export type ConfigResolvedSource =
  | "bound-resource"
  | "secret-store"
  | "camp-env"
  | "dev-secret"
  | "static-secret-hatch";

export type ConfigResolvedEvent = {
  readonly type: "config.Resolved";
  readonly id: string;
  readonly data: {
    readonly key: string;
    readonly ref: string;
    readonly source: ConfigResolvedSource;
    readonly camp: string;
  };
};

export type SecretAccessedEvent = {
  readonly type: "secret.Accessed";
  readonly id: string;
  readonly data: {
    readonly ref: string;
    readonly camp: string;
    readonly source: string;
    readonly accessorId?: string;
    readonly productionDeployable: false;
  };
};

export type SecretUnavailableEvent = {
  readonly type: "secret.Unavailable";
  readonly id: string;
  readonly data: {
    readonly ref: string;
    readonly camp: string;
    readonly reason: string;
  };
};

export type ConfigAuditEvent = ConfigResolvedEvent | SecretAccessedEvent | SecretUnavailableEvent;
