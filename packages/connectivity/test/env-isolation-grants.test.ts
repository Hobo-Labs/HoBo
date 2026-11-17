import { describe, expect, test } from "vitest";

import { ACCESS_EVENTS } from "../src/env-isolation/events.js";
import {
	BREAK_GLASS_SCHEMA,
	BreakGlassService,
	CROSS_ENV_GRANT_SCHEMA,
	CrossEnvGrantStore,
} from "../src/env-isolation/grants.js";
import {
	BREAK_GLASS_TTL_SECONDS,
	ELEVATED_CAPABILITY_TTL_SECONDS,
} from "../src/env-isolation/types.js";
import { isJsonString } from "../src/json.js";

const TENANT = "tenant-a";
const T0 = "2026-01-01T00:00:00.000Z";

function clock(start = T0) {
	let current = Date.parse(start);
	return {
		now: () => new Date(current).toISOString(),
		advanceSeconds(seconds: number) {
			current += seconds * 1000;
		},
		at(seconds: number) {
			return new Date(Date.parse(start) + seconds * 1000).toISOString();
		},
	};
}

function crossEnvStore(now: () => string = () => T0) {
	return new CrossEnvGrantStore({ tenant: TENANT, now });
}

function breakGlass(now: () => string = () => T0) {
	return new BreakGlassService({ tenant: TENANT, now });
}

function codeOf<T>(fn: () => T): string {
	try {
		fn();
	} catch (error) {
		return error instanceof Error && "code" in error && isJsonString(error.code)
			? error.code
			: `<no code: ${String(error)}>`;
	}
	return "<did not throw>";
}

describe("cross-env grants: issue refusals", () => {
	test("a grant between identical classes is refused", () => {
		const store = crossEnvStore();
		expect(() =>
			store.issue({
				fromClass: "development",
				toClass: "development",
				reason: "r",
				issuedBy: "alice",
			}),
		).toThrow(TypeError);
	});

	test("a production grant with no approver is refused under dual control", () => {
		const store = crossEnvStore();
		expect(
			codeOf(() =>
				store.issue({
					fromClass: "development",
					toClass: "production",
					reason: "incident",
					issuedBy: "alice",
				}),
			),
		).toBe("dual-control-required");
	});

	test("an empty approver list is not an approver", () => {
		const store = crossEnvStore();
		expect(
			codeOf(() =>
				store.issue({
					fromClass: "development",
					toClass: "production",
					reason: "incident",
					issuedBy: "alice",
					dualControlApprovers: [],
				}),
			),
		).toBe("dual-control-required");
	});

	test("a production grant with an approver is issued", () => {
		const store = crossEnvStore();
		const grant = store.issue({
			fromClass: "staging",
			toClass: "production",
			reason: "incident",
			issuedBy: "alice",
			dualControlApprovers: ["bob"],
		});
		expect(grant.toClass).toBe("production");
		expect(grant.dualControlApprovers).toEqual(["bob"]);
	});

	test("a non-production grant needs no approver", () => {
		const store = crossEnvStore();
		expect(() =>
			store.issue({
				fromClass: "development",
				toClass: "staging",
				reason: "testing",
				issuedBy: "alice",
			}),
		).not.toThrow();
	});

	test("a refused grant leaves no record behind", () => {
		const store = crossEnvStore();
		codeOf(() =>
			store.issue({
				fromClass: "development",
				toClass: "production",
				reason: "incident",
				issuedBy: "alice",
			}),
		);
		expect(store.events).toHaveLength(0);
	});
});

