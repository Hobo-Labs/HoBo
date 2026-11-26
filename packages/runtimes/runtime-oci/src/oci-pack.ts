import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonBag } from "./json.js";

export const WASM_COMPONENT_MEDIA_TYPE =
	"application/vnd.wasm.component.v1+wasm" as const;

export interface OciPackResult {
	/** Local filesystem layout root (OCI image layout-ish). */
	readonly layoutDir: string;
	/** Stable local image reference for manifests. */
	readonly imageRef: string;
	readonly digest: string;
	readonly mediaType: typeof WASM_COMPONENT_MEDIA_TYPE;
	readonly wasmPath: string;
	readonly resourceName: string;
}

/**
 * Pack a wasi:http component .wasm into a local OCI layout under HOBO_HOME.
 * Does not push to a registry — provenance is recorded on Deployment annotations.
 */
export function packWasmAsOci(options: {
	readonly hoboHome: string;
	readonly resourceName: string;
	readonly wasmPath: string;
}): OciPackResult {
	if (!existsSync(options.wasmPath)) {
		throw new Error(`oci pack: wasm not found at ${options.wasmPath}`);
	}
	const bytes = readFileSync(options.wasmPath);
	const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const short = digest.slice("sha256:".length, "sha256:".length + 16);
	const layoutDir = join(options.hoboHome, "oci", options.resourceName, short);
	mkdirSync(layoutDir, { recursive: true });
	const blobPath = join(layoutDir, "component.wasm");
	writeFileSync(blobPath, bytes);
	const manifest = {
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		config: {
			mediaType: "application/vnd.wasm.config.v0+json",
			digest,
			size: bytes.byteLength,
		},
		layers: [
			{
				mediaType: WASM_COMPONENT_MEDIA_TYPE,
				digest,
				size: bytes.byteLength,
				annotations: {
					"org.opencontainers.image.title": options.resourceName,
				},
			},
		],
		annotations: {
			"hobo.dev/resource": options.resourceName,
			"hobo.dev/media-type": WASM_COMPONENT_MEDIA_TYPE,
		},
	};
	writeFileSync(
		join(layoutDir, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
		"utf8",
	);
	const imageRef = `oci://hobo.local/${options.resourceName}@${digest}`;
	writeFileSync(
		join(layoutDir, "index.json"),
		`${JSON.stringify({ imageRef, digest, wasm: "component.wasm" }, null, "\t")}\n`,
		"utf8",
	);
	return {
		layoutDir,
		imageRef,
		digest,
		mediaType: WASM_COMPONENT_MEDIA_TYPE,
		wasmPath: options.wasmPath,
		resourceName: options.resourceName,
	};
}

export function deploymentManifests(options: {
	readonly resourceName: string;
	readonly imageRef: string;
	readonly namespace: string;
	readonly bindleEnv?: Readonly<Record<string, string>>;
	readonly labels?: Readonly<Record<string, string>>;
	readonly containerPort?: number;
	readonly containerCommand?: readonly string[];
	readonly containerArgs?: readonly string[];
}): readonly unknown[] {
	const name = sanitizeK8sName(options.resourceName);
	const labels = {
		"hobo.dev/resource": options.resourceName,
		"hobo.dev/host": "oci",
		...options.labels,
	};
	const env = Object.entries(options.bindleEnv ?? {}).map(([k, v]) => ({
		name: k,
		value: v,
	}));
	const containerPort = options.containerPort ?? 8080;
	const container: JsonBag = {
		name: "component",
		image: options.imageRef,
		ports: [{ containerPort }],
		env,
		// Keep the pod Ready without an app-level probe when the runtime image
		// only holds the process open (wasm runners set their own probes).
		readinessProbe: {
			exec: { command: ["true"] },
			initialDelaySeconds: 0,
			periodSeconds: 5,
		},
	};
	if (options.containerCommand !== undefined) {
		container.command = [...options.containerCommand];
	}
	if (options.containerArgs !== undefined) {
		container.args = [...options.containerArgs];
	}
	return [
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name, namespace: options.namespace, labels },
			spec: {
				replicas: 1,
				selector: {
					matchLabels: { "hobo.dev/resource": options.resourceName },
				},
				template: {
					metadata: { labels },
					spec: {
						containers: [container],
					},
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name, namespace: options.namespace, labels },
			spec: {
				selector: { "hobo.dev/resource": options.resourceName },
				ports: [{ port: containerPort, targetPort: containerPort }],
			},
		},
	];
}

function sanitizeK8sName(name: string): string {
	const cleaned = name
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 63) : "component";
}
