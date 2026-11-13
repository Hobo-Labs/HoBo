import { create } from "@bufbuild/protobuf";
import {
	MemberRecordSchema,
	MemberState,
	MembershipSchema,
	Role,
} from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	expandTemplate,
	STATIC_USERS,
	staticUserPermissions,
	TEMPLATES,
	templateFor,
} from "../src/bus/templates.js";
import { matches } from "./support/memory-wire.js";

const ME = `dev_${"a".repeat(32)}`;
const OTHER = `dev_${"b".repeat(32)}`;

const record = (roles: Role[][], state = MemberState.ACTIVE) =>
	create(MemberRecordSchema, {
		memberId: ME,
		state,
		memberships: roles.map((fleetRoles, index) =>
			create(MembershipSchema, { fleet: `f${index}`, roles: fleetRoles }),
		),
	});

const allowed = (list: readonly string[], subject: string) =>
	list.some((filter) => matches(filter, subject));

describe("permission templates (§6.7)", () => {
	it("lists exactly the observer subjects of §6.7", () => {
		expect(TEMPLATES.observer.publish).toEqual([
			"$KV.fleet-observations.{{name()}}.*",
			"fleet.event.{{name()}}.>",
			"$JS.API.INFO",
			"$JS.API.STREAM.INFO.KV_fleet-registry",
			"$JS.API.STREAM.INFO.KV_fleet-views",
			"$JS.API.STREAM.INFO.KV_fleet-observations",
			"$JS.API.DIRECT.GET.KV_fleet-registry.>",
			"$JS.API.DIRECT.GET.KV_fleet-views.>",
			"$JS.API.DIRECT.GET.KV_fleet-observations.>",
			"$JS.API.CONSUMER.CREATE.KV_fleet-registry.{{name()}}.>",
			"$JS.API.CONSUMER.CREATE.KV_fleet-observations.{{name()}}.>",
			"$JS.API.CONSUMER.CREATE.FLEET_CONTROL.{{name()}}.fleet.control.{{name()}}",
			"$JS.API.CONSUMER.MSG.NEXT.*.{{name()}}",
			"$JS.API.CONSUMER.INFO.*.{{name()}}",
			"$JS.API.CONSUMER.DELETE.*.{{name()}}",
		]);
		expect(TEMPLATES.observer.subscribe).toEqual(["_INBOX.{{name()}}.>"]);
	});

	it("builds each template on the one below it", () => {
		for (const subject of TEMPLATES.observer.publish)
			expect(TEMPLATES.executor.publish).toContain(subject);
		for (const subject of TEMPLATES.executor.publish)
			expect(TEMPLATES.dispatcher.publish).toContain(subject);
		expect(TEMPLATES.executor.subscribe).toContain("fleet.relay.{{name()}}.>");
		expect(TEMPLATES.dispatcher.publish).toContain(
			"$JS.API.STREAM.MSG.DELETE.FLEET_CLAIMS",
		);
	});

	it("never grants the whole JetStream API or another member's subjects", () => {
		for (const template of ["observer", "executor", "dispatcher"] as const) {
			const mine = expandTemplate(template, ME);
			for (const subject of [...mine.publish, ...mine.subscribe]) {
				expect(subject).not.toBe("$JS.API.>");
				expect(subject).not.toContain("{{");
			}
			expect(
				allowed(mine.publish, `$KV.fleet-observations.${OTHER}.${ME}`),
			).toBe(false);
			expect(
				allowed(mine.publish, `$KV.fleet-observations.${ME}.${OTHER}`),
			).toBe(true);
			expect(allowed(mine.publish, `fleet.event.${OTHER}.receipt`)).toBe(false);
			expect(
				allowed(mine.publish, `$JS.API.CONSUMER.DELETE.FLEET_ORDERS.${OTHER}`),
			).toBe(false);
			expect(
				allowed(
					mine.publish,
					`$JS.API.CONSUMER.MSG.NEXT.FLEET_ORDERS.${OTHER}`,
				),
			).toBe(false);
			expect(allowed(mine.publish, "$KV.fleet-registry.trust")).toBe(false);
			expect(allowed(mine.publish, "$JS.API.STREAM.PURGE.FLEET_CLAIMS")).toBe(
				false,
			);
			expect(allowed(mine.publish, "$JS.API.STREAM.DELETE.FLEET_EVENTS")).toBe(
				false,
			);
			expect(allowed(mine.subscribe, `fleet.relay.${OTHER}.s1`)).toBe(false);
			expect(allowed(mine.subscribe, `_INBOX.${OTHER}.x`)).toBe(false);
		}
		const executor = expandTemplate("executor", ME);
		expect(
			allowed(
				executor.publish,
				`$JS.API.CONSUMER.CREATE.FLEET_ORDERS.${ME}.fleet.order.${OTHER}`,
			),
		).toBe(false);
		expect(
			allowed(executor.publish, "$JS.API.STREAM.MSG.DELETE.FLEET_CLAIMS"),
		).toBe(false);
		expect(allowed(executor.publish, "fleet.offer.f1")).toBe(false);
	});

	it("picks the highest template any membership grants", () => {
		expect(templateFor(record([[Role.OBSERVER], [Role.DISPATCHER]]))).toBe(
			"dispatcher",
		);
		expect(templateFor(record([[Role.EXECUTOR, Role.OBSERVER]]))).toBe(
			"executor",
		);
		expect(templateFor(record([[Role.RECONCILER]]))).toBe("observer");
		expect(templateFor(record([[Role.JUNCTION]]))).toBe("observer");
		expect(templateFor(record([[]]))).toBeUndefined();
		expect(
			templateFor(record([[Role.DISPATCHER]], MemberState.SUSPENDED)),
		).toBeUndefined();
	});
});

describe("static users (§6.7)", () => {
	it("keeps stream administration with the provisioner only", () => {
		for (const user of STATIC_USERS) {
			const permissions = staticUserPermissions(user);
			const creates = allowed(
				permissions.publish,
				"$JS.API.STREAM.CREATE.FLEET_CLAIMS",
			);
			expect(creates).toBe(user === "provisioner");
		}
		const authority = staticUserPermissions("authority");
		expect(authority.denyPublish).toContain("$JS.API.STREAM.PURGE.>");
		expect(authority.subscribe).toContain("$SYS.REQ.USER.AUTH");
		expect(staticUserPermissions("sentinel").denyPublish).toEqual([">"]);
		expect(staticUserPermissions("witness").publish).toContain(
			"fleet.audit.witness",
		);
		expect(
			allowed(staticUserPermissions("witness").publish, "fleet.audit.entry"),
		).toBe(false);
	});
});
