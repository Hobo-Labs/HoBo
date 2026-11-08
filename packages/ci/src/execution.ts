import { create, fromJson } from "@bufbuild/protobuf";
import type { BudgetSettlementEvidence } from "@hobo/broker";
import {
	type Pipeline,
	type PipelineArtifact,
	PipelineArtifactSchema,
	type PipelineResult,
	PipelineResultSchema,
	PipelineSchema,
	type PipelineStep,
	type PipelineStepResult,
} from "./_generated/ci_pb.js";

export type BackendKind = "gh-actions" | "dagger" | "cf" | "ado";
export type PipelineCapability = "commands" | "artifacts" | "cancellation";
export type CloseReason = "completed" | "failed" | "cancelled" | "timed_out";
declare const parsedPipeline: unique symbol;
export type ParsedPipeline = Pipeline & { readonly [parsedPipeline]: true };

/** A bound source workspace. Closing must stop work before it resolves. */
export interface PipelineSession {
	run(step: PipelineStep, signal: AbortSignal): Promise<PipelineStepResult>;
	artifact(path: string, signal: AbortSignal): Promise<PipelineArtifact>;
	close(reason: CloseReason): Promise<void>;
}
export interface PipelineBackend {
	readonly kind: BackendKind;
	readonly capabilities: readonly PipelineCapability[];
	open(
		pipeline: ParsedPipeline,
		signal: AbortSignal,
		scope?: PipelineExecutionScope,
	): Promise<PipelineSession>;
	/** A provider billing/readback authority, independent of command completion and close acknowledgements. */
	observeFinalUsage?(
		scope: PipelineUsageScope,
	): Promise<PipelineUsageObservation | undefined>;
}
export interface PipelineUsageScope {
	readonly leaseId: string;
	readonly pipelineId: string;
	readonly pipelineDigest: string;
	readonly provider: string;
	readonly providerAccountId: string;
	readonly externalOperationId: string;
}
export interface PipelineExecutionScope extends PipelineUsageScope {
	/** Call again after asynchronous preflight and immediately before native allocation. */
	authorizeAllocation(): void;
	/** Persist the provider identity before acknowledging creation; lost acknowledgements retain the hold. */
	recordExternalOperationId(id: string): void;
}
export interface PipelineUsageObservation
	extends PipelineUsageScope,
		BudgetSettlementEvidence {
	readonly usageFinal: boolean;
	readonly stopped: boolean;
	readonly completedAt: string;
	readonly billedMinutes: number;
	readonly billedFreeMinutes: number;
	readonly paidMicros: number;
}
/** Only use for definitive refusal before any execution resource was created. */
export class BackendUnavailableError extends Error {
	constructor(message = "backend unavailable before execution") {
		super(message);
		this.name = "BackendUnavailableError";
	}
}