describe("cross-env grants: issued shape", () => {
	test("the grant carries the pinned schema and a namespaced id", () => {
		const grant = crossEnvStore().issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
		});
		expect(grant.schemaVersion).toBe(CROSS_ENV_GRANT_SCHEMA);
		expect(grant.id).toMatch(/^xenv_\d+$/);
	});

	test("ids are unique across issues", () => {
		const store = crossEnvStore();
		const ids = new Set(
			Array.from(
				{ length: 5 },
				() =>
					store.issue({
						fromClass: "development",
						toClass: "staging",
						reason: "r",
						issuedBy: "alice",
					}).id,
			),
		);
		expect(ids.size).toBe(5);
	});

	test("the expiry is derived from the default TTL when none is given", () => {
		const grant = crossEnvStore().issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
		});
		expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(
			ELEVATED_CAPABILITY_TTL_SECONDS * 1000,
		);
	});

	test("an explicit TTL is honoured", () => {
		const grant = crossEnvStore().issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
			ttlSeconds: 60,
		});
		expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(
			60_000,
		);
	});

	test("the default obligations are audit-session and time-bound", () => {
		expect(
			crossEnvStore().issue({
				fromClass: "development",
				toClass: "staging",
				reason: "r",
				issuedBy: "alice",
			}).obligations,
		).toEqual(["audit-session", "time-bound"]);
	});

	test("explicit obligations replace the defaults", () => {
		expect(
			crossEnvStore().issue({
				fromClass: "development",
				toClass: "staging",
				reason: "r",
				issuedBy: "alice",
				obligations: ["record-keystrokes"],
			}).obligations,
		).toEqual(["record-keystrokes"]);
	});

	test("the grant and its lists are frozen", () => {
		const grant = crossEnvStore().issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
			principalIds: ["alice"],
		});
		expect(Object.isFrozen(grant)).toBe(true);
		expect(Object.isFrozen(grant.principalIds)).toBe(true);
		expect(Object.isFrozen(grant.obligations)).toBe(true);
	});

	test("issuing emits an event naming the classes, expiry and reason", () => {
		const store = crossEnvStore();
		store.issue({
			fromClass: "development",
			toClass: "staging",
			reason: "load testing",
			issuedBy: "alice",
		});
		const event = store.events[0];
		expect(event?.type).toBe(ACCESS_EVENTS.CrossEnvGranted);
		expect(event?.data.fromClass).toBe("development");
		expect(event?.data.toClass).toBe("staging");
		expect(event?.data.reason).toBe("load testing");
		expect(event?.data.expiresAt).toBeDefined();
	});
});

describe("cross-env grants: expiry on read", () => {
	test("an active grant is returned", () => {
		const c = clock();
		const store = crossEnvStore(c.now);
		const grant = store.issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
			ttlSeconds: 100,
		});
		expect(store.getActive(grant.id)?.id).toBe(grant.id);
	});

	test("an expired grant reads as absent and is dropped", () => {
		const c = clock();
		const store = crossEnvStore(c.now);
		const grant = store.issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
			ttlSeconds: 100,
		});
		c.advanceSeconds(101);
		expect(store.getActive(grant.id)).toBeNull();
		expect(store.getActive(grant.id, T0)).toBeNull();
	});

	test("expiry emits an event so the lapse is auditable", () => {
		const c = clock();
		const store = crossEnvStore(c.now);
		const grant = store.issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
			ttlSeconds: 100,
		});
		c.advanceSeconds(101);
		store.getActive(grant.id);
		expect(store.events.map((e) => e.type)).toContain(
			ACCESS_EVENTS.CrossEnvExpired,
		);
	});

	test("an explicit now overrides the store clock", () => {
		const store = crossEnvStore(() => T0);
		const grant = store.issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
			ttlSeconds: 100,
		});
		const c = clock();
		expect(store.getActive(grant.id, c.at(200))).toBeNull();
	});

	test("an unknown grant id reads as absent without emitting", () => {
		const store = crossEnvStore();
		expect(store.getActive("xenv_999")).toBeNull();
		expect(store.events).toHaveLength(0);
	});
});

