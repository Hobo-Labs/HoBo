/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-chained-type-assertions -- SAFETY: a recording stand-in for the whole frozen ContinuousDelivery facade, cast once; members the tests do not stub resolve to a recorded call. */
// A recording ContinuousDelivery facade for the `hobo deploy` / `hobo
// incident` tests (WP18). Each module is a proxy: a stubbed method returns its
// stub, any other method records the call and returns an empty list.
import { create } from "@bufbuild/protobuf";
import {
	type CdContext,
	type ContinuousDelivery,
	type FreightRecord,
	FreightRecordSchema,
	type PromotionRecord,
	PromotionRecordSchema,
	PromotionState,
	ReasonRecordSchema,
} from "@hobo/cd";
import type { CdDeployHost } from "../../src/cd-deploy.js";

export type Call = Readonly<{
	module: string;
	method: string;
	args: readonly unknown[];
}>;

const LIST_METHODS = new Set([
	"list",
	"sets",
	"qualifications",
	"approvals",
	"compliance",
	"conflicts",
	"remediations",
	"history",
	"available",
	"listPreviews",
	"camps",
]);

type Stubs = Record<string, Record<string, (...args: unknown[]) => unknown>>;

export function fakeCd(
	stubs: Stubs = {},
	calls: Call[] = [],
): ContinuousDelivery {
	const modules = new Map<string, unknown>();
	const moduleOf = (name: string) => {
		const existing = modules.get(name);
		if (existing) return existing;
		const proxy = new Proxy(
			{},
			{
				get(_t, method) {
					if (method === "then" || typeof method !== "string") return undefined;
					if (name === "telemetry" && method === "health")
						return () => ({ ok: true, checks: [] });
					return async (...args: unknown[]) => {
						calls.push({ module: name, method, args });
						const stub = stubs[name]?.[method];
						if (stub) return stub(...args);
						return LIST_METHODS.has(method) ? [] : undefined;
					};
				},
			},
		);
		modules.set(name, proxy);
		return proxy;
	};
	return new Proxy(
		{},
		{
			get(_t, property) {
				if (typeof property !== "string" || property === "then")
					return undefined;
				if (property === "deltas") return moduleOf("desired");
				return moduleOf(property);
			},
		},
	) as ContinuousDelivery;
}

export const ctx: CdContext = {
	tenant: "t1",
	principal: { kind: "user", id: "alice" },
	now: () => Date.UTC(2026, 10, 12),
};

export function host(
	cd: ContinuousDelivery,
	over: Partial<CdDeployHost> = {},
): CdDeployHost {
	return { cd, ctx, cwd: "/tmp", simulated: false, ...over };
}

export const FREIGHT: FreightRecord = create(FreightRecordSchema, {
	schemaVersion: "hobo.cd.freight/v1",
	freightId: `sha256:${"f".repeat(64)}`,
	alias: "brave-otter",
	manifest: { bindle: "web", declarationHash: `sha256:${"d".repeat(64)}` },
});

export function promotion(
	over: Partial<PromotionRecord> = {},
): PromotionRecord {
	return create(PromotionRecordSchema, {
		promotionId: "prm-1",
		freightId: FREIGHT.freightId,
		targetCampIds: ["yard/prod"],
		state: PromotionState.QUEUED,
		...over,
	});
}

export function refusal(code: string, remediation: string) {
	return {
		ok: false as const,
		reasons: [
			create(ReasonRecordSchema, {
				code,
				message: `${code} happened`,
				remediation,
			}),
		],
	};
}

export function runInput(args: string[], flags: Record<string, unknown> = {}) {
	return {
		args,
		flags,
		verb: "deploy",
		context: {
			cwd: "/tmp",
			projectDir: "/tmp",
			identity: null,
			clients: { readApi: "", runtime: "" },
		},
		emitProgress: () => {},
	} as never;
}
