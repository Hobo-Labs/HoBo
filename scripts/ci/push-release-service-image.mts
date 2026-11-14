#!/usr/bin/env node
/**
 * Builds one release image of the fleet's services (design §6.16): the
 * authority, the witness and the peer-to-peer relay, whose Dockerfiles live
 * under `deploy/release-images/<id>/` (L23). The image is exported as an OCI
 * image layout and promoted as release Freight into
 * hobo-release/oci-candidate through `hobo deploy`, exactly as
 * `push-release-ghcr-images.mts` publishes the train's other images: the
 * realizer is the only thing that pushes. Writes the published
 * `ghcr.io/...@sha256:...` reference to the digest list the release
 * workflow's attest step (`.github/actions/release-oci-attest`: build
 * provenance and a CycloneDX bill of materials, R18) reads.
 *
 * Only the full release train ships them; on an sdk-v or cli-v ref the digest
 * list is written empty and nothing is built.
 *
 * Build context: the authority and the witness get a staged `app/`
 * (`pnpm deploy` of `@hobo/fleet-authority`, with `bin/<name>` wrappers), as
 * `hobo-ci-serve` does; the relay gets an empty context, its Dockerfile
 * fetching its pinned, checksum-verified binary itself. Every Dockerfile
 * takes `HOBO_TOOLCHAIN_IMAGE`, `HOBO_RELEASE_VERSION` and
 * `HOBO_RELEASE_REVISION`.
 *
 * usage: HOBO_RELEASE_VERSION=<ref> GITHUB_REPOSITORY=<owner/repo>
 *   HOBO_RELEASE_CD_HOME=<release Freight journal>
 *   push-release-service-image.mts <image-id> <digest-list-path>
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ghcrImageTags, parseReleaseRef } from "../lib/release-version.mts";
import { exportReleaseOciLayout } from "./build-release-oci-image.mts";
import {
	publishReleaseGhcrImages,
	type ReleaseImage,
} from "./push-release-ghcr-images.mts";
import {
	type DeployStage,
	deployPackage,
	releaseOciStagingLocation,
} from "./stage-release-oci-app.mts";

const root = join(import.meta.dirname, "..", "..");

type ServiceImage = Readonly<{
	title: string;
	description: string;
	/** What the build context holds; `undefined` is an empty context. */
	stage: DeployStage | undefined;
}>;

const AUTHORITY_PACKAGE = {
	kind: "deploy",
	packageName: "@hobo/fleet-authority",
	buildFilter: "@hobo/fleet-authority...",
	appPath: "app",
} as const;

/** The release images of the fleet's services, in release order. */
export const SERVICE_IMAGES = {
	"hobo-fleet-authority": {
		title: "HoBo Fleet authority",
		description:
			"Enrollment, credentials, registry and auth callout for a HoBo fleet",
		stage: {
			...AUTHORITY_PACKAGE,
			wrappers: [
				{
					name: "hobo-fleet-authority",
					entrypoint: "dist/bin/hobo-fleet-authority.js",
				},
			],
		},
	},
	"hobo-fleet-witness": {
		title: "HoBo Fleet witness",
		description: "Co-signs the fleet audit chain's checkpoints",
		stage: {
			...AUTHORITY_PACKAGE,
			wrappers: [
				{
					name: "hobo-fleet-witness",
					entrypoint: "dist/bin/hobo-fleet-witness.js",
				},
			],
		},
	},
	"hobo-fleet-relay": {
		title: "HoBo Fleet relay",
		description: "Peer-to-peer relay for HoBo fleet devices",
		stage: undefined,
	},
} as const satisfies Record<string, ServiceImage>;

export type ServiceImageId = keyof typeof SERVICE_IMAGES;

export const SERVICE_IMAGE_IDS: readonly ServiceImageId[] = [
	"hobo-fleet-authority",
	"hobo-fleet-witness",
	"hobo-fleet-relay",
];

export function parseServiceImageId(value: string): ServiceImageId {
	const id = SERVICE_IMAGE_IDS.find((candidate) => candidate === value);
	if (id === undefined)
		throw new Error(
			`unknown service image id: ${value} (one of ${SERVICE_IMAGE_IDS.join(", ")})`,
		);
	return id;
}

/** The Dockerfile L23 writes for an image. */
export function serviceImageDockerfile(id: ServiceImageId): string {
	return `deploy/release-images/${id}/Dockerfile`;
}

/** The local tag a build leaves for the layout export, removed after. */
export function serviceImageCandidateTag(id: ServiceImageId): string {
	return `${id}:candidate`;
}

