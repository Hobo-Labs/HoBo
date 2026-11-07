import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	observeResolverLifecycle,
	parseResourceLifecycleObservation,
	type ResourceLifecycleContext,
	ResourceLifecycleObservationRecordSchema,
} from "../src/ports/resource-lifecycle.js";
import {
	RESOLVER_CONTRACT,
	type ResolveRequest,
	type ResourceResolver,
} from "../src/ports/resource-resolver.js";

const digest = `sha256:${"a".repeat(64)}`;
const context: ResourceLifecycleContext & { evidenceRef: string } = {
	tenantId: "tenant",
	providerId: "test",
	providerAccountId: "test-account",
	productId: "test.service",
	resourceId: "api",
	operationId: "prepare-1",
	nowMs: 1000,
	maxAgeMs: 100,
	evidenceRef: "provider://read/1",
};
const record = () => ({
	...context,
	physicalId: "resource-1",
	status: "ready",
	observedAtMs: 1000,
	operationTerminal: true,
	artifactDigest: digest,
});
function evidence() {
	const { nowMs: _clock, maxAgeMs: _age, ...wire } = record();
	return wire;
}
const request: ResolveRequest = {
	ref: {
		slot: "service",
		productId: "test.service",
		logicalId: "api",
		physicalId: "resource-1",
	},
	desired: {},
	credentialRef: "secretref://provider/test",
};
function resolver(outputs: ResolveOutcomeOutputs): ResourceResolver {
	const outcome = {
		contract: RESOLVER_CONTRACT,
		action: "noop" as const,
		physicalId: "resource-1",
		outputs,
		diagnostics: [],
	};
	return {
		providerId: "test",
		productId: "test.service",
		reconcile: async () => outcome,
		delete: async () => {},
		read: async () => outcome,
	};
}
type ResolveOutcomeOutputs =
	import("../src/ports/resource-resolver.js").ResolveOutcome["outputs"];