describe("cross-env grants: allows", () => {
	function storeWith(
		principalIds: readonly string[] | undefined,
		now: () => string = () => T0,
	) {
		const store = new CrossEnvGrantStore({ tenant: TENANT, now });
		store.issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
			ttlSeconds: 100,
			...(principalIds !== undefined ? { principalIds } : undefined),
		});
		return store;
	}

	test("a grant with no principal list applies to everyone", () => {
		const store = storeWith(undefined);
		expect(
			store.allows({
				principalId: "anyone",
				fromClass: "development",
				toClass: "staging",
			}),
		).toBe(true);
	});

	test("a scoped grant applies only to its named principals", () => {
		const store = storeWith(["alice"]);
		expect(
			store.allows({
				principalId: "alice",
				fromClass: "development",
				toClass: "staging",
			}),
		).toBe(true);
		expect(
			store.allows({
				principalId: "mallory",
				fromClass: "development",
				toClass: "staging",
			}),
		).toBe(false);
	});

	test("the direction of the crossing matters", () => {
		const store = storeWith(undefined);
		expect(
			store.allows({
				principalId: "alice",
				fromClass: "staging",
				toClass: "development",
			}),
		).toBe(false);
	});

	test("a different target class is not covered", () => {
		const store = storeWith(undefined);
		expect(
			store.allows({
				principalId: "alice",
				fromClass: "development",
				toClass: "production",
			}),
		).toBe(false);
	});

	test("an expired grant does not allow", () => {
		const c = clock();
		const store = storeWith(undefined, c.now);
		c.advanceSeconds(101);
		expect(
			store.allows({
				principalId: "alice",
				fromClass: "development",
				toClass: "staging",
			}),
		).toBe(false);
	});

	test("one matching grant among several is enough", () => {
		const store = new CrossEnvGrantStore({ tenant: TENANT, now: () => T0 });
		store.issue({
			fromClass: "development",
			toClass: "production",
			reason: "r",
			issuedBy: "alice",
			dualControlApprovers: ["bob"],
			principalIds: ["someone-else"],
		});
		store.issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
			principalIds: ["alice"],
		});
		expect(
			store.allows({
				principalId: "alice",
				fromClass: "development",
				toClass: "staging",
			}),
		).toBe(true);
	});

	test("an empty store allows nothing", () => {
		expect(
			crossEnvStore().allows({
				principalId: "alice",
				fromClass: "development",
				toClass: "staging",
			}),
		).toBe(false);
	});
});

describe("break-glass: request", () => {
	test("a request starts in the requested state with no approvers", () => {
		const grant = breakGlass().request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		expect(grant.status).toBe("requested");
		expect(grant.approvers).toEqual([]);
		expect(grant.grantedAt).toBeUndefined();
		expect(grant.expiresAt).toBeUndefined();
	});

	test("the request carries the pinned schema and a namespaced id", () => {
		const grant = breakGlass().request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		expect(grant.schemaVersion).toBe(BREAK_GLASS_SCHEMA);
		expect(grant.id).toMatch(/^bg_\d+$/);
	});

	test("the four standing obligations are attached at request time", () => {
		expect(
			breakGlass().request({
				subject: "alice",
				isolationClass: "production",
				reason: "outage",
				requester: "alice",
			}).obligations,
		).toEqual([
			"dual-control",
			"full-session-recording",
			"auto-expiry",
			"post-incident-review",
		]);
	});

	test("requesting emits an event carrying the reason", () => {
		const svc = breakGlass();
		svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "database outage",
			requester: "alice",
		});
		const event = svc.events[0];
		expect(event?.type).toBe(ACCESS_EVENTS.BreakGlassRequested);
		expect(event?.data.reason).toBe("database outage");
		expect(event?.data.isolationClass).toBe("production");
	});

	test("a pending request grants nothing", () => {
		const svc = breakGlass();
		svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		expect(
			svc.allows({ subject: "alice", isolationClass: "production" }),
		).toBeNull();
	});
});

describe("break-glass: approval refusals", () => {
	function requested(svc: BreakGlassService, requester = "alice") {
		return svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester,
		});
	}

	test("the requester cannot approve their own request", () => {
		const svc = breakGlass();
		const grant = requested(svc);
		expect(
			codeOf(() => svc.approve({ grantId: grant.id, approver: "alice" })),
		).toBe("dual-control-required");
	});

	test("an unknown grant id is refused", () => {
		expect(
			codeOf(() =>
				breakGlass().approve({ grantId: "bg_999", approver: "bob" }),
			),
		).toBe("break-glass-invalid");
	});

	test("an already-granted request cannot be approved twice", () => {
		const svc = breakGlass();
		const grant = requested(svc);
		svc.approve({ grantId: grant.id, approver: "bob" });
		expect(
			codeOf(() => svc.approve({ grantId: grant.id, approver: "carol" })),
		).toBe("break-glass-invalid");
	});

	test("a reviewed grant cannot be re-approved", () => {
		const svc = breakGlass();
		const grant = requested(svc);
		svc.approve({ grantId: grant.id, approver: "bob" });
		svc.markReviewed({ grantId: grant.id, reviewer: "carol" });
		expect(
			codeOf(() => svc.approve({ grantId: grant.id, approver: "dave" })),
		).toBe("break-glass-invalid");
	});

	test("a refused approval leaves the grant in requested state", () => {
		const svc = breakGlass();
		const grant = requested(svc);
		codeOf(() => svc.approve({ grantId: grant.id, approver: "alice" }));
		expect(
			svc.allows({ subject: "alice", isolationClass: "production" }),
		).toBeNull();
	});
});

