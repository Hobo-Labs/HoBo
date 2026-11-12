// The two reference hobo:resolver components, plus a helper that builds one
// into bytes + a manifest to sign through the componentize recipe.
import {
	type BuiltResolverComponent,
	buildResolverComponent,
	componentizeResolver,
} from "../build/index.js";
import type { ResolverGuestModule } from "../guest/types.js";
import type { JsonObject } from "../json.js";
import {
	HTTP_ARTIFACT_UPLOAD_ID,
	HTTP_ARTIFACT_UPLOAD_SOURCE,
	HTTP_ARTIFACT_UPLOAD_VERSION,
	type HttpUploadHost,
	httpArtifactUploadGuest,
	httpArtifactUploadManifest,
} from "./http-artifact-upload/index.js";
import {
	SFTP_STATIC_ID,
	SFTP_STATIC_SOURCE,
	SFTP_STATIC_VERSION,
	type SftpBridgeOptions,
	sftpStaticGuest,
	sftpStaticManifest,
} from "./sftp-static/index.js";

export * from "./http-artifact-upload/index.js";
export * from "./sftp-static/index.js";

export interface ReferenceComponent {
	readonly id: string;
	readonly version: string;
	readonly source: string;
	readonly guest: ResolverGuestModule;
	readonly manifest: JsonObject;
}

export function httpArtifactUpload(hosts: readonly HttpUploadHost[]): ReferenceComponent {
	return Object.freeze({
		id: HTTP_ARTIFACT_UPLOAD_ID,
		version: HTTP_ARTIFACT_UPLOAD_VERSION,
		source: HTTP_ARTIFACT_UPLOAD_SOURCE,
		guest: httpArtifactUploadGuest,
		manifest: httpArtifactUploadManifest(hosts),
	});
}

export function sftpStatic(options: SftpBridgeOptions = {}): ReferenceComponent {
	const host = options.host ?? "sftp-bridge.hobo.local";
	const port = options.port ?? "8443";
	return Object.freeze({
		id: SFTP_STATIC_ID,
		version: SFTP_STATIC_VERSION,
		source: SFTP_STATIC_SOURCE,
		guest: sftpStaticGuest(`https://${host}:${port}`),
		manifest: sftpStaticManifest(options),
	});
}

/** Componentize a reference component (synthetic lane) and stamp its manifest. */
export function buildReferenceComponent(component: ReferenceComponent): BuiltResolverComponent {
	const wasm = componentizeResolver({
		componentId: component.id,
		version: component.version,
		source: component.source,
	});
	return buildResolverComponent(component.manifest, wasm);
}
