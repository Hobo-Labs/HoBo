/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SAFETY: tests read controlled JSON envelopes. */
// Shared provider harness for the CD read-API tests and its PACT.
import type { FeedRequest, FeedResponse } from "../../src/ports.js";
import { createCdControlApi, createCdService } from "../../src/service/index.js";
import { fakeFacade, fakeReconciler, fakeStore, principal, recordingSink, topologyOf } from "./fakes.js";
import { seedJournal, world } from "./state.js";

export function setupApi(opts: { streamMaxMs?: number } = {}) {
	const store = fakeStore();
	const state = world();
	const cd = fakeFacade(state);
	const sink = recordingSink();
	seedJournal(store);
	const service = createCdService({
		store,
		tenant: "t1",
		now: () => 1_700_000_000_000,
		cd,
		reconcilers: [fakeReconciler("r1", ["eu-1"])],
		retention: [],
		tickIntervalMs: 60_000,
		principal,
	});
	const api = createCdControlApi({
		store,
		tenant: "t1",
		now: () => 1_700_000_000_000,
		cd,
		topology: topologyOf(state.camps),
		service,
		telemetry: sink,
		streamPollMs: 5,
		streamHeartbeatMs: 10,
		streamMaxMs: opts.streamMaxMs ?? 60,
	});
	return { store, state, cd, sink, service, api };
}

export function get(path: string, headers: Record<string, string> = {}): FeedRequest {
	return { method: "GET", path, headers, body: new Uint8Array() };
}

export async function json(res: FeedResponse): Promise<{ ok: boolean; value?: any; reasons?: any[] }> {
	if (!(res.body instanceof Uint8Array)) throw new Error("expected a JSON body");
	return JSON.parse(new TextDecoder().decode(res.body));
}

export async function text(res: FeedResponse): Promise<string> {
	if (res.body instanceof Uint8Array) return new TextDecoder().decode(res.body);
	let out = "";
	const decoder = new TextDecoder();
	for await (const chunk of res.body) out += decoder.decode(chunk, { stream: true });
	return out;
}

