import type {
	FetchHandler,
	HoboRuntimeHost,
	PrivateServeResult,
	RuntimeEnsureContext,
	RuntimeEnsureResult,
	ServePrivateContext,
} from "@hobo/core";

/**
 * Camp host adapter for `componentHost=local`: private components run
 * in-process via supplied fetch handlers (no OS sandbox).
 */
export function createLocalRuntimeHost(): HoboRuntimeHost {
	return {
		kind: "local",
		async ensure(ctx: RuntimeEnsureContext): Promise<RuntimeEnsureResult> {
			ctx.emitProgress?.("hobo: local runtime host ready (in-process)");
			return {
				kind: "local",
				ready: true,
				notes: [
					"local host ready (process-local mesh + in-process private components)",
				],
				details: { isolateBoundary: "in_process" },
			};
		},
		async servePrivate(ctx: ServePrivateContext): Promise<PrivateServeResult> {
			const handlers = new Map<string, FetchHandler>();
			for (const component of ctx.privateComponents) {
				if (!component.handler) {
					throw new Error(
						`runtime-local: private '${component.resourceName}' requires an in-process handler`,
					);
				}
				handlers.set(component.resourceName, component.handler);
			}
			const previous: Record<string, string | undefined> = {};
			for (const [key, value] of Object.entries(ctx.bindleEnv ?? {})) {
				previous[key] = process.env[key];
				process.env[key] = value;
			}
			return {
				kind: "local",
				handlers,
				isolation: {
					isolateBoundary: "in_process",
					privateSandboxes: 0,
					details: { privateHandlers: handlers.size },
				},
				close: async () => {
					for (const [key, value] of Object.entries(previous)) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
				},
			};
		},
	};
}

export async function ensureLocalRuntime(
	ctx: RuntimeEnsureContext,
): Promise<RuntimeEnsureResult> {
	return createLocalRuntimeHost().ensure(ctx);
}
