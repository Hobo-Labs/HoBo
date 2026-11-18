import type { RunnerAdapter } from "../src/index.js";

export interface FakeBindleOptions {
	readonly handlers?: Readonly<Record<string, (request: Request) => Response>>;
	readonly resources?: Readonly<
		Record<string, { readonly kind: string; readonly dependsOn?: string[] }>
	>;
	readonly edges?: readonly { readonly from: string; readonly to: string }[];
	readonly name?: string;
}

export interface FakeBindleResource {
	readonly kind: string;
	readonly name: string;
	readonly stableId: string;
	readonly declaredAllow: readonly string[];
	readonly annotations: readonly string[];
	readonly dependsOn: readonly string[];
}

export interface FakeBindle {
	readonly name: string;
	readonly resources: Readonly<Record<string, FakeBindleResource>>;
	readonly edges: readonly { readonly from: string; readonly to: string }[];
	readonly requirements: {
		readonly require: readonly string[];
		readonly prefer: readonly string[];
		readonly runtimes: readonly string[];
		readonly labels: Readonly<Record<string, string>>;
	};
	entrypoint(alias: string): (() => (request: Request) => Response) | undefined;
}

export function fakeBindle(options: FakeBindleOptions = {}): FakeBindle {
	const handlers = options.handlers ?? {
		api: () => new Response("ok", { status: 200 }),
	};
	const resources = options.resources ?? {
		api: { kind: "api", dependsOn: ["db"] },
		db: { kind: "data", dependsOn: [] },
		cache: { kind: "kv", dependsOn: [] },
	};
	const records: Record<string, FakeBindleResource> = {};
	for (const [alias, entry] of Object.entries(resources)) {
		records[alias] = {
			kind: entry.kind,
			name: alias,
			stableId: `${entry.kind}:${alias}`,
			declaredAllow: [],
			annotations: [],
			dependsOn: entry.dependsOn ?? [],
		};
	}
	return {
		name: options.name ?? "demo",
		resources: records,
		edges: options.edges ?? [],
		requirements: { require: [], prefer: [], runtimes: [], labels: {} },
		entrypoint(
			alias: string,
		): (() => (request: Request) => Response) | undefined {
			const handler = handlers[alias];
			return handler === undefined ? undefined : () => handler;
		},
	};
}

export interface RecordingRunner {
	readonly adapter: RunnerAdapter;
	readonly calls: string[];
	run(hook: "beforeAll" | "afterAll"): Promise<void>;
}

export function recordingRunner(): RecordingRunner {
	const calls: string[] = [];
	const registered = new Map<string, () => void | Promise<void>>();
	const hook =
		(name: string) =>
		(fn: () => void | Promise<void>): void => {
			calls.push(name);
			registered.set(name, fn);
		};
	return {
		adapter: {
			id: "recording",
			beforeAll: hook("beforeAll"),
			afterAll: hook("afterAll"),
			beforeEach: hook("beforeEach"),
			afterEach: hook("afterEach"),
			test: (name: string) => {
				calls.push(`test:${name}`);
			},
		},
		calls,
		async run(name): Promise<void> {
			await registered.get(name)?.();
		},
	};
}

export const CAMP_ENV = Object.freeze({
	HOBO_TESTING_CAMP_CREDENTIAL_REF: "hobo-secret://tenant-1/yard-aws/deploy",
	VITEST: "true",
});

export const YARD_LIKE = Object.freeze({
	kind: "yard",
	name: "yard:aws",
	providerId: "aws",
});
