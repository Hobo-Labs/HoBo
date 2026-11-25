import { create } from "@bufbuild/protobuf";
import { type RelayJobMessage, RelayJobMessageSchema } from "@hobo/ci";
import { z } from "zod";

export const SESSION = z.object({ sessionid: z.string().min(1) });

export const AGENT_MESSAGE = z.object({
	messageid: z.union([z.number(), z.string()]).optional(),
	messagetype: z.string(),
	body: z.string().default(""),
});

// public-contract: the broker message type of a job offer.
export const RUNNER_JOB_REQUEST = "RunnerJobRequest";

// public-contract: the broker message type that asks for a new token.
export const FORCE_TOKEN_REFRESH = "ForceTokenRefresh";

export const JOB_REQUEST_REF = z.object({
	id: z.string().default(""),
	runner_request_id: z.string().min(1),
	should_acknowledge: z.boolean().default(false),
	run_service_url: z.string().default(""),
	billing_owner_id: z.string().default(""),
});
export type JobRequestRef = z.infer<typeof JOB_REQUEST_REF>;

export const TOKEN_RESPONSE = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().int().positive().optional(),
});

export const SERVICE_ERROR = z.object({
	errorkind: z.string().optional(),
	error: z.string().optional(),
});

export type ContextValue =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{ kind: "list"; items: readonly ContextValue[] }>
	| Readonly<{ kind: "map"; entries: ReadonlyMap<string, ContextValue> }>;

const TEXT_OF_SCALAR = z.union([
	z.string().transform((text) => text),
	z.number().transform(String),
	z.boolean().transform(String),
]);

export const CONTEXT_VALUE: z.ZodType<ContextValue> = z.lazy(() =>
	z.union([
		TEXT_OF_SCALAR.transform((text): ContextValue => ({ kind: "text", text })),
		z
			.object({
				t: z.number().int(),
				s: z.string().optional(),
				a: z.array(CONTEXT_VALUE).optional(),
				d: z.array(z.object({ k: z.string(), v: CONTEXT_VALUE })).optional(),
				b: z.boolean().optional(),
				n: z.number().optional(),
			})
			.transform((value): ContextValue => {
				if (value.t === 1) return { kind: "list", items: value.a ?? [] };
				if (value.t === 2 || value.t === 5)
					return {
						kind: "map",
						entries: new Map((value.d ?? []).map((pair) => [pair.k, pair.v])),
					};
				if (value.t === 3)
					return { kind: "text", text: String(value.b ?? false) };
				if (value.t === 4) return { kind: "text", text: String(value.n ?? 0) };
				return { kind: "text", text: value.s ?? "" };
			}),
		z.null().transform((): ContextValue => ({ kind: "text", text: "" })),
	]),
);

export type TemplateValue =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{
			kind: "map";
			entries: readonly (readonly [TemplateValue, TemplateValue])[];
	  }>;

export const TEMPLATE_VALUE: z.ZodType<TemplateValue> = z.lazy(() =>
	z.union([
		TEXT_OF_SCALAR.transform((text): TemplateValue => ({ kind: "text", text })),
		z.null().transform((): TemplateValue => ({ kind: "text", text: "" })),
		z
			.object({
				type: z.number().int(),
				lit: z.string().optional(),
				expr: z.string().optional(),
				bool: z.boolean().optional(),
				num: z.number().optional(),
				map: z
					.array(z.object({ key: TEMPLATE_VALUE, value: TEMPLATE_VALUE }))
					.optional(),
			})
			.transform((token): TemplateValue => {
				if (token.type === 2)
					return {
						kind: "map",
						entries: (token.map ?? []).map(
							(pair) => [pair.key, pair.value] as const,
						),
					};
				if (token.type === 3)
					return { kind: "text", text: `\${{ ${token.expr ?? ""} }}` };
				if (token.type === 5)
					return { kind: "text", text: String(token.bool ?? false) };
				if (token.type === 6)
					return { kind: "text", text: String(token.num ?? 0) };
				return { kind: "text", text: token.lit ?? "" };
			}),
	]),
);

const STEP_REFERENCE = z.object({
	type: z.union([z.string(), z.number()]).transform(String),
	name: z.string().default(""),
	ref: z.string().default(""),
	path: z.string().default(""),
	image: z.string().default(""),
});

const STEP = z.object({
	reference: STEP_REFERENCE.optional(),
	inputs: TEMPLATE_VALUE.optional(),
	environment: TEMPLATE_VALUE.nullish(),
	background: z.boolean().default(false),
	condition: z.string().nullish(),
});

export const JOB_IDS = z.object({
	plan: z.object({ planid: z.string().min(1) }),
	jobid: z.string().min(1),
	billingownerid: z.string().optional(),
});

export const JOB_MESSAGE = z.object({
	plan: z.object({ planid: z.string().min(1) }),
	jobid: z.string().min(1),
	jobname: z.string().default(""),
	contextdata: z.record(z.string(), CONTEXT_VALUE).default({}),
	steps: z.array(STEP).default([]),
	environmentvariables: z.array(TEMPLATE_VALUE).nullish(),
	defaults: z.array(TEMPLATE_VALUE).nullish(),
	jobcontainer: z.unknown().optional(),
	jobservicecontainers: z.unknown().optional(),
	billingownerid: z.string().optional(),
});
export type JobMessage = z.infer<typeof JOB_MESSAGE>;

