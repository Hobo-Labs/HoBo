import { execFile } from "node:child_process";
import {
	createHash,
	createPublicKey,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	EventStore,
	JsonObject,
	JsonValue,
	PrincipalRef,
} from "@hobo/core";
import { build } from "esbuild";
import type {
	GeneratedProviderReceipt as GeneratedProviderReceiptRecord,
	LocalRunnerJob as LocalRunnerJobRecord,
} from "./_generated/sdk_pb.js";
import type { RunnerDeclaration } from "./dispatcher.js";
import type { GenerateProviderRequest } from "./generate-provider.js";

/** The operator owns the event store and identity; execution never creates hosted control-plane dependencies. */
export interface ProviderRunnerExecutionContext {
	readonly executionId: string;
	readonly store: EventStore;
	readonly actor: PrincipalRef;
	readonly tenant: string;
}

async function fact(
	context: ProviderRunnerExecutionContext,
	kind: "runner" | "provider-generation",
	step: string,
	status: string,
	detail: Record<string, string | number | boolean>,
) {
	const stream = `sdk-execution:${JSON.stringify([context.tenant, context.executionId])}`;
	let sequence = 0;
	for await (const event of context.store.read(stream)) {
		if (event.tenant !== context.tenant)
			throw new Error("execution stream belongs to another tenant");
		// SAFETY: execution stream values cross the durable JSON boundary before field access.
		const previous = record(event.data as JsonValue, "execution fact");
		if (
			status === "started" &&
			previous.kind === kind &&
			previous.step === step &&
			previous.status === "started"
		)
			throw new Error(
				"execution step already started; refusing a duplicate or ambiguous effect",
			);
		sequence = event.seq;
	}
	await context.store.append(
		stream,
		[
			{
				type: "sdk.ExecutionFact",
				data: { executionId: context.executionId, kind, step, status, detail },
			},
		],
		{ expectedSeq: sequence, actor: context.actor, tenant: context.tenant },
	);
}

export type LocalRunnerJob = Readonly<
	Pick<LocalRunnerJobRecord, "jobId" | "cwd">
> &
	Readonly<
		Partial<Pick<LocalRunnerJobRecord, "timeoutMs" | "maxOutputBytes">>
	> & {
		/** An argv vector; shell interpretation is never enabled. */
		readonly argv: readonly [string, ...string[]];
		readonly env?: Readonly<LocalRunnerJobRecord["env"]>;
	};

/** Execute a local process and await its real exit; failed and timed-out jobs cannot become successful receipts. */
export async function executeLocalRunner(
	runner: RunnerDeclaration,
	job: LocalRunnerJob,
	context: ProviderRunnerExecutionContext,
) {
	if (runner.kind !== "self-hosted")
		throw new TypeError("executeLocalRunner requires a self-hosted runner");
	if (runner.behind === "relay")
		throw new TypeError(
			"relay-selected runners require their configured relay transport; use a direct self-hosted runner for local execution",
		);
	if (!job.jobId || !job.argv[0])
		throw new TypeError("runner job requires jobId and executable argv");
	const timeout = job.timeoutMs ?? 30_000;
	const maxBuffer = job.maxOutputBytes ?? 1024 * 1024;
	if (
		!Number.isSafeInteger(timeout) ||
		timeout <= 0 ||
		!Number.isSafeInteger(maxBuffer) ||
		maxBuffer <= 0
	)
		throw new TypeError("runner bounds must be positive integers");
	await fact(context, "runner", job.jobId, "started", {
		providerId: runner.providerId,
	});
	const result = await new Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
		timedOut: boolean;
	}>((resolve) => {
		execFile(
			job.argv[0],
			job.argv.slice(1),
			{
				cwd: job.cwd,
				env: { ...job.env },
				shell: false,
				encoding: "utf8",
				timeout,
				maxBuffer,
			},
			(error, stdout, stderr) => {
				resolve({
					exitCode: error
						? Number.isSafeInteger(error.code) && error.code !== 0
							? Number(error.code)
							: 1
						: 0,
					stdout: String(stdout),
					stderr: String(stderr),
					timedOut: Boolean(
						error?.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					),
				});
			},
		);
	});
	const status = result.exitCode === 0 ? "succeeded" : "failed";
	await fact(context, "runner", job.jobId, status, {
		providerId: runner.providerId,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
	});
	return { jobId: job.jobId, providerId: runner.providerId, status, ...result };
}

