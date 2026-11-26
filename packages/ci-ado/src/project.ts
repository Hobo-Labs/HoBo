import { fromJson } from "@bufbuild/protobuf";
import { parseRelativePath } from "@hobo/ci/execution";
import { type AdoProject, AdoProjectSchema } from "./_generated/project_pb.js";

declare const parsedProject: unique symbol;
export type ParsedAdoProject = AdoProject & { readonly [parsedProject]: true };

export function parseAdoProject(json: string): ParsedAdoProject {
	// Reject this map key before protobuf's defensive JSON parser can silently discard it.
	const project = fromJson(
		AdoProjectSchema,
		JSON.parse(json, (key, value) => {
			if (key === "__proto__")
				throw new Error(
					"prototype keys are not allowed in project configuration",
				);
			return value;
		}),
	);
	if (
		project.schemaVersion !== "hobo.ci.ado/v1" ||
		!/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,99}$/.test(project.pool) ||
		project.pool.toLowerCase() === "azure pipelines" ||
		project.pool !== project.pool.trim() ||
		!/^[A-Za-z0-9_-]{1,64}$/.test(project.artifactPrefix) ||
		Object.keys(project.environmentRefs).length > 64 ||
		project.demands.length > 16 ||
		new Set(project.demands).size !== project.demands.length ||
		project.demands.some(
			(demand) =>
				/^Agent[.]OS($| )/i.test(demand) && demand !== "Agent.OS -equals Linux",
		) ||
		project.demands.some(
			(demand) =>
				!/^[A-Za-z][A-Za-z0-9_.-]*( -equals [A-Za-z0-9_.-]+)?$/.test(demand),
		)
	)
		throw new Error(
			"invalid Azure Pipelines self-hosted project configuration",
		);
	parseProjectPath(project.pipelinePath);
	for (const [target, source] of Object.entries(project.environmentRefs)) {
		parseEnvironmentName(target);
		parseEnvironmentName(source);
		if (target.startsWith("HOBO_CI_") || source.startsWith("HOBO_CI_"))
			throw new Error("HoBo CI metadata cannot be rebound");
	}
	if (!project.runnerArgv.length)
		project.runnerArgv = ["node", "packages/ci-ado/dist/cli.js"];
	if (!project.bootstrapArgv.length)
		project.bootstrapArgv = [
			"bash",
			"-euc",
			"corepack pnpm install --frozen-lockfile\ncorepack pnpm exec turbo run build --filter=@hobo/ci-ado --concurrency=100%",
		];
	project.verifyArtifacts ??= true;
	parseCommand(project.runnerArgv);
	parseCommand(project.bootstrapArgv);
	Object.freeze(project.environmentRefs);
	Object.freeze(project.runnerArgv);
	Object.freeze(project.bootstrapArgv);
	Object.freeze(project.demands);
	// SAFETY: strict protobuf parsing, dependent constraints and frozen nested fields refine the generated record.
	return Object.freeze(project) as ParsedAdoProject;
}

/** Paths interpolated by Azure must be literal workspace paths, never expressions. */
export function parseProjectPath(path: string): string {
	parseRelativePath(path);
	if (!/^[A-Za-z0-9_.-][A-Za-z0-9_./-]{0,499}$/.test(path))
		throw new Error("ADO paths must be literal workspace-relative paths");
	return path;
}

export function parseEnvironmentName(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
		throw new Error("invalid environment reference name");
	return name;
}
function parseCommand(argv: readonly string[]): void {
	if (
		argv.length > 256 ||
		argv.reduce((total, value) => total + value.length, 0) > 65536 ||
		argv.some(
			(value) =>
				!value ||
				value.length > 65536 ||
				value.includes("\0") ||
				/\$\(|\$\{\{|\$\[/.test(value),
		)
	)
		throw new Error(
			"runner/bootstrap argv must be bounded literals without Azure expressions",
		);
}
