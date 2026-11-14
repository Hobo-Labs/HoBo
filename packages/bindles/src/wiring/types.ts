import type { JsonObject } from "../json.js";
import { MANIFEST_SCHEMA } from "../manifest/index.js";

export { MANIFEST_SCHEMA };

export const RESOURCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const LAZY_TOKEN_PATTERN =
	/^\{([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;

export interface ManifestLink {
	readonly import: string;
	readonly to: string;
}

// domain-view: readonly parse-don't-validate view over the generated wire form.
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
	readonly build?: JsonObject;
	readonly endpoints?: JsonObject;
	readonly annotations?: JsonObject;
	readonly bind?: readonly string[];
}

export interface WiringManifest {
	readonly schema: typeof MANIFEST_SCHEMA;
	readonly resources: Readonly<Record<string, ManifestResource>>;
}