describe("provider lifecycle evidence", () => {
	it("samples the trusted clock after asynchronous provider IO without allowing future evidence", async () => {
		let nowMs = 1000;
		const native = {
			...resolver({}),
			read: async () => {
				nowMs = 1010;
				return {
					contract: RESOLVER_CONTRACT,
					action: "noop" as const,
					physicalId: "resource-1",
					outputs: {
						ready: true,
						operationConfirmed: true,
						observedAtMs: 1005,
					},
					diagnostics: [],
				};
			},
		};
		const result = await observeResolverLifecycle({
			resolver: native,
			request,
			transport: async () => {
				throw new Error("unused");
			},
			context,
			nowMs: () => nowMs,
		});
		expect(result.observedAtMs).toBe(1005);
		await expect(
			observeResolverLifecycle({
				resolver: native,
				request,
				transport: async () => {
					throw new Error("unused");
				},
				context,
				nowMs: () => 1004,
			}),
		).rejects.toThrow("future");
	});
	it("accepts only independently reported, credential-free native serving endpoints", async () => {
		for (const servingEndpoint of [
			"https://token@host.test/",
			"https://host.test/?token=x",
			"https://host.test/#claim",
			"http://host.test/",
			"javascript:alert(1)",
		])
			expect(() =>
				parseResourceLifecycleObservation(
					{ ...evidence(), servingEndpoint },
					context,
				),
			).toThrow();
		const result = await observeResolverLifecycle({
			resolver: resolver({
				ready: true,
				operationConfirmed: true,
				servingEndpoint: "https://native.test/app/",
				artifactDigest: digest,
			}),
			request,
			transport: async () => {
				throw new Error("unused");
			},
			context,
		});
		expect(result.servingEndpoint).toBe("https://native.test/app/");
	});
	it("does not renew a cached terminal receipt's timestamp by reading it", async () => {
		const observe = (observedAtMs: number) =>
			observeResolverLifecycle({
				resolver: resolver({
					absenceConfirmed: true,
					operationTerminal: true,
					observedAtMs,
					evidenceRef: "provider://original-terminal-read",
				}),
				request,
				transport: async () => {
					throw new Error("unused");
				},
				context,
			});
		expect(await observe(950)).toMatchObject({
			status: "absent",
			observedAtMs: 950,
			evidenceRef: "provider://original-terminal-read",
		});
		await expect(observe(899)).rejects.toThrow("stale");
		await expect(observe(1001)).rejects.toThrow("future");
		await expect(observe(Number.NaN)).rejects.toThrow();
	});
	it("accepts canonical generated records and binds expected observed artifacts", () => {
		const input = create(ResourceLifecycleObservationRecordSchema, evidence());
		expect(
			parseResourceLifecycleObservation(input, {
				...context,
				artifactDigest: digest,
			}).status,
		).toBe("ready");
	});
	it.each([
		"tenantId",
		"providerId",
		"providerAccountId",
		"productId",
		"resourceId",
		"operationId",
	] as const)("rejects foreign %s", (field) => {
		expect(() =>
			parseResourceLifecycleObservation(
				{ ...evidence(), [field]: "foreign" },
				context,
			),
		).toThrow("foreign");
	});
	it("rejects stale, future, other-physical and other-artifact evidence", () => {
		for (const input of [
			{ ...evidence(), observedAtMs: 899 },
			{ ...evidence(), observedAtMs: 1001 },
		])
			expect(() => parseResourceLifecycleObservation(input, context)).toThrow();
		expect(() =>
			parseResourceLifecycleObservation(evidence(), {
				...context,
				physicalId: "other",
			}),
		).toThrow("physical");
		expect(() =>
			parseResourceLifecycleObservation(evidence(), {
				...context,
				artifactDigest: `sha256:${"b".repeat(64)}`,
			}),
		).toThrow("artifact");
	});
	it("never turns invalid or omitted monetary evidence into zero through JSON normalization", () => {
		expect(() =>
			parseResourceLifecycleObservation(
				create(ResourceLifecycleObservationRecordSchema, {
					...evidence(),
					usageFinal: true,
					usageEvidenceRef: "provider://usage/final",
				}),
				context,
			),
		).toThrow("explicit safe integer money");
		expect(
			parseResourceLifecycleObservation(
				create(ResourceLifecycleObservationRecordSchema, {
					...evidence(),
					usageFinal: true,
					usageEvidenceRef: "provider://usage/final",
					settledMicros: 0,
				}),
				context,
			).settledMicros,
		).toBe(0);
		for (const settledMicros of [
			Number.NaN,
			Infinity,
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			undefined,
		])
			expect(() =>
				parseResourceLifecycleObservation(
					{
						...evidence(),
						usageFinal: true,
						usageEvidenceRef: "provider://usage/final",
						settledMicros,
					},
					context,
				),
			).toThrow();
		for (const observedAtMs of [Number.NaN, Infinity, undefined])
			expect(() =>
				parseResourceLifecycleObservation(
					{ ...evidence(), observedAtMs },
					context,
				),
			).toThrow();
	});
	it("requires terminal absence, independent health and authoritative final charges", () => {
		for (const input of [
			{ ...evidence(), status: "absent", operationTerminal: false },
			{ ...evidence(), healthy: true },
			{ ...evidence(), usageFinal: true, settledMicros: 0 },
		])
			expect(() => parseResourceLifecycleObservation(input, context)).toThrow();
	});
	it("reads actual control-plane readiness without claiming application health or final billing", async () => {
		const result = await observeResolverLifecycle({
			resolver: resolver({
				ready: true,
				operationConfirmed: true,
				artifactDigest: digest,
			}),
			request,
			transport: async () => {
				throw new Error("unused");
			},
			context,
		});
		expect(result).toMatchObject({
			status: "ready",
			healthy: false,
			usageFinal: false,
			artifactDigest: digest,
		});
	});
	it("never invents an artifact marker or terminal absence from a missing GET", async () => {
		await expect(
			observeResolverLifecycle({
				resolver: resolver({ ready: true, operationConfirmed: true }),
				request,
				transport: async () => {
					throw new Error("unused");
				},
				context: { ...context, artifactDigest: digest },
			}),
		).rejects.toThrow("artifact");
		const missing = { ...resolver({}), read: async () => undefined };
		const observed = await observeResolverLifecycle({
			resolver: missing,
			request,
			transport: async () => {
				throw new Error("unused");
			},
			context,
		});
		expect(observed).toMatchObject({
			status: "unknown",
			operationTerminal: false,
			usageFinal: false,
		});
	});
});
