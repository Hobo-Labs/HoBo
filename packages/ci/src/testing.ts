import { create } from "@bufbuild/protobuf";
import type { PipelineStep } from "./_generated/ci_pb.js";
import { PipelineStepResultSchema } from "./_generated/ci_pb.js";
import {
	type BackendKind,
	type CloseReason,
	createArtifact,
	type ParsedPipeline,
	type PipelineBackend,
	type PipelineCapability,
	type PipelineExecutionScope,
	parseRelativePath,
} from "./execution.js";

type Awaitable<T> = T | Promise<T>;

export type PipelineBackendCall =
	| { readonly operation: "open"; readonly pipelineId: string }
	| { readonly operation: "run"; readonly stepId: string }
	| { readonly operation: "artifact"; readonly path: string }
	| { readonly operation: "close"; readonly reason: CloseReason }
	| { readonly operation: "observeFinalUsage"; readonly leaseId: string };

export type ScriptedStepResult = Readonly<{
	exitCode?: number;
	stdout?: string;
	stderr?: string;
}>;

export interface ScriptedPipelineBackendOptions {
	readonly kind: BackendKind;
	readonly capabilities?: readonly PipelineCapability[];
	readonly open?: (
		pipeline: ParsedPipeline,
		signal: AbortSignal,
		scope: PipelineExecutionScope | undefined,
	) => Awaitable<void>;
	readonly run?: (
		step: PipelineStep,
		signal: AbortSignal,
	) => Awaitable<ScriptedStepResult>;
	readonly artifact?: (
		path: string,
		signal: AbortSignal,
	) => Awaitable<Uint8Array>;
	readonly close?: (reason: CloseReason) => Awaitable<void>;
	readonly observeFinalUsage?: PipelineBackend["observeFinalUsage"];
}

export interface ScriptedPipelineBackend {
	readonly port: PipelineBackend;
	readonly fidelity: "mocked";
	readonly calls: readonly PipelineBackendCall[];
	clear(): void;
}

export function createScriptedPipelineBackend(
	options: ScriptedPipelineBackendOptions,
): ScriptedPipelineBackend {
	const calls: PipelineBackendCall[] = [];
	const port: PipelineBackend = {
		kind: options.kind,
		capabilities: [
			...(options.capabilities ?? ["commands", "artifacts", "cancellation"]),
		],
		async open(pipeline, signal, scope) {
			calls.push({ operation: "open", pipelineId: pipeline.id });
			signal.throwIfAborted();
			await options.open?.(structuredClone(pipeline), signal, scope);
			signal.throwIfAborted();
			const stopped = new AbortController();
			const pending = new Set<Promise<unknown>>();
			let closed = false;
			let closing: Promise<void> | undefined;
			function perform<T>(
				callerSignal: AbortSignal,
				operation: (signal: AbortSignal) => Awaitable<T>,
			): Promise<T> {
				if (closed) return Promise.reject(new Error("CI session is closed"));
				const operationSignal = AbortSignal.any([callerSignal, stopped.signal]);
				const work = Promise.resolve().then(async () => {
					operationSignal.throwIfAborted();
					const value = await operation(operationSignal);
					operationSignal.throwIfAborted();
					return value;
				});
				pending.add(work);
				void work.then(
					() => pending.delete(work),
					() => pending.delete(work),
				);
				return work;
			}
			return {
				run(step, stepSignal) {
					const snapshot = structuredClone(step);
					const stepId = snapshot.id;
					calls.push({ operation: "run", stepId });
					return perform(stepSignal, async (operationSignal) => {
						const result = await options.run?.(snapshot, operationSignal);
						return create(PipelineStepResultSchema, {
							...result,
							id: stepId,
						});
					});
				},
				artifact(path, artifactSignal) {
					calls.push({ operation: "artifact", path });
					return perform(artifactSignal, async (operationSignal) => {
						parseRelativePath(path);
						if (!options.artifact) throw new Error("No scripted artifact");
						const bytes = await options.artifact(path, operationSignal);
						return createArtifact(path, Uint8Array.from(bytes));
					});
				},
				close(reason) {
					if (!closing) {
						closed = true;
						calls.push({ operation: "close", reason });
						closing = Promise.resolve().then(async () => {
							stopped.abort();
							await Promise.allSettled(pending);
							await options.close?.(reason);
						});
					}
					return closing;
				},
			};
		},
	};
	const observe = options.observeFinalUsage;
	if (observe) {
		port.observeFinalUsage = async (scope) => {
			calls.push({ operation: "observeFinalUsage", leaseId: scope.leaseId });
			return observe(structuredClone(scope));
		};
	}
	return {
		port,
		fidelity: "mocked",
		get calls() {
			return structuredClone(calls);
		},
		clear() {
			calls.length = 0;
		},
	};
}
