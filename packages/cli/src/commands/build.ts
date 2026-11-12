import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { canonicalManifestHash, serializeManifest } from "@hobo/bindles";
import type { CdContext } from "@hobo/cd";
import {
	ArtifactKind,
	type ArtifactRef,
	FREIGHT_MANIFEST_SCHEMA,
	FreightManifestRecordSchema,
} from "@hobo/cd";
import { BuildError, remediationFor } from "../build/errors.js";
import type {
	ArtifactKind as BuildArtifactKind,
	BuildResult,
} from "../build/parse.js";
import { parseBuildRequestFromInvocation } from "../build/parse.js";
import { type RunBuildOptions, runBuild } from "../build/run-build.js";
import { deploymentIdFor, loadProjectManifest } from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import {
	DECLARATION_ARTIFACT,
	DECLARATION_MEDIA_TYPE,
	FREIGHT_FILE,
	type YardDelivery,
	type YardSession,
} from "../cloud/yard-client.js";
import type { JsonObject } from "../json.js";
import type { CommandModule } from "../shell/registry.js";
import type { CommandResult } from "../types/envelope.js";

export { BuildCliError, BuildError } from "../build/errors.js";
export {
	type BuildRequest,
	type BuildResult,
	parseBuildManifest,
	parseBuildRequestFromInvocation,
	parseServiceDeclaration,
} from "../build/parse.js";
export {
	BUILD_MANIFEST_PATH,
	runBuild,
	writeBuildFixtureProject,
} from "../build/run-build.js";

// public-contract: build artifact kind -> Freight ArtifactKind (cd.proto).
export const FREIGHT_ARTIFACT_KIND: Readonly<
	Record<BuildArtifactKind, ArtifactKind>
> = Object.freeze({
	"wasm-component": ArtifactKind.WASM_COMPONENT,
	"oci-container": ArtifactKind.OCI_IMAGE,
	"node-app": ArtifactKind.FUNCTION_BUNDLE,
});

// public-contract: typed refusals of the Freight step of `hobo build`.
export const BUILD_FREIGHT_REFUSAL = Object.freeze({
	digestMismatch: "HOBO_BUILD_FREIGHT_DIGEST_MISMATCH",
	unreadable: "HOBO_BUILD_FREIGHT_ARTIFACT_UNREADABLE",
	declarationMismatch: "HOBO_BUILD_FREIGHT_DECLARATION_MISMATCH",
	manifestRefused: "HOBO_BUILD_FREIGHT_MANIFEST_REFUSED",
} as const);

export interface BuildCommandOptions
	extends Pick<
		RunBuildOptions,
		| "componentize"
		| "realComponentizeFactory"
		| "requireRealComponentize"
		| "containerBuild"
	> {
	/**
	 * @hobo/cd delivery (plan 0024 D13). When present, `hobo build` stores
	 * every artifact's bytes in the configured artifact store and writes
	 * `.hobo/freight.json` with the injected `writeFreightManifest`.
	 */
	readonly delivery?: YardDelivery;
	/** Principal attributed in the artifact store; defaults to the persisted session. */
	readonly session?: YardSession;
}

type FreightEmitted =
	| Readonly<{ ok: true; data: JsonObject }>
	| Readonly<{
			ok: false;
			code: string;
			message: string;
			remediation: string[];
			detail: JsonObject;
	  }>;

/**
 * Store the build's bytes and declaration, then write the Freight manifest.
 * Nothing is written to `.hobo/freight.json` unless every artifact stored
 * under the digest the build recorded (fail closed: bytes are identical
 * everywhere, D2).
 */