/** Execute an existing provider port selected by the composition root, including cloud and self-hosted relay providers. */
export async function executeRemoteRunner<
	Job extends { readonly jobId: string },
	Result extends {
		readonly jobId: string;
		readonly providerId: string;
		readonly status: string;
	},
>(
	declaration: RunnerDeclaration,
	job: Job,
	backend: { readonly id: string; run(job: Job): Promise<Result> },
	context: ProviderRunnerExecutionContext,
): Promise<Result> {
	if (backend.id !== declaration.providerId)
		throw new TypeError("runner backend does not match the authored provider");
	await fact(context, "runner", job.jobId, "started", {
		providerId: backend.id,
	});
	try {
		const result = await backend.run(job);
		if (
			result.jobId !== job.jobId ||
			result.providerId !== backend.id ||
			!["succeeded", "failed"].includes(result.status)
		)
			throw new Error(
				"runner backend returned an uncorrelated or non-terminal result",
			);
		await fact(context, "runner", job.jobId, result.status, {
			providerId: backend.id,
		});
		return result;
	} catch (error) {
		await fact(context, "runner", job.jobId, "failed", {
			providerId: backend.id,
		});
		throw error;
	}
}

export interface ProviderSynthesisModel {
	/** OpenAI-compatible chat completion endpoint, including a self-hosted model. */
	readonly endpoint: string;
	readonly model: string;
	readonly authorization?: string;
}

async function synthesizeOpenApi(
	text: string,
	docsUrl: string,
	model: ProviderSynthesisModel,
	fetchImpl: typeof fetch,
): Promise<JsonValue> {
	const endpoint = new URL(model.endpoint);
	if (
		!["http:", "https:"].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password
	)
		throw new TypeError(
			"model endpoint must be HTTP(S) without URL credentials",
		);
	const headers = new Headers({ "content-type": "application/json" });
	if (model.authorization) headers.set("authorization", model.authorization);
	const result = await fetchImpl(endpoint, {
		method: "POST",
		headers,
		redirect: "error",
		signal: AbortSignal.timeout(60_000),
		body: JSON.stringify({
			model: model.model,
			temperature: 0,
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content:
						"Return only a complete executable OpenAPI 3 JSON document with servers and operationId values. Derive paths, HTTP methods and server URLs from the documentation; never invent unsupported operations.",
				},
				{ role: "user", content: `Source URL: ${docsUrl}\n${text}` },
			],
		}),
	});
	if (!result.ok) throw new Error(`provider synthesis HTTP ${result.status}`);
	const body = record(await result.json(), "model completion");
	const choices = body.choices;
	const first = Array.isArray(choices)
		? record(choices[0], "model choice")
		: undefined;
	const message = first ? record(first.message, "model message") : undefined;
	const content = message?.content;
	if (Object.prototype.toString.call(content) !== "[object String]")
		throw new TypeError("model completion omitted the OpenAPI document");
	return JSON.parse(String(content));
}

export type GeneratedProviderReceipt = Readonly<
	Omit<GeneratedProviderReceiptRecord, "$typeName" | "$unknown">
>;

