import { describe, expect, it } from "vitest";

import {
	buildOpaInput,
	createOpaGatePlane,
	type JsonValue,
	OPA_DECISION_PATH,
	OPA_ENGINE_ID,
	type PolicyEngineFetch,
} from "../src/index.js";

const request = {
	subject: { kind: "user", id: "u1" },
	action: "deploy",
	resource: { kind: "bindle", id: "b1" },
	phase: "plan",
	context: { target: "prod" },
};
const costQuota = { quota: "resources", used: 0, limit: 100 };

function fetchReturning(
	status: number,
	body: JsonValue,
	capture?: { url: string | undefined; body: string | undefined },
): PolicyEngineFetch {
	return async (url, init) => {
		if (capture) {
			capture.url = url;
			capture.body = init.body;
		}
		return { status, json: async () => body };
	};
}

describe("createOpaGatePlane", () => {
	it("queries the Data API decision path and lowers the Rego result", async () => {
		const capture = { url: undefined, body: undefined };
		const plane = createOpaGatePlane({
			endpoint: "http://opa:8181/",
			fetchFn: fetchReturning(
				200,
				{
					result: {
						effect: "deny",
						reasons: [
							{
								plane: "residency",
								code: "jurisdiction-not-allowed",
								message: "outside eu",
							},
						],
						policyIds: ["hobo.policy.residency/v1"],
					},
				},
				capture,
			),
		});

		const decision = await plane.evaluate({ request, costQuota });
		expect(capture.url).toBe(`http://opa:8181/v1/data/${OPA_DECISION_PATH}`);
		expect(JSON.parse(capture.body ?? "{}")).toEqual(
			buildOpaInput({ request, costQuota }),
		);
		expect(decision.effect).toBe("deny");
		expect(decision.reasons[0]?.plane).toBe("residency");
		const fact = decision.events[0];
		expect(fact?.type).toBe("policy.Decided");
		expect(fact?.engine).toBe(OPA_ENGINE_ID);
	});

	it("fails closed on transport errors, non-200s, and missing results", async () => {
		const broken = createOpaGatePlane({
			endpoint: "http://opa:8181",
			fetchFn: async () => {
				throw new Error("connection refused");
			},
		});
		const transport = await broken.evaluate({ request, costQuota });
		expect(transport.effect).toBe("deny");
		expect(transport.reasons[0]?.code).toBe("policy-engine-unavailable");

		const http500 = createOpaGatePlane({
			endpoint: "http://opa:8181",
			fetchFn: fetchReturning(500, {}),
		});
		expect((await http500.evaluate({ request, costQuota })).effect).toBe(
			"deny",
		);

		const empty = createOpaGatePlane({
			endpoint: "http://opa:8181",
			fetchFn: fetchReturning(200, {}),
		});
		expect(
			(await empty.evaluate({ request, costQuota })).reasons[0]?.code,
		).toBe("policy-engine-unavailable");
	});

	it("unknown effects fail closed to deny with a reason; allow records the fact", async () => {
		const weird = createOpaGatePlane({
			endpoint: "http://opa:8181",
			fetchFn: fetchReturning(200, { result: { effect: "shrug" } }),
		});
		const denied = await weird.evaluate({ request, costQuota });
		expect(denied.effect).toBe("deny");
		expect(denied.reasons[0]?.code).toBe("policy-denied");

		const allow = createOpaGatePlane({
			endpoint: "http://opa:8181",
			fetchFn: fetchReturning(200, { result: { effect: "allow" } }),
		});
		const allowed = await allow.evaluate({ request, costQuota });
		expect(allowed.effect).toBe("allow");
		expect(allowed.events).toHaveLength(1);
	});

	it("sends the brokered bearer token when a tokenProvider is configured", async () => {
		let seenAuth: string | undefined;
		const plane = createOpaGatePlane({
			endpoint: "http://opa:8181",
			tokenProvider: () => "tok-123",
			fetchFn: async (_url, init) => {
				seenAuth = init.headers.authorization;
				return {
					status: 200,
					json: async () => ({ result: { effect: "allow" } }),
				};
			},
		});
		await plane.evaluate({ request, costQuota });
		expect(seenAuth).toBe("Bearer tok-123");
	});
});