function entry(
	value: ContextValue | undefined,
	name: string,
): ContextValue | undefined {
	return value?.kind === "map" ? value.entries.get(name) : undefined;
}

function at(
	root: ReadonlyMap<string, ContextValue>,
	path: readonly string[],
): ContextValue | undefined {
	const [first, ...rest] = path;
	let value = first === undefined ? undefined : root.get(first);
	for (const name of rest) value = entry(value, name);
	return value;
}

function text(value: ContextValue | undefined): string {
	return value?.kind === "text" ? value.text : "";
}

function templateText(value: TemplateValue): string {
	return value.kind === "text" ? value.text : "";
}

function uses(step: z.infer<typeof STEP>): string {
	const reference = step.reference;
	if (!reference) return "";
	const kind = reference.type.toLowerCase();
	if (kind === "repository" || kind === "1") {
		const path =
			reference.path === ""
				? reference.name
				: `${reference.name}/${reference.path}`;
		return reference.ref === "" ? path : `${path}@${reference.ref}`;
	}
	if (kind === "containerregistry" || kind === "2")
		return reference.image === "" ? "" : `docker://${reference.image}`;
	return "";
}

function stepInputs(
	step: z.infer<typeof STEP>,
): { name: string; value: string }[] {
	const inputs = step.inputs;
	if (inputs?.kind !== "map") return [];
	return inputs.entries.map(([key, value]) => ({
		name: templateText(key),
		value: templateText(value),
	}));
}

export function relayJobMessageOf(job: JobMessage): RelayJobMessage {
	const context = new Map(Object.entries(job.contextdata));
	const github = (path: readonly string[]) =>
		text(at(context, ["github", ...path]));
	const repository = github(["repository"]);
	const headRepo = at(context, [
		"github",
		"event",
		"pull_request",
		"head",
		"repo",
	]);
	const headName = text(entry(headRepo, "full_name"));
	return create(RelayJobMessageSchema, {
		jobId: job.jobid,
		planId: job.plan.planid,
		repository,
		runId: Number(github(["run_id"])) || 0,
		runAttempt: Number(github(["run_attempt"])) || 0,
		job: github(["job"]) || job.jobname,
		event: github(["event_name"]),
		actorId: github(["actor_id"]),
		triggeringActorId: github(["event", "sender", "id"]),
		private: github(["event", "repository", "private"]) === "true",
		fork:
			text(entry(headRepo, "fork")) === "true" ||
			(headName !== "" && headName.toLowerCase() !== repository.toLowerCase()),
		workflowRef: github(["workflow_ref"]),
		steps: job.steps.map((step) => ({
			uses: uses(step),
			inputs: stepInputs(step),
		})),
	});
}

const SUPPORTED_CHECK_STEPS: ReadonlySet<string> = new Set([
	"hobo-labs/hobo/checks/pr-title@v1",
	"hobo-labs/hobo/checks/lint@v1",
]);

function noEnvironment(environment: TemplateValue | null | undefined): boolean {
	if (environment == null) return true;
	return environment.kind === "map" && environment.entries.length === 0;
}

export function isRelayCheckJob(message: RelayJobMessage): boolean {
	return (
		message.steps.length > 0 &&
		message.steps.every((step) =>
			SUPPORTED_CHECK_STEPS.has(step.uses.toLowerCase()),
		)
	);
}

export function isRelayJob(message: RelayJobMessage, job: JobMessage): boolean {
	if (
		job.jobcontainer != null ||
		job.jobservicecontainers != null ||
		(job.defaults?.length ?? 0) > 0 ||
		(job.environmentvariables ?? []).some(
			(environment) => !noEnvironment(environment),
		) ||
		job.steps.some(
			(step) =>
				step.background ||
				(step.condition != null &&
					step.condition !== "" &&
					step.condition !== "success()"),
		)
	)
		return false;
	return (
		isRelayCheckJob(message) &&
		job.steps.every((step) => noEnvironment(step.environment))
	);
}

function annotationLevel(level: string): "failure" | "warning" | "notice" {
	if (level === "error") return "failure";
	if (level === "warning") return "warning";
	return "notice";
}

export type CompletedJob = Readonly<{
	jobId: string;
	conclusion: string;
	outputs: readonly Readonly<{ name: string; value: string }>[];
	annotations: readonly Readonly<{ level: string; message: string }>[];
}>;

export function completeJobBody(
	answer: CompletedJob,
	planId: string,
	billingOwnerId: string,
): string {
	const body = {
		planId,
		jobId: answer.jobId,
		conclusion: answer.conclusion === "succeeded" ? "succeeded" : "failed",
		outputs: Object.fromEntries(
			answer.outputs.map((output) => [
				output.name,
				{ value: output.value, isSecret: false },
			]),
		),
		stepResults: [],
		annotations: answer.annotations.map((note) => ({
			level: annotationLevel(note.level),
			message: note.message,
		})),
		billingOwnerId: billingOwnerId === "" ? undefined : billingOwnerId,
	};
	return JSON.stringify(body);
}