describe("break-glass: approval", () => {
	function approved(
		svc: BreakGlassService,
		options: { secondApprover?: string; ttlSeconds?: number } = {},
	) {
		const grant = svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		return svc.approve({
			grantId: grant.id,
			approver: "bob",
			...options,
		});
	}

	test("approval moves the grant to granted with an expiry and review date", () => {
		const granted = approved(breakGlass());
		expect(granted.status).toBe("granted");
		expect(granted.grantedAt).toBe(T0);
		expect(granted.expiresAt).toBeDefined();
		expect(granted.reviewDue).toBeDefined();
	});

	test("the default TTL bounds the grant", () => {
		const granted = approved(breakGlass());
		expect(
			Date.parse(String(granted.expiresAt)) -
				Date.parse(String(granted.grantedAt)),
		).toBe(BREAK_GLASS_TTL_SECONDS * 1000);
	});

	test("an explicit TTL is honoured", () => {
		const granted = approved(breakGlass(), { ttlSeconds: 300 });
		expect(
			Date.parse(String(granted.expiresAt)) -
				Date.parse(String(granted.grantedAt)),
		).toBe(300_000);
	});

	test("the review is due a week out, independent of the TTL", () => {
		const granted = approved(breakGlass(), { ttlSeconds: 60 });
		expect(
			Date.parse(String(granted.reviewDue)) -
				Date.parse(String(granted.grantedAt)),
		).toBe(7 * 86_400_000);
	});

	test("a second approver is recorded when distinct", () => {
		const granted = approved(breakGlass(), { secondApprover: "carol" });
		expect(granted.approvers).toEqual(["bob", "carol"]);
	});

	test("a second approver identical to the first is not double-counted", () => {
		const granted = approved(breakGlass(), { secondApprover: "bob" });
		expect(granted.approvers).toEqual(["bob"]);
	});

	test("an empty second approver is ignored", () => {
		const granted = approved(breakGlass(), { secondApprover: "" });
		expect(granted.approvers).toEqual(["bob"]);
	});

	test("approval emits an event naming the approvers and the expiry", () => {
		const svc = breakGlass();
		approved(svc, { secondApprover: "carol" });
		const event = svc.events.find(
			(e) => e.type === ACCESS_EVENTS.BreakGlassGranted,
		);
		expect(event?.data.approvers).toEqual(["bob", "carol"]);
		expect(event?.data.expiresAt).toBeDefined();
		expect(event?.actor).toBe("bob");
	});

	test("the original request fields survive approval", () => {
		const granted = approved(breakGlass());
		expect(granted.reason).toBe("outage");
		expect(granted.requester).toBe("alice");
		expect(granted.subject).toBe("alice");
	});
});

describe("break-glass: expiry and use", () => {
	function grantedWith(c: ReturnType<typeof clock>, ttlSeconds = 100) {
		const svc = new BreakGlassService({ tenant: TENANT, now: c.now });
		const grant = svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		svc.approve({ grantId: grant.id, approver: "bob", ttlSeconds });
		return { svc, id: grant.id };
	}

	test("an active grant is returned by getActive", () => {
		const c = clock();
		const { svc, id } = grantedWith(c);
		expect(svc.getActive(id)?.status).toBe("granted");
	});

	test("an expired grant reads as absent and is marked expired", () => {
		const c = clock();
		const { svc, id } = grantedWith(c);
		c.advanceSeconds(101);
		expect(svc.getActive(id)).toBeNull();
		expect(svc.events.map((e) => e.type)).toContain(
			ACCESS_EVENTS.BreakGlassExpired,
		);
	});

	test("a grant that was never approved is not active", () => {
		const svc = breakGlass();
		const grant = svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		expect(svc.getActive(grant.id)).toBeNull();
	});

	test("an unknown grant id is not active", () => {
		expect(breakGlass().getActive("bg_999")).toBeNull();
	});

	test("allows matches on both subject and isolation class", () => {
		const c = clock();
		const { svc } = grantedWith(c);
		expect(
			svc.allows({ subject: "alice", isolationClass: "production" }),
		).not.toBeNull();
		expect(
			svc.allows({ subject: "alice", isolationClass: "staging" }),
		).toBeNull();
		expect(
			svc.allows({ subject: "mallory", isolationClass: "production" }),
		).toBeNull();
	});

	test("allows refuses an expired grant", () => {
		const c = clock();
		const { svc } = grantedWith(c);
		c.advanceSeconds(101);
		expect(
			svc.allows({ subject: "alice", isolationClass: "production" }),
		).toBeNull();
	});

	test("allows accepts an explicit instant", () => {
		const c = clock();
		const { svc } = grantedWith(c);
		expect(
			svc.allows({
				subject: "alice",
				isolationClass: "production",
				now: c.at(200),
			}),
		).toBeNull();
		expect(
			svc.allows({
				subject: "alice",
				isolationClass: "production",
				now: c.at(50),
			}),
		).not.toBeNull();
	});

	test("allows refuses a grant that has been reviewed", () => {
		const c = clock();
		const { svc, id } = grantedWith(c);
		svc.markReviewed({ grantId: id, reviewer: "carol" });
		expect(
			svc.allows({ subject: "alice", isolationClass: "production" }),
		).toBeNull();
	});
});

