import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	type Client,
	type ConnectOpts,
	type ContainerWithExecOpts,
	connect as connectSdk,
	ReturnType as DaggerReturnType,
	type Directory,
	type Host,
} from "@dagger.io/dagger";
import {
	type CloseReason,
	createArtifact,
	type ParsedPipeline,
	type PipelineBackend,
	type PipelineSession,
	type PipelineStep,
	PipelineStepResultSchema,
	parseRelativePath,
} from "@hobo/ci";

/** The SDK fluent command port, narrowed from the real Dagger client surface. */
export interface DaggerContainerPort {
	from(image: string): DaggerContainerPort;
	withDirectory(path: string, source: Directory): DaggerContainerPort;
	directory(path: string): Directory;
	withWorkdir(path: string): DaggerContainerPort;
	withEnvVariable(name: string, value: string): DaggerContainerPort;
	withExec(
		argv: string[],
		options?: Pick<ContainerWithExecOpts, "expect">,
	): DaggerContainerPort;
	exitCode(): Promise<number>;
	stdout(): Promise<string>;
	stderr(): Promise<string>;
}
export interface DaggerClientPort {
	container(): DaggerContainerPort;
	host(): Pick<Host, "directory">;
}
export interface DaggerConnection {
	readonly client: DaggerClientPort;
	/** Ends this owned engine connection. Must resolve only after lifecycle teardown. */
	close(): Promise<void>;
	/** Optional stronger provider stop acknowledgment for an in-flight command. */
	stop?(): Promise<void>;
}
export type DaggerConnector = (
	signal: AbortSignal,
) => Promise<DaggerConnection>;
export interface DaggerBackendOptions {
	readonly sourceDirectory: string;
	/** Pin the toolchain image; it must provide GNU timeout and base64. */
	readonly image: string;
	readonly connect?: DaggerConnector;
	readonly sdk?: ConnectOpts;
}

/** Compile-time witness that this port is actually implemented by the pinned SDK. */
export function daggerClientPort(client: Client): DaggerClientPort {
	return client;
}

function sdkConnector(options: ConnectOpts): DaggerConnector {
	return async (signal) => {
		signal.throwIfAborted();
		let release = () => {};
		const released = new Promise<void>((done) => {
			release = done;
		});
		let publish: (value: DaggerConnection) => void = () => {};
		let fail: (reason: Error) => void = () => {};
		const ready = new Promise<DaggerConnection>((resolveReady, rejectReady) => {
			publish = resolveReady;
			fail = rejectReady;
		});
		const lifecycle = connectSdk(async (client) => {
			publish({
				client: daggerClientPort(client),
				async close() {
					release();
					await lifecycle;
				},
			});
			await released;
		}, options);
		lifecycle.catch((error) => {
			fail(
				error instanceof Error ? error : new Error("Dagger connection failed"),
			);
		});
		return ready;
	};
}

function workspacePath(path: string): string {
	return path === "." ? "/workspace" : `/workspace/${parseRelativePath(path)}`;
}

