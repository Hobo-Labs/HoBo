import { type JsonObject } from "./json.js";
export const MANIFEST_SCHEMA = "hobo.manifest/v1" as const;
export const RESOURCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const LAZY_TOKEN_PATTERN =
  /^\{([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;

export type ResourceId = string & { readonly __brand: "ResourceId" };

export function parseResourceId(raw: string): ResourceId {
  if (!RESOURCE_ID_PATTERN.test(raw)) {
    throw new TypeError(`invalid resource id: ${raw}`);
  }
  // SAFETY: assertion to `return raw as ResourceId;` is required at this boundary.
  return raw as ResourceId;
}

export interface ManifestLink {
  readonly import: string;
  readonly to: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BindingMeta proto message in data-models/.
export interface BindingMeta {
  readonly port: string;
  readonly resource: string;
  readonly clientType: string;
}

export interface ManifestResource {
  readonly type: string;
  readonly port?: string;
  readonly paradigm?: string;
  readonly connectionString?: string;
  readonly runtime?: string;
  readonly exports?: readonly string[];
  readonly links?: readonly ManifestLink[];
  readonly env?: Readonly<Record<string, string>>;
  readonly bindings?: Readonly<Record<string, BindingMeta>>;
  readonly image?: string;
  readonly build?: Readonly<JsonObject>;
  readonly endpoints?: Readonly<JsonObject>;
  readonly annotations?: Readonly<JsonObject>;
}

export interface HoboManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly resources: Readonly<Record<string, ManifestResource>>;
}

export type ResolvedEnv = Readonly<Record<string, string>>;
