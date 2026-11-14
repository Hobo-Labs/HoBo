import { describe, expect, it } from "vitest";
import {
	api,
	auth,
	bucket,
	CATALOG,
	catalogFactoryNames,
	crypto,
	data,
	experiment,
	flag,
	guardrail,
	job,
	kv,
	notify,
	project,
	queue,
	schedule,
	secret,
	service,
	topic,
	ui,
	web,
	websocket,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";
import { secretRef } from "../src/secret-ref.js";

interface CatalogHandleBag {
	readonly [key: string]:
		| ((args: JsonObject) => JsonValue)
		| JsonValue
		| undefined;
}

function verbCall(handle: CatalogHandleBag, verb: string) {
	const method = handle[verb];
	if (!(method instanceof Function)) {
		throw new Error(`catalog handle missing verb ${verb}`);
	}
	return method;
}

const expectedCatalog = [
	{ factory: "api", portRef: ["wasi:http", "hobo:http"], verbs: [] },
	{
		factory: "kv",
		portRef: ["wasi:keyvalue"],
		verbs: ["get", "set", "delete"],
	},
	{
		factory: "bucket",
		portRef: ["wasi:blobstore", "hobo:blob-events"],
		verbs: ["read", "write", "delete"],
	},
	{ factory: "queue", portRef: ["hobo:queue"], verbs: ["enqueue", "dequeue"] },
	{
		factory: "topic",
		portRef: ["wasi:messaging"],
		verbs: ["publish", "subscribe"],
	},
	{
		factory: "secret",
		portRef: ["wasi:config", "hobo:secrets"],
		verbs: ["put", "access"],
	},
	{
		factory: "data",
		portRef: ["hobo:data"],
		verbs: ["read", "write", "query", "admin"],
	},
	{ factory: "schedule", portRef: ["hobo:scheduler"], verbs: [] },
	{ factory: "project", portRef: ["hobo:project"], verbs: [] },
	{
		factory: "websocket",
		portRef: ["wasi:websocket", "hobo:websocket"],
		verbs: ["accept", "connect", "send", "broadcast", "subscribe"],
	},
	{ factory: "job", portRef: ["hobo:job"], verbs: ["submit"] },
	{ factory: "web", portRef: ["wasi:http"], verbs: [] },
	{ factory: "service", portRef: ["wasi:http"], verbs: [] },
	{
		factory: "flag",
		portRef: ["hobo:feature-flag"],
		verbs: ["eval", "change"],
	},
	{ factory: "auth", portRef: ["hobo:auth"], verbs: ["verify", "session"] },
	{
		factory: "crypto",
		portRef: ["hobo:crypto"],
		verbs: ["encrypt", "decrypt", "sign", "verify"],
	},
	{ factory: "notify", portRef: ["hobo:notify"], verbs: ["send"] },
	{ factory: "guardrail", portRef: ["hobo:guardrail"], verbs: ["check"] },
	{ factory: "ui", portRef: ["hobo:ui-render"], verbs: ["render", "drive"] },
	{
		factory: "experiment",
		portRef: ["hobo:experiment"],
		verbs: ["assign", "expose", "analyze"],
	},
] as const;

const factories = {
	api,
	kv,
	bucket,
	queue,
	topic,
	secret,
	data,
	schedule,
	project,
	websocket,
	job,
	web,
	service,
	flag,
	auth,
	crypto,
	notify,
	guardrail,
	ui,
	experiment,
};

describe("resource catalog", () => {
	it("has exactly one factory per catalog row", () => {
		// Plan 21 base factories plus external/container/wasm-component (+ optional).
		expect(catalogFactoryNames()).not.toContain("golden");
		expect(CATALOG.length).toBeGreaterThanOrEqual(20);
		expect(catalogFactoryNames()).toHaveLength(CATALOG.length);
		expect(new Set(catalogFactoryNames()).size).toBe(CATALOG.length);

		for (const expected of expectedCatalog) {
			const entry = CATALOG.find((row) => row.factory === expected.factory);
			expect(entry).toBeDefined();
			expect(entry?.portRef).toEqual(expected.portRef);
			expect(entry?.allowVerbs).toEqual(expected.verbs);
			// SAFETY: assertion required at this I/O or test boundary.
			expect(
				factories[expected.factory as keyof typeof factories] instanceof
					Function,
			).toBe(true);
		}
	});

	it("returns frozen handles with deterministic lowering descriptors", () => {
		for (const expected of expectedCatalog) {
			// SAFETY: assertion required at this I/O or test boundary.
			const factory = factories[expected.factory as keyof typeof factories];
			const handle = factory(`${expected.factory}-main`);

			expect(Object.isFrozen(handle)).toBe(true);
			expect(handle.kind).toBe(expected.factory);
			expect(handle.stableId).toBe(
				`${expected.factory}:${expected.factory}-main`,
			);
			expect(handle.portRef).toEqual(expected.portRef);

			// SAFETY: assertion required at this I/O or test boundary.
			const narrowed = handle.allow(...(expected.verbs as never[]));
			expect(narrowed).not.toBe(handle);
			expect(Object.isFrozen(narrowed)).toBe(true);
			expect(narrowed.declaredAllow).toEqual(expected.verbs);

			for (const verb of expected.verbs) {
				const descriptor = verbCall(
					handle,
					verb,
				)({
					example: true,
				});
				expect(Object.isFrozen(descriptor)).toBe(true);
				expect(descriptor).toEqual({
					lowersTo: "hobo:sdk",
					kind: expected.factory,
					name: `${expected.factory}-main`,
					handleStableId: `${expected.factory}:${expected.factory}-main`,
					portRef: expected.portRef,
					verb,
					args: [{ example: true }],
				});
			}
		}
	});

	it("throws TypeError for unknown allow verbs", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		expect(() => kv("state").allow("publish" as never)).toThrow(
			/kv does not allow verb "publish"/,
		);
	});

	it("keeps secret resources distinct from secretRef value reads", () => {
		const managedStore = secret("payment-secrets");
		const valueReference = secretRef("STRIPE_API_KEY");

		expect(managedStore.kind).toBe("secret");
		expect(managedStore.access instanceof Function).toBe(true);
		expect(valueReference.kind).toBe("secret-ref");
		expect(Object.isFrozen(valueReference)).toBe(true);
		expect("access" in valueReference).toBe(false);
		expect("allow" in valueReference).toBe(false);
	});
});