/** Execute a portable pipeline using a bound Dagger SDK/engine connection. */
export function createDaggerBackend(
	options: DaggerBackendOptions,
): PipelineBackend {
	if (!/^\S+@sha256:[a-f0-9]{64}$/.test(options.image))
		throw new Error("Dagger toolchain image must be digest-pinned");
	const sourceDirectory = resolve(options.sourceDirectory);
	const connector =
		options.connect ??
		sdkConnector({ ...options.sdk, Workdir: sourceDirectory });
	return {
		kind: "dagger",
		capabilities: ["commands", "artifacts", "cancellation"],
		async open(
			pipeline: ParsedPipeline,
			signal: AbortSignal,
		): Promise<PipelineSession> {
			signal.throwIfAborted();
			const connection = await connector(signal);
			let closed = false;
			let closeTask: Promise<void> | undefined;
			let pending = 0;
			let unconfirmedWork = 0;
			const base = connection.client.container().from(options.image);
			let workspace = connection.client.host().directory(sourceDirectory);
			async function output(container: DaggerContainerPort, id: string) {
				pending++;
				// One lost GraphQL response must not hide siblings that still evaluate
				// the command graph. Track their aggregate lifetime independently from
				// Promise.all's first-error result so cleanup can stop promptly.
				const exitRead = Promise.resolve().then(() => container.exitCode());
				const stdoutRead = Promise.resolve().then(() => container.stdout());
				const stderrRead = Promise.resolve().then(() => container.stderr());
				void Promise.allSettled([exitRead, stdoutRead, stderrRead]).then(
					(results) => {
						const exitResult = results[0];
						// A rejected exit query does not prove that remote execution stopped.
						if (exitResult?.status !== "fulfilled") unconfirmedWork++;
						pending--;
					},
				);
				const [exitCode, stdout, stderr] = await Promise.all([
					exitRead,
					stdoutRead,
					stderrRead,
				]);
				return create(PipelineStepResultSchema, {
					id,
					exitCode,
					stdout,
					stderr,
				});
			}

			return {
				async run(step: PipelineStep, operationSignal: AbortSignal) {
					if (closed) throw new Error("Dagger session already closed");
					operationSignal.throwIfAborted();
					let container = base
						.withDirectory("/workspace", workspace)
						.withWorkdir(workspacePath(step.cwd));
					// Every command starts from the image environment, while workspace data chains.
					for (const [name, value] of Object.entries(step.env))
						container = container.withEnvVariable(name, value);
					// A new logical execution must not reuse a prior side-effecting command DAG.
					// Set this after user env so the caller cannot spoof another execution key.
					container = container.withEnvVariable(
						"HOBO_CI_EXECUTION_ID",
						pipeline.id,
					);
					container = container.withExec(
						[
							"timeout",
							"--signal=TERM",
							"--kill-after=5s",
							`${pipeline.timeoutSeconds}s`,
							...step.argv,
						],
						{ expect: DaggerReturnType.Any },
					);
					const result = await output(container, step.id);
					workspace = container.directory("/workspace");
					return result;
				},
				async artifact(path: string, operationSignal: AbortSignal) {
					if (closed) throw new Error("Dagger session already closed");
					operationSignal.throwIfAborted();
					parseRelativePath(path);
					const readArtifact =
						'resolved="$(realpath -e -- "$1")" || exit 66; case "$resolved" in /workspace/*) [ -f "$resolved" ] && [ "$(wc -c < "$resolved")" -le 1048576 ] && base64 --wrap=0 -- "$resolved";; *) exit 66;; esac';
					const result = await output(
						base
							.withDirectory("/workspace", workspace)
							.withWorkdir("/workspace")
							.withExec(["sh", "-c", readArtifact, "hobo-artifact", path], {
								expect: DaggerReturnType.Any,
							}),
						"artifact",
					);
					if (result.exitCode !== 0)
						throw new Error("Dagger artifact unavailable");
					const maxEncodedLength = 4 * Math.ceil((1024 * 1024) / 3);
					if (result.stdout.length > maxEncodedLength + 1024)
						throw new Error("Dagger artifact encoding exceeds size limit");
					const encoded = result.stdout.replaceAll(/\s/g, "");
					if (encoded.length > maxEncodedLength)
						throw new Error("Dagger artifact exceeds one MiB limit");
					if (
						!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
							encoded,
						)
					)
						throw new Error("invalid Dagger artifact encoding");
					return createArtifact(
						path,
						Uint8Array.from(Buffer.from(encoded, "base64")),
					);
				},
				close(reason: CloseReason) {
					if (closeTask) return closeTask;
					closed = true;
					closeTask = (async () => {
						const inFlight = pending > 0 || unconfirmedWork > 0;
						let stopped = !inFlight;
						try {
							if (inFlight && reason !== "completed" && connection.stop) {
								await connection.stop();
								stopped = true;
							}
						} finally {
							await connection.close();
						}
						if (!stopped)
							throw new Error(
								"Dagger command termination could not be confirmed",
							);
					})();
					return closeTask;
				},
			};
		},
	};
}