/** Verify both content integrity and the operator's trusted signer before executing a generated module. */
export async function loadGeneratedProvider(
	receipt: GeneratedProviderReceipt,
	trustedPublicKey: KeyObject | string,
) {
	const source = await readFile(receipt.sourcePath);
	const digest = createHash("sha256").update(source).digest("hex");
	if (
		digest !== receipt.digest ||
		!verify(
			null,
			Buffer.from(digest),
			trustedPublicKey,
			Buffer.from(receipt.signature, "base64"),
		)
	)
		throw new Error(
			"generated provider integrity or trusted signature verification failed",
		);
	// The imported bytes are exactly those just verified. Never reopen the path
	// during module loading: it could have changed after the signature check.
	const loaded = await import(javascriptModuleUrl(source));
	if (!loaded.default || !(loaded.default.invoke instanceof Function))
		throw new TypeError(
			"signed provider module omitted its execution entrypoint",
		);
	// SAFETY: trusted signature authorizes module execution; the callable export was checked above.
	return loaded.default as ReturnType<typeof createGeneratedHttpProvider>;
}

function javascriptModuleUrl(source: Uint8Array): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

export interface HttpProviderOperation {
	readonly id: string;
	readonly method: string;
	readonly path: string;
}
export interface HttpProviderCall {
	readonly path?: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
	readonly body?: JsonValue;
	readonly headers?: Readonly<Record<string, string>>;
}
export interface ProviderConformanceCase {
	readonly operationId: string;
	readonly input?: HttpProviderCall;
	readonly expectedStatus: number;
}

function record(value: JsonValue | undefined, name: string): JsonObject {
	if (Object.prototype.toString.call(value) !== "[object Object]")
		throw new TypeError(`${name} must be an object`);
	// SAFETY: JSON parsing plus the object tag establish the OpenAPI object boundary.
	return value as JsonObject;
}
function openApiOperations(document: JsonValue, docsUrl: string) {
	const parsed = record(document, "OpenAPI document");
	if (
		Object.prototype.toString.call(parsed.openapi) !== "[object String]" ||
		!String(parsed.openapi).startsWith("3.")
	)
		throw new TypeError("provider generation requires OpenAPI 3 documentation");
	const servers = parsed.servers;
	const first = Array.isArray(servers)
		? record(servers[0], "OpenAPI server")
		: undefined;
	if (Object.prototype.toString.call(first?.url) !== "[object String]")
		throw new TypeError("OpenAPI document must declare a server URL");
	const baseUrl = new URL(String(first?.url), docsUrl);
	if (
		!["http:", "https:"].includes(baseUrl.protocol) ||
		baseUrl.username ||
		baseUrl.password
	)
		throw new TypeError(
			"provider server must be an HTTP(S) URL without embedded credentials",
		);
	const operations: HttpProviderOperation[] = [];
	for (const [path, item] of Object.entries(
		record(parsed.paths, "OpenAPI paths"),
	)) {
		if (
			!path.startsWith("/") ||
			path.startsWith("//") ||
			path.includes("#") ||
			path.includes("?")
		)
			throw new TypeError("OpenAPI operation paths must be rooted paths");
		for (const [method, value] of Object.entries(
			record(item, "OpenAPI path item"),
		)) {
			if (
				!["get", "post", "put", "patch", "delete", "head", "options"].includes(
					method,
				)
			)
				continue;
			const operation = record(value, "OpenAPI operation");
			const id =
				Object.prototype.toString.call(operation.operationId) ===
					"[object String]" && operation.operationId
					? String(operation.operationId)
					: `${method} ${path}`;
			if (operations.some((entry) => entry.id === id))
				throw new TypeError(`duplicate OpenAPI operationId ${id}`);
			operations.push({ id, method: method.toUpperCase(), path });
		}
	}
	if (!operations.length)
		throw new TypeError("OpenAPI document declares no executable operations");
	return { baseUrl: baseUrl.toString(), operations };
}

