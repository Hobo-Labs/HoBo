/**
 * The junction agent on the fleet device agent (L14, ledger §8.3): it
 * enrolls with role `JUNCTION`, joins the overlay with the single-use
 * `OverlayJoin` the authority returned (never a configured key), and only
 * then runs the device agent with the overlay transport.
 */
import {
	type OverlayJoinOptions,
	type OverlayJoinResult,
	type OverlayNetwork,
	parseTenantId,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createJunctionAgent } from "../src/index.js";
import {
	enrollmentRequest,
	fleetDouble,
	overlayJoin,
	Role,
} from "./support/fleet-agent.js";

function recordingOverlay(
	ready = true,
	provider: OverlayNetwork["provider"] = "tailscale",
) {
	const joins: OverlayJoinOptions[] = [];
	let left = 0;
	const overlay: OverlayNetwork = {
		provider,
		async join(options): Promise<OverlayJoinResult> {
			joins.push(options);
			return {
				identity: {
					nodeId: "node-1",
					hostname: options.hostname,
					overlayIps: ready ? ["100.64.0.7"] : [],
					tags: [...options.tags],
					tenantId: parseTenantId("acme"),
				},
				provider,
				ready,
				notes: ready ? [] : ["tailscale not installed"],
			};
		},
		status: async () => null,
		async leave() {
			left += 1;
		},
		tenantTags: ({ tenantId, role }) => [`tenant:${tenantId}`, `role:${role}`],
	};
	return { overlay, joins, left: () => left };
}

const config = {
	tenantId: "acme",
	name: "junction-aws-1",
	env: "development",
} as const;

describe("createJunctionAgent on the fleet device agent", () => {
	it("enrolls as JUNCTION, joins with the authority's credential, then runs with the overlay transport", async () => {
		const { overlay, joins } = recordingOverlay();
		const double = fleetDouble({
			enrollment: enrollmentRequest([Role.OBSERVER]),
			joins: [
				overlayJoin("netbird", "nb-one-off"),
				overlayJoin("tailscale", "tskey-one-off"),
			],
		});
		const agent = createJunctionAgent({
			config,
			overlay,
			fleet: double.fleet,
		});

		const started = await agent.start();

		expect(started.ready).toBe(true);
		expect(started.overlayIps).toEqual(["100.64.0.7"]);
		expect(double.calls.map((call) => call.kind)).toEqual([
			"agent",
			"enroll",
			"agent",
			"start",
		]);
		const [enrollAgent, enroll, runAgent] = double.calls;
		expect(enrollAgent?.kind === "agent" && enrollAgent.transports).toEqual([]);
		expect(enroll?.kind === "enroll" && enroll.request.requestedRoles).toEqual([
			Role.OBSERVER,
			Role.JUNCTION,
		]);
		expect(joins).toHaveLength(1);
		expect(joins[0]?.authKey).toBe("tskey-one-off");
		expect(
			runAgent?.kind === "agent" &&
				runAgent.transports.map((transport) => transport.kind),
		).toEqual(["overlay"]);
		expect((await agent.status()).running).toBe(true);
		expect((await agent.status()).member).toBeUndefined();

		await agent.stop();
		expect(double.calls.at(-1)?.kind).toBe("stop");
	});

	it("keeps the requested roles when JUNCTION is already there", async () => {
		const double = fleetDouble({
			enrollment: enrollmentRequest([Role.JUNCTION]),
		});
		await createJunctionAgent({
			config,
			overlay: recordingOverlay().overlay,
			fleet: double.fleet,
		}).start();
		const enroll = double.calls.find((call) => call.kind === "enroll");
		expect(enroll?.kind === "enroll" && enroll.request.requestedRoles).toEqual([
			Role.JUNCTION,
		]);
	});

	it("joins without a credential when the authority minted none for this provider, or it expired", async () => {
		const { overlay, joins } = recordingOverlay();
		const double = fleetDouble({
			enrollment: enrollmentRequest(),
			joins: [
				overlayJoin("netbird", "nb-one-off"),
				overlayJoin("tailscale", "expired", "2020-01-01T00:00:00Z"),
			],
		});
		await createJunctionAgent({ config, overlay, fleet: double.fleet }).start();
		expect(joins[0]).not.toHaveProperty("authKey");
	});

	it("does not join the overlay when enrollment fails", async () => {
		const { overlay, joins } = recordingOverlay();
		const double = fleetDouble({
			enrollment: enrollmentRequest(),
			enrollFails: true,
		});
		const started = await createJunctionAgent({
			config,
			overlay,
			fleet: double.fleet,
		}).start();
		expect(started.ready).toBe(false);
		expect(started.notes.join(" ")).toMatch(
			/enrollment failed \(token-invalid\)/u,
		);
		expect(joins).toHaveLength(0);
		expect(double.calls.map((call) => call.kind)).toEqual(["agent", "enroll"]);
	});

	it("an already enrolled junction does not enroll again", async () => {
		const { overlay, joins } = recordingOverlay();
		const double = fleetDouble();
		const started = await createJunctionAgent({
			config,
			overlay,
			fleet: double.fleet,
		}).start();
		expect(started.ready).toBe(true);
		expect(joins[0]).not.toHaveProperty("authKey");
		expect(double.calls.map((call) => call.kind)).toEqual(["agent", "start"]);
	});

	it("runs no device agent while the overlay is not joined", async () => {
		const { overlay } = recordingOverlay(false);
		const double = fleetDouble();
		const agent = createJunctionAgent({ config, overlay, fleet: double.fleet });
		const started = await agent.start();
		expect(started.ready).toBe(false);
		expect(double.calls).toHaveLength(0);
		await agent.stop();
		expect(double.calls).toHaveLength(0);
	});

	it("reports a device agent that does not start, and stays joined", async () => {
		const { overlay } = recordingOverlay();
		const double = fleetDouble({ startFails: true });
		const started = await createJunctionAgent({
			config,
			overlay,
			fleet: double.fleet,
		}).start();
		expect(started.ready).toBe(true);
		expect(started.notes.join(" ")).toMatch(/did not start: no authority/u);
	});

	it("checks the environment before enrolling", async () => {
		const double = fleetDouble({ enrollment: enrollmentRequest() });
		const started = await createJunctionAgent({
			config: { tenantId: "acme", name: "j" },
			overlay: recordingOverlay().overlay,
			fleet: double.fleet,
		}).start();
		expect(started.ready).toBe(false);
		expect(double.calls).toHaveLength(0);
	});
});
