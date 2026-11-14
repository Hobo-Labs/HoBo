import type { JsonValue } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	createInfisicalPlanObserver,
	type InfisicalPlanAttempt,
	type InfisicalPlanLeaseScope,
	oidcAuth,
	parseInfisicalBinding,
	parseInfisicalIdentityId,
} from "../src/index.js";

const identityId = parseInfisicalIdentityId("identity-1");
const binding = parseInfisicalBinding({
	siteUrl: "https://app.infisical.com",
	projectId: "project-1",
	environment: "prod",
	secretPath: "/hobo-ci-relay",
});
const expectedScope = {
	tenantId: "tenant-1",
	leaseId: "lease-1",
	siteUrl: binding.siteUrl,
	projectId: binding.projectId,
	organizationId: "org-1",
	rootOrganizationId: "root-org-1",
	identityId,
};

function fixture(
	options: {
		projectOrg?: string;
		plan?: JsonValue;
		deny?: InfisicalPlanAttempt["operation"];
		expireBeforeSend?: InfisicalPlanAttempt["operation"];
		projectUnauthorizedOnce?: boolean;
	} = {},
) {
	const events: string[] = [];
	let leaseValid = true;
	let projectRequests = 0;
	const requests: string[] = [];
	const response = (status: number, body: JsonValue) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	const send: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const operation = url.pathname.endsWith("/login")
			? "login"
			: url.pathname.includes("/projects/")
				? "read-project"
				: "read-plan";
		requests.push(operation);
		events.push(`send:${operation}`);
		expect(init?.redirect).toBe("error");
		if (operation === "login")
			return response(200, {
				accessToken: "test-access-token",
				tokenType: "Bearer",
				expiresIn: 600,
			});
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer test-access-token",
		);
		if (operation === "read-project") {
			projectRequests++;
			if (options.projectUnauthorizedOnce && projectRequests === 1)
				return response(401, {});
			return response(200, {
				project: {
					id: binding.projectId,
					orgId: options.projectOrg ?? "org-1",
				},
			});
		}
		return response(200, {
			plan: options.plan ?? {
				slug: "pro",
				rateLimits: { readLimit: 90, writeLimit: 120, secretsLimit: 75 },
			},
		});
	};
	const observer = createInfisicalPlanObserver({
		client: {
			binding,
			auth: oidcAuth({ identityId, jwt: async () => "a.b.c" }),
			fetch: send,
			now: () => 1_800_000_000_000,
		},
		tenantId: "tenant-1",
		leaseId: "lease-1",
		organizationId: "org-1",
		rootOrganizationId: "root-org-1",
		async verifyLease(scope: InfisicalPlanLeaseScope) {
			expect(scope).toEqual(expectedScope);
			if (!leaseValid) throw new Error("lease token must stay secret");
		},
		async reserveAttempt(attempt) {
			expect(attempt.scope).toEqual(expectedScope);
			events.push(`reserve:${attempt.operation}`);
			if (attempt.operation === options.deny)
				throw new Error("budget token must stay secret");
			return async () => {
				events.push(`claim:${attempt.operation}`);
				if (attempt.operation === options.expireBeforeSend) leaseValid = false;
			};
		},
	});
	return { observer, events, requests };
}

describe("Infisical organization plan observation", () => {
	it("binds the provider-reported project to the enrolled account and funds each request", async () => {
		const f = fixture();
		const actual = await f.observer.observe();
		expect(actual).toEqual({
			scope: expectedScope,
			slug: "pro",
			limits: { read: 90, write: 120, secrets: 75 },
			observedAtMs: 1_800_000_000_000,
			completedAtMs: 1_800_000_000_000,
			providerFreshness: "unverified",
		});
		expect(f.events).toEqual([
			"reserve:login",
			"claim:login",
			"send:login",
			"reserve:read-project",
			"claim:read-project",
			"send:read-project",
			"reserve:read-plan",
			"claim:read-plan",
			"send:read-plan",
		]);
	});

	it("rejects a foreign project account without requesting its plan", async () => {
		const f = fixture({ projectOrg: "other-org" });
		await expect(f.observer.observe()).rejects.toThrow("invalid-response");
		expect(f.requests).toEqual(["login", "read-project"]);
	});

	it("does not send after a reservation is denied or the scoped lease expires", async () => {
		const denied = fixture({ deny: "read-plan" });
		await expect(denied.observer.observe()).rejects.toThrow(
			"budget-unavailable",
		);
		expect(denied.requests).toEqual(["login", "read-project"]);
		const expired = fixture({ expireBeforeSend: "read-project" });
		await expect(expired.observer.observe()).rejects.toThrow(
			"lease-unverified",
		);
		expect(expired.requests).toEqual(["login"]);
	});

	it("funds a fresh login and every retry after the provider rejects a token", async () => {
		const f = fixture({ projectUnauthorizedOnce: true });
		await f.observer.observe();
		expect(f.requests).toEqual([
			"login",
			"read-project",
			"login",
			"read-project",
			"read-plan",
		]);
		expect(f.events.filter((event) => event.startsWith("claim:"))).toHaveLength(
			5,
		);
	});

	it("keeps a slugless fallback report unverified and refuses malformed limits", async () => {
		const fallback = fixture({
			plan: {
				slug: null,
				rateLimits: { readLimit: 60, writeLimit: 200, secretsLimit: 60 },
			},
		});
		expect(await fallback.observer.observe()).toMatchObject({
			slug: null,
			providerFreshness: "unverified",
		});
		const malformed = fixture({
			plan: {
				slug: "pro",
				rateLimits: { readLimit: -1, writeLimit: 2, secretsLimit: 3 },
			},
		});
		await expect(malformed.observer.observe()).rejects.toThrow(
			"invalid-response",
		);
	});
});
