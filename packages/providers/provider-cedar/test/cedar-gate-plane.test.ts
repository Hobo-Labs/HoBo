import { describe, expect, it } from "vitest";

import {
	buildCedarRequest,
	CEDAR_ENGINE_ID,
	createCedarGatePlane,
	type JsonValue,
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

describe("createCedarGatePlane", () => {
	it("maps the Policy IR request onto Cedar entity literals", () => {
		const cedarRequest = buildCedarRequest({ request, costQuota });
		expect(cedarRequest.principal).toBe('User::"u1"');
		expect(cedarRequest.action).toBe('Action::"deploy"');
		expect(cedarRequest.resource).toBe('Bindle::"b1"');
		expect(cedarRequest.context).toMatchObject({
			phase: "plan",
			target: "prod",
			costQuota,
		});
	});

	it("only an explicit Allow allows; deny cites the policy ids", async () => {
		const capture = { url: undefined, body: undefined };
		const denyPlane = createCedarGatePlane({
			endpoint: "http://cedar:8180/",
			fetchFn: fetchReturning(
				200,
				{ decision: "Deny", diagnostics: { reason: ["policy0"], errors: [] } },
				capture,
			),
		});
		const denied = await denyPlane.evaluate({ request, costQuota });
		expect(capture.url).toBe("http://cedar:8180/v1/is_authorized");
		expect(denied.effect).toBe("deny");
		expect(denied.reasons[0]?.message).toContain("policy0");
		const fact = denied.events[0];
		expect(fact?.type).toBe("policy.Decided");
		expect(fact?.engine).toBe(CEDAR_ENGINE_ID);

		const allowPlane = createCedarGatePlane({
			endpoint: "http://cedar:8180",
			fetchFn: fetchReturning(200, { decision: "Allow" }),
		});
		const allowed = await allowPlane.evaluate({ request, costQuota });
		expect(allowed.effect).toBe("allow");
		expect(allowed.reasons).toEqual([]);
		expect(allowed.events).toHaveLength(1);
	});

	it("fails closed on transport errors, non-200s, and malformed verdicts", async () => {
		const broken = createCedarGatePlane({
			endpoint: "http://cedar:8180",
			fetchFn: async () => {
				throw new Error("connection refused");
			},
		});
		const transport = await broken.evaluate({ request, costQuota });
		expect(transport.effect).toBe("deny");
		expect(transport.reasons[0]?.code).toBe("policy-engine-unavailable");

		const http500 = createCedarGatePlane({
			endpoint: "http://cedar:8180",
			fetchFn: fetchReturning(500, {}),
		});
		expect((await http500.evaluate({ request, costQuota })).effect).toBe(
			"deny",
		);

		const malformed = createCedarGatePlane({
			endpoint: "http://cedar:8180",
			fetchFn: fetchReturning(200, { decision: "Maybe" }),
		});
		expect((await malformed.evaluate({ request, costQuota })).effect).toBe(
			"deny",
		);
	});

	it("sends the brokered bearer token when a tokenProvider is configured", async () => {
		let seenAuth: string | undefined;
		const plane = createCedarGatePlane({
			endpoint: "http://cedar:8180",
			tokenProvider: () => "tok-456",
			fetchFn: async (_url, init) => {
				seenAuth = init.headers.authorization;
				return { status: 200, json: async () => ({ decision: "Allow" }) };
			},
		});
		await plane.evaluate({ request, costQuota });
		expect(seenAuth).toBe("Bearer tok-456");
	});
});
