export type DepsHeadroomPathEnv = Readonly<{
	hostJobDirectory?: string;
	githubWorkspace?: string;
	pnpmStoreExists?: boolean;
}>;

export function depsHeadroomCandidatePaths(
	env: DepsHeadroomPathEnv,
): readonly string[] {
	const paths: string[] = [];
	if (env.hostJobDirectory?.trim()) paths.push(env.hostJobDirectory.trim());
	if (env.githubWorkspace?.trim()) paths.push(env.githubWorkspace.trim());
	if (env.pnpmStoreExists) paths.push("/pnpm-store");
	paths.push("/");
	return paths;
}

export type DepsHeadroomPathPick = Readonly<{
	path: string;
	strategy:
		| "docker-root-mounted"
		| "device-matched"
		| "bind-mount-fallback"
		| "host-docker-root";
}>;

export function pickDepsHeadroomSamplePath(input: {
	dockerRootDir: string;
	dockerRootMounted: boolean;
	dockerRootDevice?: string;
	candidates: readonly string[];
	candidateDevice: (path: string) => string | undefined;
	canSample: (path: string) => boolean;
	canSampleHostDockerRoot?: (dockerRootDir: string) => boolean;
}): DepsHeadroomPathPick | undefined {
	const root = input.dockerRootDir.trim();
	if (root && input.dockerRootMounted && input.canSample(root)) {
		return { path: root, strategy: "docker-root-mounted" };
	}
	const device = input.dockerRootDevice?.trim();
	if (device) {
		for (const candidate of input.candidates) {
			if (input.candidateDevice(candidate) !== device) continue;
			if (input.canSample(candidate)) {
				return { path: candidate, strategy: "device-matched" };
			}
		}
	}
	for (const candidate of input.candidates) {
		if (input.canSample(candidate)) {
			return {
				path: candidate,
				strategy: device ? "bind-mount-fallback" : "bind-mount-fallback",
			};
		}
	}
	if (root && input.canSampleHostDockerRoot?.(root)) {
		return { path: `host:${root}`, strategy: "host-docker-root" };
	}
	return undefined;
}
