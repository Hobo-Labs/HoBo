import type { BindleDefinition } from "@hobo/bindles";
import {
	applySessionReplayToEntrypoints,
	type BindleSessionReplayPlan,
	type DualFixtureStore,
} from "@hobo/replay";
import { isJsonBoolean, type JsonObject, type JsonValue } from "./json.js";

export type FetchHandler = (input: Request) => Response | Promise<Response>;

export interface ServableEntrypoint {
	readonly name: string;
	readonly kind: string;
	readonly handler: FetchHandler;
	readonly external: boolean;
}

export interface ServableEntrypointFactory {
	readonly name: string;
	readonly kind: string;
	readonly external: boolean;
	readonly createHandler: () => FetchHandler | null;
}

export type ListServableEntrypointsResult = {
	readonly entrypoints: ServableEntrypoint[];
	readonly sessionReplay: BindleSessionReplayPlan;
	readonly sessionReplayStore: DualFixtureStore;
};

type ServableEntrypointOptions = {
	readonly env?: NodeJS.ProcessEnv;
	readonly stationId?: string;
};

function isHttpAppKit(kind: string): boolean {
	return (
		kind === "api" || kind === "web" || kind === "service" || kind === "ui"
	);
}

export function isExternalComponent(
	kind: string,
	annotations: readonly {
		readonly option: string;
		readonly config: JsonObject;
	}[],
): boolean {
	for (const annotation of annotations) {
		if (annotation.option !== "endpoint") continue;
		if (isJsonBoolean(annotation.config.external)) {
			return annotation.config.external;
		}
	}
	return kind === "web";
}

function asFetchHandler(
	value: JsonValue | FetchHandler | undefined,
): FetchHandler | null {
	if (!(value instanceof Function)) {
		return null;
	}
	return value as FetchHandler;
}

export function listServableEntrypoints(
	definition: BindleDefinition,
	options: ServableEntrypointOptions = {},
): ServableEntrypoint[] {
	return listServableEntrypointsWithReplay(definition, options).entrypoints;
}

export function listServableEntrypointsWithReplay(
	definition: BindleDefinition,
	options: ServableEntrypointOptions = {},
): ListServableEntrypointsResult {
	const entries: ServableEntrypoint[] = [];
	for (const factory of listServableEntrypointFactories(definition)) {
		const handler = factory.createHandler();
		if (handler === null) continue;
		entries.push({
			name: factory.name,
			kind: factory.kind,
			handler,
			external: factory.external,
		});
	}
	const rank = (entry: ServableEntrypoint) => {
		if (entry.external) return 0;
		if (entry.kind === "api") return 1;
		return 2;
	};
	const sorted = entries.sort((a, b) => rank(a) - rank(b));
	const applied = applySessionReplayToEntrypoints(sorted, definition, {
		env: options.env ?? process.env,
		...(options.stationId !== undefined
			? { stationId: options.stationId }
			: undefined),
	});
	return {
		entrypoints: [...applied.entrypoints],
		sessionReplay: applied.plan,
		sessionReplayStore: applied.store,
	};
}

export function listServableEntrypointFactories(
	definition: BindleDefinition,
): ServableEntrypointFactory[] {
	const entries: ServableEntrypointFactory[] = [];
	for (const [name, record] of Object.entries(definition.resources)) {
		if (!isHttpAppKit(record.kind)) continue;
		const thunk = definition.entrypoint(name);
		if (!(thunk instanceof Function)) continue;
		entries.push({
			name,
			kind: record.kind,
			createHandler: () => {
				const inner = thunk();
				return inner instanceof Function ? asFetchHandler(inner) : null;
			},
			external: isExternalComponent(
				record.kind,
				record.annotations as readonly {
					readonly option: string;
					readonly config: JsonObject;
				}[],
			),
		});
	}
	return entries;
}