/** Actual HTTP adapter shared by generated source semantics and conformance execution. */
export function createGeneratedHttpProvider(
	baseUrl: string,
	operations: readonly HttpProviderOperation[],
	fetchImpl: typeof fetch = fetch,
) {
	const base = new URL(baseUrl);
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		throw new TypeError(
			"provider base URL must be an HTTP(S) URL without credentials, query or fragment",
		);
	return {
		async invoke(operationId: string, input: HttpProviderCall = {}) {
			const operation = operations.find(
				(candidate) => candidate.id === operationId,
			);
			if (!operation)
				throw new TypeError(`unknown provider operation ${operationId}`);
			const path = operation.path.replace(
				/\{([^}]+)\}/gu,
				(_match, key: string) => {
					const value = input.path?.[key];
					if (value === undefined)
						throw new TypeError(`missing path parameter ${key}`);
					if (/%2e|%2f|%5c/iu.test(value))
						throw new TypeError(
							"provider path parameter must not encode traversal or path separators",
						);
					return encodeURIComponent(value);
				},
			);
			for (const candidatePath of [base.pathname, operation.path, path]) {
				if (
					!candidatePath.startsWith("/") ||
					candidatePath.startsWith("//") ||
					/[\\?#]/u.test(candidatePath) ||
					/(?:^|\/)\.{1,2}(?:\/|$)/u.test(candidatePath) ||
					/%2e|%2f|%5c/iu.test(candidatePath)
				)
					throw new TypeError(
						"provider path must not contain traversal or encoded path separators",
					);
			}
			const url = new URL(`${base.href.replace(/\/$/u, "")}${path}`);
			for (const [key, value] of Object.entries(input.query ?? {}))
				url.searchParams.set(key, value);
			const headers = new Headers(input.headers);
			if (input.body !== undefined)
				headers.set("content-type", "application/json");
			const response = await fetchImpl(url, {
				method: operation.method,
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
				body: input.body === undefined ? null : JSON.stringify(input.body),
			});
			return { status: response.status, body: await response.text() };
		},
	};
}