/** The `docker build` arguments for one image. */
export function serviceImageBuildArgs(input: {
	id: ServiceImageId;
	toolchain: string;
	version: string;
	revision: string;
	contextDir: string;
}): string[] {
	const image = SERVICE_IMAGES[input.id];
	const labels = [
		"org.opencontainers.image.source=https://github.com/Hobo-Labs/HoBo",
		`org.opencontainers.image.version=${input.version}`,
		`org.opencontainers.image.revision=${input.revision}`,
		"org.opencontainers.image.licenses=MIT",
		`org.opencontainers.image.title=${image.title}`,
		`org.opencontainers.image.description=${image.description}`,
		`io.hobo.release.image=${input.id}`,
	];
	return [
		"build",
		"-f",
		join(root, serviceImageDockerfile(input.id)),
		"--build-arg",
		`HOBO_TOOLCHAIN_IMAGE=${input.toolchain}`,
		"--build-arg",
		`HOBO_RELEASE_VERSION=${input.version}`,
		"--build-arg",
		`HOBO_RELEASE_REVISION=${input.revision}`,
		...labels.flatMap((label) => ["--label", label]),
		"-t",
		serviceImageCandidateTag(input.id),
		input.contextDir,
	];
}

/** Whether a release ref's train ships the service images: only the full one does. */
export function shipsServiceImages(releaseRef: string): boolean {
	return parseReleaseRef(releaseRef).train === "full";
}

function run(command: string, args: readonly string[]): void {
	const result = spawnSync(command, args, {
		cwd: root,
		env: { ...process.env, CI: "1" },
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

/** Builds one image and exports it as an OCI layout; nothing is pushed here. */
export function buildServiceImage(input: {
	id: ServiceImageId;
	releaseRef: string;
	repository: string;
	revision: string;
	toolchain: string;
}): ReleaseImage {
	const parsed = parseReleaseRef(input.releaseRef);
	const [tag] = ghcrImageTags(input.repository, input.id, parsed);
	if (tag === undefined) throw new Error(`no GHCR tag for ${input.id}`);
	const staging = releaseOciStagingLocation(input.id, { root });
	rmSync(staging.stagingRoot, { recursive: true, force: true });
	mkdirSync(staging.stagingRoot, { recursive: true });
	try {
		const stage = SERVICE_IMAGES[input.id].stage;
		if (stage !== undefined)
			deployPackage(root, staging.stagingRoot, stage, false, staging.hardlink);
		writeFileSync(
			join(staging.stagingRoot, ".dockerignore"),
			stage === undefined
				? "*\n!.dockerignore\n"
				: "*\n!.dockerignore\n!app/\n!app/**\n",
		);
		run(
			"docker",
			serviceImageBuildArgs({
				id: input.id,
				toolchain: input.toolchain,
				version: parsed.semver,
				revision: input.revision,
				contextDir: staging.stagingRoot,
			}),
		);
	} finally {
		rmSync(staging.stagingRoot, { recursive: true, force: true });
	}
	const candidate = serviceImageCandidateTag(input.id);
	const layoutDir = mkdtempSync(
		join(process.env.RUNNER_TEMP?.trim() || tmpdir(), `hobo-oci-${input.id}-`),
	);
	try {
		const layout = exportReleaseOciLayout(candidate, layoutDir);
		const repository = tag.slice(0, tag.lastIndexOf(":"));
		return {
			id: input.id,
			line: `${repository}@${layout.digest}`,
			layout,
			layoutDir,
		};
	} catch (error) {
		rmSync(layoutDir, { recursive: true, force: true });
		throw error;
	} finally {
		spawnSync("docker", ["image", "rm", "--force", candidate], {
			stdio: "ignore",
		});
	}
}

async function main(): Promise<void> {
	const [value, digestListPath] = process.argv.slice(2);
	const releaseRef = process.env.HOBO_RELEASE_VERSION?.trim() ?? "";
	const repository = process.env.GITHUB_REPOSITORY?.trim() ?? "";
	const freightHome = process.env.HOBO_RELEASE_CD_HOME?.trim() ?? "";
	if (!value || !digestListPath || !releaseRef || !repository || !freightHome) {
		console.error(
			"usage: HOBO_RELEASE_VERSION=... GITHUB_REPOSITORY=... HOBO_RELEASE_CD_HOME=... push-release-service-image.mts <image-id> <digest-list-path>",
		);
		process.exit(2);
	}
	const id = parseServiceImageId(value);
	if (!shipsServiceImages(releaseRef)) {
		console.log(`${releaseRef} does not ship ${id}; nothing to publish`);
		writeFileSync(digestListPath, "", "utf8");
		return;
	}
	const revision =
		process.env.HOBO_RELEASE_REVISION?.trim() ||
		process.env.GITHUB_SHA?.trim() ||
		"";
	if (!revision)
		throw new Error("HOBO_RELEASE_REVISION or GITHUB_SHA required to publish");
	const image = buildServiceImage({
		id,
		releaseRef,
		repository,
		revision,
		toolchain:
			process.env.HOBO_RELEASE_TOOLCHAIN_IMAGE?.trim() ||
			process.env.HOBO_CI_WORKER_IMAGE?.trim() ||
			"hobo-ci-worker:local",
	});
	try {
		await publishReleaseGhcrImages({
			releaseRef,
			repository,
			freightHome,
			images: [image],
			imageId: id,
		});
	} finally {
		if (image.layoutDir)
			rmSync(image.layoutDir, { recursive: true, force: true });
	}
	// Written only once the Camp qualified: the digest GHCR serves.
	writeFileSync(digestListPath, `${image.line}\n`, "utf8");
	console.log(image.line);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(
			`::error::${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
