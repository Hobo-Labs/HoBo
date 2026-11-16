import { posix } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { JsonObject } from "../json.js";
import type { SourceModel } from "./engine.js";
import {
	type CodegenArtifact,
	CodegenArtifactSchema,
	type CodegenLayout,
} from "./types.js";

export interface RuntimeArtifactOptions {
	/** Extra self-contained parser source defining parseGeneratedResource(name, value). */
	readonly validationSource?: string;
	/** Serialized FieldSchema objects keyed by resource name. */
	readonly schemas?: JsonObject;
}

function sourcePath(declaration: string): string {
	return declaration.replace(/\.d\.ts$/u, ".ts");
}

function specifier(from: string, to: string): string {
	const relative = posix
		.relative(posix.dirname(from), to)
		.replace(/\.ts$/u, ".js");
	return relative.startsWith(".") ? relative : `./${relative}`;
}

/** Execute the same application model through the existing EventStore/workflow engines. */
export function renderRuntimeArtifacts(
	model: SourceModel,
	layout: CodegenLayout,
	options: RuntimeArtifactOptions = {},
): readonly CodegenArtifact[] {
	const apiPath = sourcePath(layout.files.apiTree);
	const hooksPath = sourcePath(layout.files.hooks);
	const stepsPath = sourcePath(layout.files.steps);
	const workflowsPath = sourcePath(layout.files.workflows);
	const runtimePath = posix.join(posix.dirname(apiPath), "resource-runtime.ts");
	const resourceTypes = model.resources
		.map(
			(resource) => `  ${JSON.stringify(resource.name)}: ${resource.typeName};`,
		)
		.join("\n");
	const imports = model.resources
		.map((resource) => resource.typeName)
		.join(", ");
	const resourceNames = model.resources.map((resource) => resource.name);
	const steps = [
		...new Set(model.bindles.flatMap((bindle) => bindle.steps)),
	].sort();
	const workflows = [
		...new Set(model.bindles.flatMap((bindle) => bindle.workflows)),
	].sort();
	const stepResources = Object.fromEntries(
		steps.map((step) => {
			const matches = model.resources.filter((resource) =>
				step.startsWith(`${resource.name}.`),
			);
			return [step, matches.length === 1 ? matches[0]?.name : null];
		}),
	);
	const stepSignatures = steps
		.map((step) => {
			const resource = model.resources.find(
				(resource) => resource.name === stepResources[step],
			);
			const type = resource?.typeName ?? "never";
			return `  ${JSON.stringify(step)}: { input: ${type}; output: ${type} };`;
		})
		.join("\n");
	const workflowSignatures = workflows
		.map((name) => {
			const owners = model.bindles.filter((bindle) =>
				bindle.workflows.includes(name),
			);
			return `  ${JSON.stringify(name)}: { resources: readonly (${literalUnion([...new Set(owners.flatMap((owner) => owner.resources))])})[]; provider: ${literalUnion([...new Set(owners.map((owner) => owner.provider))])} };`;
		})
		.join("\n");

	const recordImports = `import type { ${imports} } from ${JSON.stringify(layout.imports.bindingsSpecifier)};`;
	const fallbackValidation = renderFallbackValidation(model);
	const runtimeSource = `import type { DurableEventStore, EventStore, PrincipalRef } from "@hobo/core";
import { createWorkflowEngine, defineWorkflow } from ${JSON.stringify(layout.imports.runtimeModule)};
import { createEventStoreReader, type EventStoreWriter } from ${JSON.stringify(`${layout.imports.runtimeModule}/replay`)};
${recordImports}

export interface ResourceRecords {
${resourceTypes}
}
export type ResourceName = keyof ResourceRecords;
export type GeneratedJson = null | boolean | number | string | GeneratedJson[] | { [key: string]: GeneratedJson };
export type GeneratedStepName = ${literalUnion(steps)};
export type GeneratedWorkflowName = ${literalUnion(workflows)};
export type GeneratedHandler = (input: GeneratedJson) => unknown | Promise<unknown>;
export interface StepSignatures {
${stepSignatures}
}
export interface WorkflowSignatures {
${workflowSignatures}
}
export interface GeneratedRuntimeOptions {
  readonly store: EventStore & Pick<DurableEventStore, "loadSnapshot">;
  readonly tenant: string;
  readonly project?: string;
  readonly actor?: PrincipalRef;
  readonly namespace?: string;
}
export interface ResourceClient<T> {
  query(input?: { limit?: number }): Promise<readonly T[]>;
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<T>;
  remove(key: string): Promise<boolean>;
  subscribe(handler: (value: T) => void): () => void;
}

${options.validationSource ? `${options.validationSource}\nconst generatedResourceSchemas = JSON.parse(${JSON.stringify(JSON.stringify(options.schemas ?? {}))}) as Record<string, FieldSchema>;\nfunction parseGeneratedResource(name: string, value: unknown): unknown {\n  const schema = generatedResourceSchemas[name];\n  if (!schema) throw new TypeError("Unknown generated resource " + name);\n  return parseValue(schema, value, name, generatedResourceSchemas);\n}` : fallbackValidation}

function jsonValue(value: unknown): GeneratedJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => {
    if (!Object.hasOwn(value, index)) throw new TypeError("Sparse arrays cannot cross the generated JSON boundary");
    return jsonValue(value[index]);
  });
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  throw new TypeError("Generated API effects must return JSON-serializable values");
}
function canonicalJson(value: GeneratedJson): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key]!)).join(",") + "}";
  return JSON.stringify(value);
}
function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Generated event payload must be an object");
  return value as Record<string, unknown>;
}
function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new TypeError(label + " must be non-empty");
  return value;
}

export function createGeneratedRuntime(options: GeneratedRuntimeOptions) {
  nonEmpty(options.tenant, "tenant");
  const actor = options.actor ?? { kind: "service" as const, id: "generated-api" };
  const prefix = ["generated", options.tenant, options.project ?? "default", options.namespace ?? ${JSON.stringify(model.bindles.map((bindle) => bindle.name).join("+") || "app")}].map(encodeURIComponent).join("/");
  const queues = new Map<string, Promise<void>>();
  const stepHandlers = new Map<string, GeneratedHandler>();
  const workflowHandlers = new Map<string, GeneratedHandler>();
  const pipelines = new Map<string, readonly GeneratedStepName[]>();
  const declaredSteps = new Set<string>(${JSON.stringify(steps)});
  const stepResources: Readonly<Record<string, ResourceName | null>> = ${JSON.stringify(stepResources)};
  const declaredWorkflows = new Set<string>(${JSON.stringify(workflows)});
  const declaredResources = new Set<string>(${JSON.stringify(resourceNames)});
  const subscribers = new Set<() => void>();
  const appendOptions = (expectedSeq: number) => ({ expectedSeq, actor, tenant: options.tenant, ...(options.project === undefined ? {} : { project: options.project }) });

  async function projection(name: ResourceName) {
    const streamId = prefix + "/resource/" + encodeURIComponent(name);
    const values = new Map<string, GeneratedJson>();
    let seq = 0;
    const snapshot = await options.store.loadSnapshot?.(streamId);
    if (snapshot) {
      if (snapshot.streamId !== streamId || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0) throw new TypeError("Generated resource snapshot has invalid stream metadata");
      const state = objectValue(snapshot.state);
      const persisted = objectValue(state.values);
      for (const [key, value] of Object.entries(persisted)) {
        nonEmpty(key, "snapshot resource key");
        values.set(key, jsonValue(parseGeneratedResource(name, value)));
      }
      seq = snapshot.seq;
    }
    for await (const event of options.store.read(streamId, seq + 1)) {
      if (event.streamId !== streamId || event.seq !== seq + 1) throw new TypeError("Generated resource stream has an invalid sequence");
      const data = objectValue(event.data);
      if (typeof data.key !== "string") throw new TypeError("Generated resource event has no key");
      nonEmpty(data.key, "resource event key");
      if (event.type === "generated.ResourcePut") values.set(data.key, jsonValue(parseGeneratedResource(name, data.value)));
      else if (event.type === "generated.ResourceRemoved") values.delete(data.key);
      else throw new TypeError("Unknown generated resource event " + event.type);
      seq = event.seq;
    }
    return { streamId, seq, values };
  }

  function serialize<T>(stream: string, command: () => Promise<T>): Promise<T> {
    const previous = queues.get(stream) ?? Promise.resolve();
    const result = previous.then(command);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(stream, settled);
    void settled.then(() => { if (queues.get(stream) === settled) queues.delete(stream); });
    return result;
  }

  function resource<N extends ResourceName>(name: N): ResourceClient<ResourceRecords[N]> {
    if (!declaredResources.has(name)) throw new Error("Resource is not declared: " + name);
    const streamId = prefix + "/resource/" + encodeURIComponent(name);
    return {
      async query(input = {}) {
        if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0)) throw new TypeError("query.limit must be a nonnegative safe integer");
        const state = await projection(name);
        return [...state.values].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).slice(0, input.limit).map(([, value]) => parseGeneratedResource(name, value) as ResourceRecords[N]);
      },
      async get(key) {
        nonEmpty(key, "resource key");
        const state = await projection(name);
        const value = state.values.get(key);
        return value === undefined ? undefined : parseGeneratedResource(name, value) as ResourceRecords[N];
      },
      async put(key, value) {
        nonEmpty(key, "resource key");
        const parsed = jsonValue(parseGeneratedResource(name, value));
        return serialize(streamId, async () => {
          const state = await projection(name);
          const appended = await options.store.append(streamId, [{ type: "generated.ResourcePut", v: 1, data: { key, value: parsed } }], appendOptions(state.seq));
          state.values.set(key, parsed);
          const seq = appended.appended.at(-1)?.seq ?? state.seq;
          await options.store.snapshot(streamId, { values: Object.fromEntries(state.values) }, seq);
          return parseGeneratedResource(name, parsed) as ResourceRecords[N];
        });
      },
      async remove(key) {
        nonEmpty(key, "resource key");
        return serialize(streamId, async () => {
          const state = await projection(name);
          if (!state.values.has(key)) return false;
          const appended = await options.store.append(streamId, [{ type: "generated.ResourceRemoved", v: 1, data: { key } }], appendOptions(state.seq));
          state.values.delete(key);
          await options.store.snapshot(streamId, { values: Object.fromEntries(state.values) }, appended.appended.at(-1)?.seq ?? state.seq);
          return true;
        });
      },
      subscribe(handler) {
        const subscription = options.store.subscribe({ streamId }, event => {
          if (event.type !== "generated.ResourcePut") return;
          const data = objectValue(event.data);
          handler(parseGeneratedResource(name, data.value) as ResourceRecords[N]);
        });
        const unsubscribe = () => { subscription.unsubscribe(); subscribers.delete(unsubscribe); };
        subscribers.add(unsubscribe);
        return unsubscribe;
      },
    };
  }

  const replayReader = createEventStoreReader(options.store);
  const workflowStore: EventStoreWriter = {
    ...replayReader,
    async append(event, expectedSeq) {
      if (expectedSeq === undefined) throw new Error("Generated workflow writes require optimistic concurrency");
      await options.store.append(event.streamId, [{ type: event.type, v: event.v ?? 1, data: event.data, ...(event.meta === undefined ? {} : { meta: event.meta }) }], appendOptions(expectedSeq));
    },
  };
  const workflowEngine = createWorkflowEngine({ store: workflowStore });

  async function invokeStep(name: GeneratedStepName, input: GeneratedJson): Promise<GeneratedJson> {
    const handler = stepHandlers.get(name);
    if (!handler) throw new Error("No implementation registered for declared step: " + name);
    const resource = stepResources[name];
    if (!resource) throw new Error("Step has an ambiguous or unbound resource schema: " + name);
    const parsedInput = jsonValue(parseGeneratedResource(resource, input));
    const output = await handler(parsedInput);
    return jsonValue(parseGeneratedResource(resource, output));
  }

  return {
    store: options.store,
    resource,
    registerStep(name: GeneratedStepName, handler: GeneratedHandler) {
      if (!declaredSteps.has(name)) throw new Error("Step is not declared: " + name);
      if (stepHandlers.has(name)) throw new Error("Step already registered: " + name);
      stepHandlers.set(name, handler);
      return () => { if (stepHandlers.get(name) === handler) stepHandlers.delete(name); };
    },
    invokeStep,
    registerWorkflow(name: GeneratedWorkflowName, implementation: GeneratedHandler | readonly GeneratedStepName[]) {
      if (!declaredWorkflows.has(name)) throw new Error("Workflow is not declared: " + name);
      if (workflowHandlers.has(name) || pipelines.has(name)) throw new Error("Workflow already registered: " + name);
      if (Array.isArray(implementation)) {
        const pipeline = [...implementation] as GeneratedStepName[];
        for (const step of pipeline) if (!declaredSteps.has(step)) throw new Error("Workflow references undeclared step: " + step);
        pipelines.set(name, pipeline);
      } else workflowHandlers.set(name, implementation as GeneratedHandler);
      return () => { workflowHandlers.delete(name); pipelines.delete(name); };
    },
    async runWorkflow(name: GeneratedWorkflowName, input: GeneratedJson, runId: string = globalThis.crypto.randomUUID()) {
      if (!declaredWorkflows.has(name)) throw new Error("Workflow is not declared: " + name);
      const handler = workflowHandlers.get(name);
      const pipeline = pipelines.get(name);
      if (!handler && !pipeline) throw new Error("No implementation registered for declared workflow: " + name);
      const definition = defineWorkflow<GeneratedJson, GeneratedJson>({
        name,
        async run(context, args) {
          if (handler) return context.step(name, async () => jsonValue(await handler(args)));
          let value = args;
          for (const step of pipeline ?? []) value = await context.step(step, () => invokeStep(step, value));
          return value;
        },
      });
      const workflowRunId = prefix + "/" + encodeURIComponent(name) + "/" + encodeURIComponent(nonEmpty(runId, "runId"));
      const parsedInput = jsonValue(input);
      const journal = await workflowStore.readStream("run/" + workflowRunId);
      const started = journal.find(event => event.type === "run.Started");
      if (started && canonicalJson(jsonValue(objectValue(started.data).args)) !== canonicalJson(parsedInput)) throw new Error("Workflow runId is already bound to different input");
      const result = await workflowEngine.resume(definition, workflowRunId, parsedInput);
      if (result.status !== "completed") throw new Error(result.error?.message ?? "Workflow execution failed");
      return { runId, result: result.result, status: result.status };
    },
    close() { for (const unsubscribe of subscribers) unsubscribe(); },
  };
}
export type GeneratedRuntime = ReturnType<typeof createGeneratedRuntime>;
let configured: GeneratedRuntime | undefined;
export function configureGeneratedRuntime(runtime: GeneratedRuntime): () => void {
  const previous = configured;
  configured = runtime;
  return () => { if (configured === runtime) configured = previous; };
}
export function generatedRuntime(): GeneratedRuntime {
  if (!configured) throw new Error("Configure generated API with an EventStore-backed runtime before use");
  return configured;
}
`;
	const apiResources = model.resources
		.map(
			(resource) => `  [${JSON.stringify(resource.name)}]: {
    query: (input?: { limit?: number }) => generatedRuntime().resource(${JSON.stringify(resource.name)}).query(input),
    get: (key: string) => generatedRuntime().resource(${JSON.stringify(resource.name)}).get(key),
    put: (key: string, value: ${resource.typeName}) => generatedRuntime().resource(${JSON.stringify(resource.name)}).put(key, value),
    remove: (key: string) => generatedRuntime().resource(${JSON.stringify(resource.name)}).remove(key),
    subscribe: (handler: (value: ${resource.typeName}) => void) => generatedRuntime().resource(${JSON.stringify(resource.name)}).subscribe(handler),
  },`,
		)
		.join("\n");
	const apiSource = `${recordImports}
import { generatedRuntime } from ${JSON.stringify(specifier(apiPath, runtimePath))};
export { createGeneratedRuntime, configureGeneratedRuntime, type GeneratedRuntime, type GeneratedRuntimeOptions } from ${JSON.stringify(specifier(apiPath, runtimePath))};
export const api = { resources: {\n${apiResources}\n} };
export type HoboApiTree = typeof api;
`;
	const hooksSource = `${recordImports}
import { api } from ${JSON.stringify(specifier(hooksPath, apiPath))};
${model.resources
	.flatMap((resource) => [
		`export function use${resource.typeName}Query(input?: { limit?: number }): Promise<readonly ${resource.typeName}[]> { return api.resources[${JSON.stringify(resource.name)}].query(input); }`,
		`export function use${resource.typeName}Subscription(handler: (value: ${resource.typeName}) => void): () => void { return api.resources[${JSON.stringify(resource.name)}].subscribe(handler); }`,
	])
	.join("\n")}
`;
	const stepSource = `import { generatedRuntime, type GeneratedStepName, type StepSignatures } from ${JSON.stringify(specifier(stepsPath, runtimePath))};
export type { GeneratedStepName, GeneratedHandler, GeneratedJson, StepSignatures } from ${JSON.stringify(specifier(stepsPath, runtimePath))};
export function registerStep<N extends GeneratedStepName>(name: N, handler: (input: StepSignatures[N]["input"]) => StepSignatures[N]["output"] | Promise<StepSignatures[N]["output"]>) {
  return generatedRuntime().registerStep(name, input => handler(input as unknown as StepSignatures[N]["input"]));
}
export async function invokeStep<N extends GeneratedStepName>(name: N, input: StepSignatures[N]["input"]): Promise<StepSignatures[N]["output"]> {
  return await generatedRuntime().invokeStep(name, input as unknown as import(${JSON.stringify(specifier(stepsPath, runtimePath))}).GeneratedJson) as unknown as StepSignatures[N]["output"];
}
`;
	const workflowSource = `import { generatedRuntime, type GeneratedWorkflowName, type GeneratedStepName, type GeneratedHandler, type GeneratedJson } from ${JSON.stringify(specifier(workflowsPath, runtimePath))};
export type { GeneratedWorkflowName, WorkflowSignatures } from ${JSON.stringify(specifier(workflowsPath, runtimePath))};
export function registerWorkflow(name: GeneratedWorkflowName, implementation: GeneratedHandler | readonly GeneratedStepName[]) { return generatedRuntime().registerWorkflow(name, implementation); }
export function runWorkflow(name: GeneratedWorkflowName, input: GeneratedJson, runId?: string) { return generatedRuntime().runWorkflow(name, input, runId); }
`;
	const outputs: readonly (readonly [string, string])[] = [
		[runtimePath, runtimeSource],
		[apiPath, apiSource],
		[hooksPath, hooksSource],
		[stepsPath, stepSource],
		[workflowsPath, workflowSource],
	];
	return outputs.map(([path, content]) =>
		create(CodegenArtifactSchema, { path, content }),
	);
}

function literalUnion(values: readonly string[]): string {
	return values.map((value) => JSON.stringify(value)).join(" | ") || "never";
}

function renderFallbackValidation(model: SourceModel): string {
	const checks = Object.fromEntries(
		model.resources.map((resource) => [
			resource.name,
			resource.fields.map((field) => ({ name: field.name, type: field.type })),
		]),
	);
	return `const scalarFields = ${JSON.stringify(checks)} as Record<string, readonly {name: string; type: string}[]>;
function parseGeneratedResource(name: string, value: unknown): unknown {
  const record = objectValue(value);
  const fields = scalarFields[name];
  if (!fields) throw new TypeError("Unknown resource: " + name);
  for (const field of fields) {
    if (["string", "number", "boolean"].includes(field.type) && typeof record[field.name] !== field.type) throw new TypeError(name + "." + field.name + " must be " + field.type);
  }
  return record;
}`;
}
