import type {
	ComponentHostPort,
	HttpRequest,
	HttpResponse,
	LinkRequest,
	ParsedComponentDescriptor,
	ProviderDescriptor,
	Streamer,
} from "@hobo/core";


export const DEV_LOCAL_URL = "http://localhost:4000";

export const DEV_COLD_BUDGET_MS = 60_000;

export interface DevBindlePlan {
	readonly component: ParsedComponentDescriptor;
	readonly providers: readonly ProviderDescriptor[];
	readonly links: readonly LinkRequest[];
	readonly probe: HttpRequest;
}

export interface DevRuntime {
	readonly componentHost: ComponentHostPort;
	readonly streamer: Streamer;
	readonly plan: DevBindlePlan;
	readEvents(): readonly { readonly type: string }[];
}

export interface DevBootResult {
	readonly localUrl: string;
	readonly runtime: "runtime-local";
	readonly offline: true;
	readonly bootMs: number;
	readonly withinColdBudget: boolean;
	readonly coldBudgetMs: number;
	readonly served: HttpResponse;
	readonly linkedComponents: readonly string[];
	readonly events: readonly { readonly type: string }[];
	readonly streamedFrames: number;
}

export async function bootLocalCamp(
	runtime: DevRuntime,
	options: {
		readonly deploymentId: string;
		readonly emitProgress: (message: string) => void;
	},
): Promise<DevBootResult> {
	const startedAt = Date.now();
	const emit = options.emitProgress;
	emit("hobo dev: booting runtime-local Camp (offline)");

	const run = runtime.streamer.createRun();
	const host = runtime.componentHost;

	for (const provider of runtime.plan.providers) {
		host.registerProvider(provider);
	}
	host.loadComponent(runtime.plan.component);
	emit(`hobo dev: loaded component ${runtime.plan.component.id}`);

	for (const link of runtime.plan.links) {
		host.link(link);
	}
	emit(`hobo dev: linked ${runtime.plan.links.length} import(s)`);

	const served = await host.handleHttp(
		runtime.plan.component.id,
		runtime.plan.probe,
	);
	emit(
		`hobo dev: served ${runtime.plan.probe.method} ${runtime.plan.probe.path} -> ${served.status}`,
	);

	const events = runtime.readEvents();
	const writable = run.getWritable();
	let streamedFrames = 0;
	for (const event of events) {
		await writable.write(event);
		streamedFrames += 1;
	}
	runtime.streamer.teardownRun(run.runId, "dev boot complete");

	const bootMs = Date.now() - startedAt;
	return {
		localUrl: DEV_LOCAL_URL,
		runtime: "runtime-local",
		offline: true,
		bootMs,
		withinColdBudget: bootMs <= DEV_COLD_BUDGET_MS,
		coldBudgetMs: DEV_COLD_BUDGET_MS,
		served,
		linkedComponents: [runtime.plan.component.id],
		events,
		streamedFrames,
	};
}
