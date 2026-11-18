import {
	canonicalManifestHash,
	type ManifestV1,
	parseManifest,
} from "@hobo/bindles";

type FuzzObject = { readonly [key: string]: FuzzValue };
type FuzzArray = readonly FuzzValue[];
export type FuzzValue =
	| FuzzObject
	| FuzzArray
	| Date
	| RegExp
	| Map<FuzzValue, FuzzValue>
	| Set<FuzzValue>
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined;

type ManifestResource = {
	readonly type: string;
	readonly port?: string;
	readonly paradigm?: string;
	readonly allow?: readonly string[];
	readonly bind?: readonly string[];
	readonly image?: string;
	readonly runtime?: string;
	readonly exports?: readonly string[];
	readonly links?: readonly { readonly import: string; readonly to: string }[];
};

type SampleManifestRecord = {
	readonly schema: "hobo.manifest/v1";
	readonly componentHost: { readonly kind: string; readonly version: string };
	readonly resources: Record<string, ManifestResource>;
};

export function sampleManifestRecord(
	resourceOrder: readonly string[] = ["db", "api"],
): SampleManifestRecord {
	const resources: Record<string, ManifestResource> = {};
	for (const id of resourceOrder) {
		if (id === "db") {
			resources.db = {
				type: "data.v1",
				port: "hobo:data",
				paradigm: "relational",
				allow: ["query"],
			};
		} else if (id === "site") {
			resources.site = {
				type: "website.v1",
				bind: ["api"],
			};
		} else {
			resources[id] = {
				type: "component.v1",
				image: "oci://registry.example.com/api@sha256:abc123",
				runtime: "wasm",
				exports: ["wasi:http/incoming-handler"],
				links: [{ import: "hobo:data", to: "db" }],
			};
		}
	}
	return {
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasmtime", version: "1.0.0" },
		resources,
	};
}

export function hashManifest(input: FuzzValue): string {
	return canonicalManifestHash(parseManifest(input));
}

export function parseOrReject(input: FuzzValue): ManifestV1 | "rejected" {
	try {
		return parseManifest(input);
	} catch {
		return "rejected";
	}
}

export function hasPrototypePollution(
	value: FuzzValue,
	seen: WeakSet<object> = new WeakSet(),
): boolean {
	const pending: FuzzValue[] = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || Object(current) !== current) continue;
		const currentObject: object = Object(current);
		if (seen.has(currentObject)) continue;
		seen.add(currentObject);
		if (
			Object.hasOwn(currentObject, "__proto__") ||
			Object.hasOwn(currentObject, "constructor")
		)
			return true;
		for (const entry of Object.values(currentObject)) pending.push(entry);
	}
	return false;
}
