/**
 * Registry of Camp component-host runtimes (local | wasm | oci | cloud-native).
 * Composition root only — packages/runtimes/* do not import each other.
 */
import type {
	FetchHandler,
	HoboRuntimeHost,
	HoboRuntimeHostKind,
	PrivateComponentSpec,
	PrivateServeResult,
	RuntimeEnsureResult,
} from "@hobo/core";
import { createCloudNativeRuntimeHost } from "@hobo/runtime-cloud-native";
import { createLocalRuntimeHost } from "@hobo/runtime-local";
import { createOciRuntimeHost } from "@hobo/runtime-oci";
import {
	createWasmRuntimeHost,
	ensureIsolatedWasmToolchain,
	preparePrivateWasmComponent,
} from "@hobo/runtime-wasm";

import type { ComponentHostKind } from "./bare-metal-yard.js";
import { normalizeComponentHostKind } from "./bare-metal-yard.js";

export function toRuntimeHostKind(
	kind: ComponentHostKind,
): HoboRuntimeHostKind {
	return kind;
}

export function getRuntimeHost(kind: ComponentHostKind): HoboRuntimeHost {
	const normalized = normalizeComponentHostKind(kind);
	switch (normalized) {
		case "local":
			return createLocalRuntimeHost();
		case "wasm":
			return createWasmRuntimeHost();
		case "oci":
			// Real kubectl client (HOBO_KUBECTL_BIN / PATH). No in-memory fake.
			return createOciRuntimeHost();
		case "cloud-native":
			return createCloudNativeRuntimeHost({ defaultProvider: "mock" });
		default: {
			const _exhaustive: never = normalized;
			throw new Error(`unknown component host: ${String(_exhaustive)}`);
		}
	}
}

export async function ensureAllRuntimeHosts(options: {
	readonly hoboHome: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly emitProgress?: (message: string) => void;
	readonly kinds?: readonly ComponentHostKind[];
}): Promise<readonly RuntimeEnsureResult[]> {
	const kinds =
		options.kinds ?? (["local", "wasm", "oci", "cloud-native"] as const);
	const results: RuntimeEnsureResult[] = [];
	for (const kind of kinds) {
		const host = getRuntimeHost(kind);
		results.push(
			await host.ensure({
				hoboHome: options.hoboHome,
				...(options.env !== undefined ? { env: options.env } : undefined),
				...(options.emitProgress !== undefined
					? { emitProgress: options.emitProgress }
					: undefined),
			}),
		);
	}
	return results;
}

/**
 * Build private component specs for a host.
 * - local / cloud-native: in-process handlers
 * - wasm: componentize via runtime-wasm
 * - oci: componentize via runtime-wasm then pass wasmPath (kubectl schedules it)
 */
export async function buildPrivateComponentSpecs(options: {
	readonly kind: ComponentHostKind;
	readonly projectDir: string;
	readonly hoboHome: string;
	readonly privateEntries: readonly {
		readonly name: string;
		readonly handler: FetchHandler;
		readonly modulePath?: string;
	}[];
	readonly emitProgress?: (message: string) => void;
}): Promise<PrivateComponentSpec[]> {
	const kind = normalizeComponentHostKind(options.kind);
	const emit = options.emitProgress ?? (() => {});

	if (kind === "local" || kind === "cloud-native") {
		return options.privateEntries.map((entry) => ({
			resourceName: entry.name,
			projectDir: options.projectDir,
			handler: entry.handler,
			...(entry.modulePath !== undefined
				? { modulePath: entry.modulePath }
				: undefined),
		}));
	}

	// wasm + oci: build .wasm via runtime-wasm (no adapter cross-deps).
	await ensureIsolatedWasmToolchain({
		hoboHome: options.hoboHome,
		emitProgress: emit,
	});
	const specs: PrivateComponentSpec[] = [];
	for (const entry of options.privateEntries) {
		const prepared = await preparePrivateWasmComponent({
			projectDir: options.projectDir,
			resourceName: entry.name,
			hoboHome: options.hoboHome,
			...(entry.modulePath !== undefined
				? { modulePath: entry.modulePath }
				: undefined),
			emitProgress: emit,
		});
		if (kind === "wasm") {
			specs.push({
				resourceName: entry.name,
				projectDir: options.projectDir,
				wasmPath: prepared.wasmPath,
				...(entry.modulePath !== undefined
					? { modulePath: entry.modulePath }
					: undefined),
			});
		} else {
			// oci: packed wasm artifact; mesh traffic goes through real port-forward.
			specs.push({
				resourceName: entry.name,
				projectDir: options.projectDir,
				wasmPath: prepared.wasmPath,
				...(entry.modulePath !== undefined
					? { modulePath: entry.modulePath }
					: undefined),
			});
		}
	}
	return specs;
}

export async function servePrivateOnHost(options: {
	readonly kind: ComponentHostKind;
	readonly projectDir: string;
	readonly hoboHome: string;
	readonly privateEntries: readonly {
		readonly name: string;
		readonly handler: FetchHandler;
		readonly modulePath?: string;
	}[];
	readonly bindleEnv?: Readonly<Record<string, string>>;
	readonly emitProgress?: (message: string) => void;
}): Promise<PrivateServeResult> {
	const kind = normalizeComponentHostKind(options.kind);
	const host = getRuntimeHost(kind);
	const privateComponents = await buildPrivateComponentSpecs({
		kind,
		projectDir: options.projectDir,
		hoboHome: options.hoboHome,
		privateEntries: options.privateEntries,
		...(options.emitProgress !== undefined
			? { emitProgress: options.emitProgress }
			: undefined),
	});
	return host.servePrivate({
		hoboHome: options.hoboHome,
		projectDir: options.projectDir,
		privateComponents,
		...(options.bindleEnv !== undefined
			? { bindleEnv: options.bindleEnv }
			: undefined),
		...(options.emitProgress !== undefined
			? { emitProgress: options.emitProgress }
			: undefined),
	});
}