/** Discover, compile an executable provider artifact, exercise every operation, then sign its source digest. */
export async function executeProviderGeneration(
	request: GenerateProviderRequest,
	options: {
		readonly context: ProviderRunnerExecutionContext;
		readonly providerId: string;
		readonly outputDir: string;
		readonly signingKey: KeyObject;
		readonly conformance: readonly ProviderConformanceCase[];
		readonly fetchImpl?: typeof fetch;
		readonly synthesisModel?: ProviderSynthesisModel;
		readonly allowedOrigins?: readonly string[];
	},
) {
	const context = options.context;
	const fetchImpl = options.fetchImpl ?? fetch;
	await fact(context, "provider-generation", "discovery", "started", {
		providerId: options.providerId,
	});
	try {
		const response = await fetchImpl(request.docsUrl, {
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
			headers: { accept: "application/json" },
		});
		if (!response.ok)
			throw new Error(`provider documentation HTTP ${response.status}`);
		const text = await response.text();
		if (Buffer.byteLength(text) > 1024 * 1024)
			throw new Error("provider documentation exceeds 1 MiB");
		let document: JsonValue;
		let synthesized = false;
		try {
			document = JSON.parse(text);
		} catch {
			if (!options.synthesisModel)
				throw new Error(
					"prose provider documentation requires a configured synthesis model; a self-hosted endpoint is supported",
				);
			synthesized = true;
			document = await synthesizeOpenApi(
				text,
				request.docsUrl,
				options.synthesisModel,
				fetchImpl,
			);
		}
		let compilation: ReturnType<typeof openApiOperations>;
		try {
			compilation = openApiOperations(document, request.docsUrl);
		} catch (error) {
			if (!options.synthesisModel || synthesized) throw error;
			compilation = openApiOperations(
				await synthesizeOpenApi(
					text,
					request.docsUrl,
					options.synthesisModel,
					fetchImpl,
				),
				request.docsUrl,
			);
		}
		const { baseUrl, operations } = compilation;
		const allowedOrigins = options.allowedOrigins ?? [
			new URL(request.docsUrl).origin,
		];
		if (!allowedOrigins.includes(new URL(baseUrl).origin))
			throw new Error(
				"generated provider target origin requires explicit operator approval",
			);
		for (const operation of operations) {
			if (
				!options.conformance.some(
					(test) =>
						test.operationId === operation.id &&
						test.expectedStatus >= 200 &&
						test.expectedStatus < 300,
				)
			)
				throw new Error(`conformance case required for ${operation.id}`);
		}
		// Source embeds the same executable implementation, not declarations or fake success responses.
		const source = `// Generated executable HTTP provider.\ntype JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };\ninterface Operation { readonly id: string; readonly method: string; readonly path: string; }\ninterface Call { readonly path?: Readonly<Record<string,string>>; readonly query?: Readonly<Record<string,string>>; readonly body?: JsonValue; readonly headers?: Readonly<Record<string,string>>; }\ntype Factory = (baseUrl: string, operations: readonly Operation[], fetchImpl?: typeof fetch) => { invoke(operationId: string, input?: Call): Promise<{status:number;body:string}> };\nexport const operations = ${JSON.stringify(operations, null, 2)} as const;\nexport const baseUrl = ${JSON.stringify(baseUrl)};\nexport const createGeneratedHttpProvider: Factory = ${createGeneratedHttpProvider.toString()};\nexport default createGeneratedHttpProvider(baseUrl, operations);\n`;
		await mkdir(options.outputDir, { recursive: true });
		const auditSourcePath = join(options.outputDir, "provider.ts");
		await writeFile(auditSourcePath, source);
		const compilationResult = await build({
			stdin: { contents: source, loader: "ts", sourcefile: "provider.ts" },
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			write: false,
		});
		const javascript = compilationResult.outputFiles[0]?.text;
		if (javascript === undefined)
			throw new Error("provider compilation produced no executable JavaScript");
		const sourcePath = join(options.outputDir, "provider.mjs");
		await writeFile(sourcePath, javascript);
		// Conformance exercises the actual compiled artifact, not the SDK's
		// in-memory generator implementation. Injection changes only transport.
		const compiled = await import(
			javascriptModuleUrl(Buffer.from(javascript, "utf8"))
		);
		if (!(compiled.createGeneratedHttpProvider instanceof Function))
			throw new TypeError("compiled provider omitted its factory");
		// SAFETY: the generated artifact's callable factory was checked at this module boundary.
		const factory =
			compiled.createGeneratedHttpProvider as typeof createGeneratedHttpProvider;
		const provider = factory(baseUrl, operations, fetchImpl);
		await fact(context, "provider-generation", "compile", "succeeded", {
			providerId: options.providerId,
			operationCount: operations.length,
		});
		for (const test of options.conformance) {
			const result = await provider.invoke(test.operationId, test.input);
			if (result.status !== test.expectedStatus)
				throw new Error(
					`conformance ${test.operationId}: expected HTTP ${test.expectedStatus}, received ${result.status}`,
				);
		}
		await fact(context, "provider-generation", "conformance", "succeeded", {
			providerId: options.providerId,
			cases: options.conformance.length,
		});
		const digest = createHash("sha256").update(javascript).digest("hex");
		const signature = sign(
			null,
			Buffer.from(digest),
			options.signingKey,
		).toString("base64");
		const publicKey = createPublicKey(options.signingKey)
			.export({ type: "spki", format: "pem" })
			.toString();
		if (
			!verify(
				null,
				Buffer.from(digest),
				publicKey,
				Buffer.from(signature, "base64"),
			)
		)
			throw new Error("generated provider signature did not verify");
		const receipt = {
			providerId: options.providerId,
			sourcePath,
			digest,
			signature,
			publicKey,
			operationCount: operations.length,
		};
		await writeFile(
			join(options.outputDir, "provider.receipt.json"),
			`${JSON.stringify(receipt, null, 2)}\n`,
		);
		await fact(context, "provider-generation", "sign", "succeeded", {
			providerId: options.providerId,
			digest,
		});
		return { provider, receipt };
	} catch (error) {
		await fact(context, "provider-generation", "pipeline", "failed", {
			providerId: options.providerId,
		});
		throw error;
	}
}