export function parsePipeline(json: string): ParsedPipeline {
	const pipeline = fromJson(
		PipelineSchema,
		JSON.parse(json, (key, value) => {
			if (key === "__proto__")
				throw new Error("prototype keys are not allowed in command plans");
			return value;
		}),
	);
	if (
		!/^[A-Za-z0-9_-]{1,100}$/.test(pipeline.id) ||
		!/^[A-Za-z0-9_-]{1,80}$/.test(pipeline.accountId)
	)
		throw new Error("invalid pipeline identity");
	if (
		pipeline.steps.length === 0 ||
		pipeline.steps.length > 128 ||
		pipeline.timeoutSeconds < 1 ||
		pipeline.timeoutSeconds > 19800
	)
		throw new Error("invalid pipeline bounds");
	const ids = new Set<string>();
	for (const step of pipeline.steps) {
		if (
			!/^[A-Za-z0-9_-]{1,100}$/.test(step.id) ||
			ids.has(step.id) ||
			step.argv.length === 0 ||
			step.argv.length > 256 ||
			step.argv[0] === "" ||
			step.argv.some((arg) => arg.includes("\0") || arg.length > 65536)
		)
			throw new Error("invalid command step");
		ids.add(step.id);
		step.cwd = step.cwd || ".";
		if (step.cwd !== ".") parseRelativePath(step.cwd);
		for (const [name, value] of Object.entries(step.env))
			if (
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
				value.includes("\0") ||
				value.length > 65536
			)
				throw new Error("invalid command environment");
	}
	if (
		pipeline.artifactPaths.length > 16 ||
		new Set(pipeline.artifactPaths).size !== pipeline.artifactPaths.length
	)
		throw new Error("invalid artifact list");
	pipeline.artifactPaths.forEach(parseRelativePath);
	if (
		pipeline.requiredCapabilities.some(
			(capability) =>
				!["commands", "artifacts", "cancellation"].includes(capability),
		)
	)
		throw new Error("unknown pipeline capability");
	for (const step of pipeline.steps) {
		Object.freeze(step.argv);
		Object.freeze(step.env);
		Object.freeze(step);
	}
	Object.freeze(pipeline.steps);
	Object.freeze(pipeline.artifactPaths);
	Object.freeze(pipeline.requiredCapabilities);
	// SAFETY: protobuf parsing, dependent bounds and immutable nested fields establish this derived domain type.
	return Object.freeze(pipeline) as ParsedPipeline;
}
export function parseRelativePath(path: string): string {
	if (
		!path ||
		path.length > 500 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("path must stay inside source workspace");
	return path;
}
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
export function requiredCapabilities(
	pipeline: ParsedPipeline,
): PipelineCapability[] {
	const capabilities = new Set<PipelineCapability>([
		"commands",
		"cancellation",
	]);
	if (pipeline.artifactPaths.length) capabilities.add("artifacts");
	for (const capability of pipeline.requiredCapabilities) {
		if (
			capability === "commands" ||
			capability === "artifacts" ||
			capability === "cancellation"
		)
			capabilities.add(capability);
	}
	return [...capabilities];
}
export function supportsPipeline(
	backend: PipelineBackend,
	pipeline: ParsedPipeline,
): boolean {
	return requiredCapabilities(pipeline).every((capability) =>
		backend.capabilities.includes(capability),
	);
}
export async function createArtifact(
	path: string,
	data: Uint8Array,
): Promise<PipelineArtifact> {
	parseRelativePath(path);
	if (data.byteLength > 1024 * 1024)
		throw new Error("artifact exceeds one MiB limit");
	const bytes = Uint8Array.from(data);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return create(PipelineArtifactSchema, {
		path,
		data: bytes,
		sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		),
	});
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		// The operation may have synchronously aborted and then rejected: always observe it.
		void promise.catch(() => undefined);
		return Promise.reject(signal.reason);
	}
	return new Promise((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", aborted));
	});
}
/** Execute the same parsed pipeline on any compatible bound backend. No cross-provider retry. */
export async function executePipeline(
	backend: PipelineBackend,
	pipeline: ParsedPipeline,
	options: { signal?: AbortSignal; cleanupTimeoutMs?: number } = {},
): Promise<PipelineResult> {
	if (!supportsPipeline(backend, pipeline))
		throw new BackendUnavailableError("backend lacks required capabilities");
	const result = create(PipelineResultSchema, {
		id: pipeline.id,
		backend: backend.kind,
		status: "succeeded",
	});
	const deadline = new AbortController();
	const timer = setTimeout(
		() =>
			deadline.abort(
				new DOMException("pipeline deadline exceeded", "TimeoutError"),
			),
		pipeline.timeoutSeconds * 1000,
	);
	const signal = options.signal
		? AbortSignal.any([options.signal, deadline.signal])
		: deadline.signal;
	let session: PipelineSession | undefined;
	let opening: Promise<PipelineSession> | undefined;
	let reason: CloseReason = "completed";
	try {
		if (signal.aborted) {
			result.status = "cancelled";
			return result;
		}
		opening = Promise.resolve().then(() => backend.open(pipeline, signal));
		session = await abortable(opening, signal);
		for (const step of pipeline.steps) {
			signal.throwIfAborted();
			const output = await abortable(session.run(step, signal), signal);
			if (
				output.id !== step.id ||
				!Number.isInteger(output.exitCode) ||
				output.exitCode < 0 ||
				output.exitCode > 255 ||
				new TextEncoder().encode(output.stdout).byteLength > 1024 * 1024 ||
				new TextEncoder().encode(output.stderr).byteLength > 1024 * 1024
			)
				throw new Error("invalid command result");
			result.steps.push(output);
			if (output.exitCode !== 0) {
				result.status = "failed";
				reason = "failed";
				break;
			}
		}
		if (result.status === "succeeded")
			for (const path of pipeline.artifactPaths) {
				signal.throwIfAborted();
				const artifact = await abortable(
					session.artifact(path, signal),
					signal,
				);
				const checked = await createArtifact(path, artifact.data);
				if (artifact.path !== path || artifact.sha256 !== checked.sha256)
					throw new Error("artifact integrity mismatch");
				result.artifacts.push(checked);
			}
	} catch (error) {
		if (error instanceof BackendUnavailableError && session === undefined)
			throw error;
		reason = signal.aborted
			? options.signal?.aborted
				? "cancelled"
				: "timed_out"
			: "failed";
		result.status = reason;
		result.error = signal.aborted
			? "pipeline stopped"
			: "pipeline execution failed";
		if (!session && opening) {
			// A late/ambiguous allocation is never safe to retry on a different provider.
			result.status = "uncertain";
			void opening
				.then(
					(late) => late.close(reason),
					() => undefined,
				)
				.catch(() => undefined);
		}
	} finally {
		clearTimeout(timer);
		if (session) {
			const cleanup = new AbortController();
			const cleanupTimer = setTimeout(
				() => cleanup.abort(new Error("cleanup unconfirmed")),
				options.cleanupTimeoutMs ?? 5000,
			);
			try {
				await abortable(session.close(reason), cleanup.signal);
			} catch {
				result.status = "uncertain";
				result.error = "backend shutdown not confirmed";
			} finally {
				clearTimeout(cleanupTimer);
			}
		}
	}
	return result;
}
// Worker-safe wire exports for backend adapters; this entry never imports the Node ledger.
export {
	type Pipeline,
	type PipelineArtifact,
	PipelineArtifactSchema,
	type PipelineResult,
	PipelineResultSchema,
	PipelineSchema,
	type PipelineStep,
	type PipelineStepResult,
	PipelineStepResultSchema,
	PipelineStepSchema,
} from "./_generated/ci_pb.js";
