import { type JsonValue } from "./json.js";
export declare const CONFIG_SCHEMA_VERSION: "hobo.config/v1";

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

export type ConfigContract<TEntries extends Record<string, ConfigEntry>> = {
  readonly schema: typeof CONFIG_SCHEMA_VERSION;
  readonly entries: TEntries;
};

export type ConfigContext<TContract extends ConfigContract<Record<string, ConfigEntry>>> = {
  readonly config: {
    readonly [Key in keyof TContract["entries"]]: () => Promise<ConfigValue<TContract["entries"][Key]>>;
  };
};

export type ConfigValue<TEntry extends ConfigEntry> =
  TEntry["type"] extends "number" ? number :
  TEntry["type"] extends "boolean" ? boolean :
  string;

export type ConfigManifest = {
  readonly schema: typeof CONFIG_SCHEMA_VERSION;
  readonly entries: Record<string, {
    readonly type: "string" | "number" | "boolean";
    readonly required: boolean;
    readonly sensitivity: "secretless" | "secret" | "config";
    readonly source: {
      readonly kind: "binding" | "secret-ref" | "camp-env";
      readonly ref: string;
      readonly devOnly: boolean;
    };
    readonly defaultType?: "string" | "number" | "boolean";
    readonly productionDeployable?: false;
  }>;
};

export declare function fromBinding(name: string, options?: { required?: boolean; devOnly?: boolean }): ConfigEntry<"string">;
export declare function secretRef(ref: string, options?: { required?: boolean; devOnly?: boolean }): ConfigEntry<"string">;
export declare function env<const TValue extends string | number | boolean>(
  defaultValue: TValue,
  options?: { required?: boolean; devOnly?: boolean; ref?: string }
): ConfigEntry<TValue extends number ? "number" : TValue extends boolean ? "boolean" : "string">;
export declare function secret(name: string): {
  readonly kind: "managed-secret-store";
  readonly name: string;
  readonly portRef: "hobo:secrets";
};
export declare function config<const TEntries extends Record<string, ConfigEntry>>(entries: TEntries): ConfigContract<TEntries>;
export declare function emitConfigManifest(contract: ConfigContract<Record<string, ConfigEntry>>): ConfigManifest;
export declare function createConfigContext<const TContract extends ConfigContract<Record<string, ConfigEntry>>>(
  contract: TContract,
  resolver?: (
    key: keyof TContract["entries"] & string,
    entry: TContract["entries"][keyof TContract["entries"]]
  ) => Promise<ConfigValue<TContract["entries"][keyof TContract["entries"]]>> | ConfigValue<TContract["entries"][keyof TContract["entries"]]>
): ConfigContext<TContract>;
export declare function serializeConfigManifest(manifest: ConfigManifest): string;
export declare function scanSerializedManifestForValues(manifest: JsonValue, values: string[]): string[];
export declare function canonicalJson(value: JsonValue): string;
