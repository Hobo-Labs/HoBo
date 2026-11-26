import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
	HoboRuntimeHost,
	PrivateServeResult,
	RuntimeEnsureContext,
	RuntimeEnsureResult,
	ServePrivateContext,
} from "@hobo/core";

import {
	bootWasmtimeSandbox,
	ensureIsolatedWasmToolchain,
	preparePrivateWasmComponent,
	type WasmtimeSandbox,
} from "./sandbox.js";

export interface WasmDependencySpec {
	readonly resourceName: string;
	/** Absolute or project-relative path to a wasi:http component .wasm */
	readonly source: string;
}

export interface WasmRuntimeHostOptions {
	/** Extra wasm component dependencies from bindle `b.wasmComponent(...)`. */
	readonly wasmDependencies?: readonly WasmDependencySpec[];
}

function resolveWasmSource(projectDir: string, source: string): string {
	if (isAbsolute(source) || source.startsWith("file:")) {
		return source.replace(/^file:\/\//, "");
	}
	return join(projectDir, source);
}

/**
 * Camp host adapter: private components in real Wasmtime OS-process sandboxes.
 * Also boots arbitrary wasm component dependencies declared on the bindle.
 */
export function createWasmRuntimeHost(
	options: WasmRuntimeHostOptions = {},
): HoboRuntimeHost {
	return {
		kind: "wasm",
		async ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult> {
			const toolchain = await ensureIsolatedWasmToolchain({
				hoboHome: ctx.hoboHome,
				...(ctx.env !== undefined ? { env: ctx.env } : undefined),
				...(ctx.emitProgress !== undefined
					? { emitProgress: ctx.emitProgress }
					: undefined),
			});
			return {
				kind: "wasm",
				ready: true,
				notes: [...toolchain.notes],
				details: {
					wasmtimeVersion: toolchain.wasmtime.version,
					jcoVersion: toolchain.jco.version,
				},
			};
		},
		async servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult> {
			const emit = ctx.emitProgress ?? (() => {});
			const toolchain = await ensureIsolatedWasmToolchain({
				hoboHome: ctx.hoboHome,
				...(ctx.env !== undefined ? { env: ctx.env } : undefined),
				emitProgress: emit,
			});
			const sandboxes: WasmtimeSandbox[] = [];
			const handlers = new Map<
				string,
				(input: Request) => Response | Promise<Response>
			>();
			try {
				// Arbitrary wasm component dependencies first.
				for (const dep of options.wasmDependencies ?? []) {
					const wasmPath = resolveWasmSource(ctx.projectDir, dep.source);
					if (!existsSync(wasmPath)) {
						throw new Error(
							`wasm dependency '${dep.resourceName}' source not found: ${wasmPath}`,
						);
					}
					const sandbox = await bootWasmtimeSandbox({
						resourceName: dep.resourceName,
						wasmPath,
						wasmtimeBin: toolchain.wasmtime.binPath,
						emitProgress: emit,
					});
					sandboxes.push(sandbox);
					handlers.set(dep.resourceName, sandbox.invoke);
					emit(
						`hobo: wasm dependency ${dep.resourceName} from ${wasmPath} (pid=${sandbox.pid})`,
					);
				}

				for (const component of ctx.privateComponents) {
					const wasmPath =
						component.wasmPath ??
						(
							await preparePrivateWasmComponent({
								projectDir: component.projectDir,
								resourceName: component.resourceName,
								jcoBin: toolchain.jco.binPath,
								hoboHome: ctx.hoboHome,
								...(component.modulePath !== undefined
									? { modulePath: component.modulePath }
									: undefined),
								emitProgress: emit,
							})
						).wasmPath;
					const sandbox = await bootWasmtimeSandbox({
						resourceName: component.resourceName,
						wasmPath,
						wasmtimeBin: toolchain.wasmtime.binPath,
						emitProgress: emit,
					});
					sandboxes.push(sandbox);
					handlers.set(component.resourceName, sandbox.invoke);
				}
			} catch (error) {
				await Promise.all(sandboxes.map((s) => s.terminate()));
				throw error;
			}
			return {
				kind: "wasm",
				handlers,
				isolation: {
					isolateBoundary: "wasmtime_process",
					privateSandboxes: sandboxes.length,
					details: {
						wasmtimeVersion: toolchain.wasmtime.version,
						wasmPaths: sandboxes.map((s) => s.wasmPath),
						dependencyCount: options.wasmDependencies?.length ?? 0,
					},
				},
				close: async () => {
					await Promise.all(sandboxes.map((s) => s.terminate()));
				},
			};
		},
	};
}

/** Alias for ensure API naming used by yard CLI. */
export async function ensureWasmRuntime(
	ctx: RuntimeEnsureContext,
): Promise<RuntimeEnsureResult> {
	return createWasmRuntimeHost().ensure(ctx);
}
