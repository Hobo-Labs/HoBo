import { readFileSync } from "node:fs";
import { join } from "node:path";

export const OCI_IMAGES_MANIFEST = "release/oci-images.json";

export type ReleaseOciImage = {
	id: string;
	name: string;
	title: string;
	description: string;
	dockerfile: string;
	workdir: string;
	user: string;
	entrypoint: string[];
	cmd: string[];
	versionProbe?: string[];
	expose?: number[];
	healthcheckPath?: string;
	healthcheckPort?: number;
	volumes?: string[];
	envDoc?: string[];
};

export type ReleaseOciManifest = {
	owner: string;
	repositoryPrefix: string;
	toolchainImageEnv: string;
	defaultToolchainTag: string;
	images: ReleaseOciImage[];
};

export function loadReleaseOciManifest(root: string): ReleaseOciManifest {
	const raw: unknown = JSON.parse(
		readFileSync(join(root, OCI_IMAGES_MANIFEST), "utf8"),
	);
	// SAFETY: `release/oci-images.json` is repo-owned; vitest manifest contract rejects drift.
	return raw as ReleaseOciManifest;
}

export function ghcrRepository(
	manifest: ReleaseOciManifest,
	image: ReleaseOciImage,
): string {
	return `${manifest.repositoryPrefix}/${image.name}`;
}

export type ImageConfigExpectation = {
	user: string;
	workingDir: string;
	entrypoint: string[];
	cmd: string[];
	exposedPorts: number[];
	volumes: string[];
	labels: string[];
};

export function expectedConfig(
	manifest: ReleaseOciManifest,
	image: ReleaseOciImage,
	revision: string,
	version: string,
): ImageConfigExpectation {
	const repo = ghcrRepository(manifest, image);
	return {
		user: image.user,
		workingDir: image.workdir,
		entrypoint: image.entrypoint,
		cmd: image.cmd,
		exposedPorts: image.expose ?? [],
		volumes: image.volumes ?? [],
		labels: [
			`org.opencontainers.image.source=https://github.com/Hobo-Labs/HoBo`,
			`org.opencontainers.image.version=${version}`,
			`org.opencontainers.image.revision=${revision}`,
			`org.opencontainers.image.licenses=MIT`,
			`org.opencontainers.image.title=${image.title}`,
			`org.opencontainers.image.description=${image.description}`,
			`io.hobo.release.image=${image.id}`,
			`io.hobo.release.repository=${repo}`,
		],
	};
}

export type DockerEmptyObject = Record<string, Record<string, never>>;

export type DockerInspectConfig = {
	User?: string;
	WorkingDir?: string;
	Entrypoint?: string[] | null;
	Cmd?: string[] | null;
	ExposedPorts?: DockerEmptyObject;
	Volumes?: DockerEmptyObject;
	Labels?: Record<string, string>;
	Healthcheck?: { Test?: string[] | null };
};

export type ConfigCheck = { name: string; ok: boolean; detail?: string };

export function evaluateImageConfig(
	expected: ImageConfigExpectation,
	actual: DockerInspectConfig,
): ConfigCheck[] {
	const checks: ConfigCheck[] = [];
	const uid = expected.user.split(":")[0] ?? expected.user;
	checks.push({
		name: "user:non-root",
		ok: Boolean(actual.User) && actual.User !== "0" && actual.User !== "root",
		detail: `User=${actual.User ?? "(missing)"}, expected non-root (${expected.user})`,
	});
	checks.push({
		name: "workdir",
		ok: actual.WorkingDir === expected.workingDir,
		detail: `WorkingDir=${actual.WorkingDir ?? "(missing)"}, expected ${expected.workingDir}`,
	});
	checks.push({
		name: "entrypoint",
		ok:
			JSON.stringify(actual.Entrypoint ?? []) ===
			JSON.stringify(expected.entrypoint),
		detail: `Entrypoint=${JSON.stringify(actual.Entrypoint)} expected ${JSON.stringify(expected.entrypoint)}`,
	});
	checks.push({
		name: "cmd",
		ok: JSON.stringify(actual.Cmd ?? []) === JSON.stringify(expected.cmd),
		detail: `Cmd=${JSON.stringify(actual.Cmd)} expected ${JSON.stringify(expected.cmd)}`,
	});
	for (const port of expected.exposedPorts) {
		const key = `${port}/tcp`;
		checks.push({
			name: `expose:${port}`,
			ok: Boolean(actual.ExposedPorts?.[key]),
			detail: `missing ExposedPorts ${key}`,
		});
	}
	for (const vol of expected.volumes) {
		checks.push({
			name: `volume:${vol}`,
			ok: Boolean(actual.Volumes?.[vol]),
			detail: `missing Volumes[${vol}]`,
		});
	}
	for (const label of expected.labels) {
		const [key, ...rest] = label.split("=");
		const value = rest.join("=");
		checks.push({
			name: `label:${key}`,
			ok: actual.Labels?.[key!] === value,
			detail: `Labels[${key}]=${actual.Labels?.[key!] ?? "(missing)"} expected ${value}`,
		});
	}
	if (expected.exposedPorts.length > 0 && actual.Healthcheck?.Test?.length) {
		checks.push({
			name: "healthcheck:present",
			ok: true,
		});
	}
	void uid;
	return checks;
}
