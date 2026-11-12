// Snapshot of the OpenTelemetry semantic-conventions registry entries @hobo/cd
// emits, pinned at the release recorded in src/telemetry/STANDARDS.lock.json
// (v1.41.0: model/cicd, model/deployment, model/error). Golden tests validate
// every CD span and CI/CD metric against this snapshot; an upgrade regenerates
// it from the new tag (R8).

export const REGISTRY_VERSION = "1.41.0";

type AttributeSpec = Readonly<{
	type: "string" | "int" | "double" | "boolean";
	members?: readonly string[];
}>;

const RESULT = [
	"success",
	"failure",
	"error",
	"timeout",
	"cancellation",
	"skip",
];

export const REGISTRY_ATTRIBUTES: Readonly<Record<string, AttributeSpec>> = {
	"cicd.pipeline.name": { type: "string" },
	"cicd.pipeline.action.name": {
		type: "string",
		members: ["BUILD", "RUN", "SYNC"],
	},
	"cicd.pipeline.result": { type: "string", members: RESULT },
	"cicd.pipeline.run.id": { type: "string" },
	"cicd.pipeline.run.state": {
		type: "string",
		members: ["pending", "executing", "finalizing"],
	},
	"cicd.pipeline.run.url.full": { type: "string" },
	"cicd.pipeline.task.name": { type: "string" },
	"cicd.pipeline.task.run.id": { type: "string" },
	"cicd.pipeline.task.run.result": { type: "string", members: RESULT },
	"cicd.pipeline.task.run.url.full": { type: "string" },
	"cicd.pipeline.task.type": {
		type: "string",
		members: ["build", "test", "deploy"],
	},
	"cicd.system.component": { type: "string" },
	"cicd.worker.id": { type: "string" },
	"cicd.worker.name": { type: "string" },
	"cicd.worker.state": {
		type: "string",
		members: ["available", "busy", "offline"],
	},
	"cicd.worker.url.full": { type: "string" },
	"deployment.environment.name": { type: "string" },
	"deployment.id": { type: "string" },
	"deployment.name": { type: "string" },
	"deployment.status": { type: "string", members: ["failed", "succeeded"] },
	"error.type": { type: "string" },
};

/** Registry namespaces: any key under them must be a registry attribute. */
export const REGISTRY_NAMESPACES = ["cicd.", "deployment.", "error."];

export const SPAN_DEFINITIONS = {
	pipelineRun: {
		kind: "server",
		namePattern: /^(BUILD|RUN|SYNC) \S.*$/u,
		required: ["cicd.pipeline.name", "cicd.pipeline.run.id"],
		recommended: ["cicd.pipeline.action.name", "cicd.pipeline.result"],
	},
	taskRun: {
		kind: "internal",
		required: ["cicd.pipeline.task.name", "cicd.pipeline.task.run.id"],
		recommended: ["cicd.pipeline.task.type", "cicd.pipeline.task.run.result"],
	},
} as const;

export const METRIC_DEFINITIONS: Readonly<
	Record<
		string,
		Readonly<{
			instrument: "histogram" | "counter" | "gauge";
			unit: string;
			required: readonly string[];
		}>
	>
> = {
	"cicd.pipeline.run.duration": {
		instrument: "histogram",
		unit: "s",
		required: ["cicd.pipeline.name", "cicd.pipeline.run.state"],
	},
	"cicd.pipeline.run.errors": {
		instrument: "counter",
		unit: "{error}",
		required: ["cicd.pipeline.name", "error.type"],
	},
	"cicd.pipeline.run.active": {
		instrument: "gauge",
		unit: "{run}",
		required: ["cicd.pipeline.name", "cicd.pipeline.run.state"],
	},
	"cicd.system.errors": {
		instrument: "counter",
		unit: "{error}",
		required: ["cicd.system.component", "error.type"],
	},
	"cicd.worker.count": {
		instrument: "gauge",
		unit: "{count}",
		required: ["cicd.worker.state"],
	},
};

/** Problems with one attribute set against the snapshot (empty = valid). */
export function attributeProblems(
	attributes: Readonly<Record<string, string | number | boolean>>,
): string[] {
	const problems: string[] = [];
	for (const [key, value] of Object.entries(attributes)) {
		const spec = REGISTRY_ATTRIBUTES[key];
		if (!spec) {
			if (REGISTRY_NAMESPACES.some((ns) => key.startsWith(ns)))
				problems.push(
					`${key}: not in the semconv ${REGISTRY_VERSION} registry`,
				);
			else if (!key.startsWith("hobo.") && key !== "state")
				problems.push(`${key}: neither a registry nor a hobo.* attribute`);
			continue;
		}
		const actual =
			typeof value === "number"
				? Number.isInteger(value)
					? "int"
					: "double"
				: typeof value;
		if (actual !== spec.type)
			problems.push(`${key}: expected ${spec.type}, got ${actual}`);
		if (spec.members && !spec.members.includes(String(value)))
			problems.push(
				`${key}: ${String(value)} is not one of ${spec.members.join("|")}`,
			);
	}
	return problems;
}