describe("break-glass: review", () => {
	test("reviewing moves the grant to reviewed and emits", () => {
		const svc = breakGlass();
		const grant = svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		svc.approve({ grantId: grant.id, approver: "bob" });
		const reviewed = svc.markReviewed({
			grantId: grant.id,
			reviewer: "carol",
			notes: "root cause identified",
		});
		expect(reviewed.status).toBe("reviewed");
		const event = svc.events.find(
			(e) => e.type === ACCESS_EVENTS.BreakGlassReviewed,
		);
		expect(event?.actor).toBe("carol");
		expect(event?.data.notes).toBe("root cause identified");
	});

	test("notes are omitted rather than stored undefined", () => {
		const svc = breakGlass();
		const grant = svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		svc.markReviewed({ grantId: grant.id, reviewer: "carol" });
		const event = svc.events.find(
			(e) => e.type === ACCESS_EVENTS.BreakGlassReviewed,
		);
		expect(event && "notes" in (event.data as object)).toBe(false);
	});

	test("reviewing an unknown grant is refused", () => {
		expect(
			codeOf(() =>
				breakGlass().markReviewed({ grantId: "bg_999", reviewer: "carol" }),
			),
		).toBe("break-glass-missing");
	});

	test("a request may be reviewed without ever having been approved", () => {
		const svc = breakGlass();
		const grant = svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		expect(
			svc.markReviewed({ grantId: grant.id, reviewer: "carol" }).status,
		).toBe("reviewed");
	});

	test("the reviewed record keeps the original reason and approvers", () => {
		const svc = breakGlass();
		const grant = svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "outage",
			requester: "alice",
		});
		svc.approve({ grantId: grant.id, approver: "bob" });
		const reviewed = svc.markReviewed({
			grantId: grant.id,
			reviewer: "carol",
		});
		expect(reviewed.reason).toBe("outage");
		expect(reviewed.approvers).toEqual(["bob"]);
	});
});

describe("both stores are tenant-scoped and clock-injected", () => {
	test("cross-env events carry the tenant", () => {
		const store = new CrossEnvGrantStore({ tenant: "tenant-z", now: () => T0 });
		store.issue({
			fromClass: "development",
			toClass: "staging",
			reason: "r",
			issuedBy: "alice",
		});
		expect(store.events[0]?.tenant).toBe("tenant-z");
	});

	test("break-glass events carry the tenant", () => {
		const svc = new BreakGlassService({ tenant: "tenant-z", now: () => T0 });
		svc.request({
			subject: "alice",
			isolationClass: "production",
			reason: "r",
			requester: "alice",
		});
		expect(svc.events[0]?.tenant).toBe("tenant-z");
	});

	test("the injected clock stamps issue and request times", () => {
		const store = crossEnvStore(() => "2026-06-06T00:00:00.000Z");
		expect(
			store.issue({
				fromClass: "development",
				toClass: "staging",
				reason: "r",
				issuedBy: "alice",
			}).issuedAt,
		).toBe("2026-06-06T00:00:00.000Z");

		const svc = breakGlass(() => "2026-06-06T00:00:00.000Z");
		expect(
			svc.request({
				subject: "alice",
				isolationClass: "production",
				reason: "r",
				requester: "alice",
			}).requestedAt,
		).toBe("2026-06-06T00:00:00.000Z");
	});
});