async function emitFreight(
	projectRoot: string,
	build: BuildResult,
	delivery: YardDelivery,
	session: YardSession,
): Promise<FreightEmitted> {
	const bindle = await loadProjectManifest(projectRoot);
	if (!bindle)
		return {
			ok: true,
			data: {
				skipped:
					"no hobo.manifest/v1 declaration in this project; `hobo up` records Freight from the declaration it deploys",
			},
		};
	const { cd } = delivery;
	const ctx: CdContext = {
		tenant: session.tenant,
		principal: session.principal,
		now: delivery.now ?? (() => Date.now()),
	};
	const artifacts: ArtifactRef[] = [];
	for (const artifact of build.artifacts) {
		let bytes: Uint8Array;
		try {
			bytes = await readFile(join(projectRoot, artifact.path));
		} catch (error) {
			return {
				ok: false,
				code: BUILD_FREIGHT_REFUSAL.unreadable,
				message: `artifact ${artifact.service} at ${artifact.path} could not be read for the artifact store`,
				remediation: [
					"Run `hobo build` again; do not edit .hobo/build by hand.",
				],
				detail: {
					service: artifact.service,
					path: artifact.path,
					cause: error instanceof Error ? error.message : String(error),
				},
			};
		}
		const stored = await cd.artifacts.put(
			bytes,
			{
				name: artifact.service,
				kind: FREIGHT_ARTIFACT_KIND[artifact.kind],
				mediaType: artifact.mediaType,
			},
			ctx,
		);
		if (stored.digest !== artifact.digest)
			return {
				ok: false,
				code: BUILD_FREIGHT_REFUSAL.digestMismatch,
				message: `the ${cd.artifacts.backend} artifact store addressed ${artifact.service} as ${stored.digest}; the build recorded ${artifact.digest}`,
				remediation: [
					"Configure an artifact store that addresses bytes by their sha256 digest.",
					"Then run `hobo build` again; no Freight was written.",
				],
				detail: {
					service: artifact.service,
					stored: stored.digest,
					built: artifact.digest,
				},
			};
		artifacts.push(stored);
	}
	const declarationHash = canonicalManifestHash(bindle);
	const declaration = await cd.artifacts.put(
		new TextEncoder().encode(serializeManifest(bindle)),
		{
			name: DECLARATION_ARTIFACT,
			kind: ArtifactKind.SOURCE_TREE,
			mediaType: DECLARATION_MEDIA_TYPE,
		},
		ctx,
	);
	if (declaration.digest !== declarationHash)
		return {
			ok: false,
			code: BUILD_FREIGHT_REFUSAL.declarationMismatch,
			message: `the artifact store addressed the declaration as ${declaration.digest}; expected ${declarationHash}`,
			remediation: [
				"Configure an artifact store that addresses bytes by their sha256 digest.",
			],
			detail: { stored: declaration.digest, expected: declarationHash },
		};
	const manifest = create(FreightManifestRecordSchema, {
		schemaVersion: FREIGHT_MANIFEST_SCHEMA,
		bindle: deploymentIdFor(projectRoot),
		declarationHash,
		artifacts,
	});
	let document: Uint8Array;
	try {
		document = delivery.freightManifest.write(manifest);
	} catch (error) {
		return {
			ok: false,
			code: BUILD_FREIGHT_REFUSAL.manifestRefused,
			message: `the Freight manifest was refused: ${error instanceof Error ? error.message : String(error)}`,
			remediation: [
				"Fix the build inputs named in the message, then run `hobo build` again.",
			],
			detail: {},
		};
	}
	const target = join(projectRoot, FREIGHT_FILE);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, document);
	return {
		ok: true,
		data: {
			path: FREIGHT_FILE,
			bindle: manifest.bindle,
			declarationHash,
			artifacts: artifacts.map((item) => ({
				name: item.name,
				kind: ArtifactKind[item.kind] ?? "UNSPECIFIED",
				digest: item.digest,
				coordinate: item.coordinate,
			})),
			store: cd.artifacts.backend,
		},
	};
}

export function createBuildCommand(
	options: BuildCommandOptions = {},
): CommandModule {
	const { delivery, session: fixedSession, ...buildOptions } = options;
	return {
		run: async ({ context, flags }): Promise<CommandResult> => {
			try {
				const request = parseBuildRequestFromInvocation(
					context,
					flags,
					process.env,
				);
				const result = await runBuild({ ...request, ...buildOptions });
				let freight: JsonObject | undefined;
				if (delivery) {
					const session =
						fixedSession ??
						(await loadSession(request.projectRoot)) ??
						createFixtureSession();
					const emitted = await emitFreight(
						request.projectRoot,
						result,
						delivery,
						session,
					);
					if (!emitted.ok)
						return {
							ok: false,
							status: "error",
							code: emitted.code,
							message: emitted.message,
							remediation: emitted.remediation,
							data: { command: "build", detail: emitted.detail },
						};
					freight = emitted.data;
				}
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `hobo build ok (${result.artifacts.length} artifacts)`,
					data: {
						command: "build",
						manifest: result.manifest,
						manifestDigest: result.manifestDigest,
						runtimeTarget: request.targetRuntime,
						artifacts: result.artifacts,
						...(freight ? { freight } : {}),
					},
				};
			} catch (error) {
				if (error instanceof BuildError) {
					return {
						ok: false,
						status: "error",
						code: error.code,
						message: error.message,
						remediation: remediationFor(error),
						data: { detail: error.detail },
					};
				}
				throw error;
			}
		},
	};
}
