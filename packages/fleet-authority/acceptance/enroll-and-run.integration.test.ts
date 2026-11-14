/**
 * O2, "A developer enrolls and runs their own job" (design §10.1), the
 * integration half: a real `nats-server` (operator mode, JetStream, TLS, the
 * auth callout), the authority composed by `assembleAuthority` and served by
 * `createAuthorityHandler`, a device agent connecting to the bus as itself,
 * and the real `S1` sandbox driver from `@hobo/fleet-agent` running the
 * developer's `oci-command` job in the pinned busybox image.
 *
 * Both enrollment flows end in a `SUCCEEDED` receipt from the enrolled
 * device: a single-use bootstrap token, and the developer's browser approval
 * (a sign-in whose DPoP key is the device's identity key).
 *
 * Nothing here skips: O2 takes no fallback. Without `nats-server`
 * (`HOBO_FLEET_NATS_SERVER_BIN` or on PATH), or without an `S1` driver whose
 * self-test passes (D58: the agent provisions gVisor `runsc` itself), the
 * suite fails and says which.
 */
import {
	DeviceClass,
	type FleetLog,
	ReceiptStatus,
	Role,
	type SandboxDriver,
	SandboxTier,
} from "@hobo/fleet";
import { createEgressProxyFactory, sandboxDrivers } from "@hobo/fleet-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	browserApproval,
	enrollDevice,
	finalReceipt,
	submitJob,
	watchReceipts,
} from "./flows.js";
import { NATS_BINARY, natsBusProvider } from "./nats.js";
import { createFleetWorld, type FleetWorld } from "./world.js";

const unavailable: string[] = [];
const log: FleetLog = (event, fields) => {
	if (event === "hobo_fleet_sandbox_unavailable")
		unavailable.push(`${fields.tier} ${fields.runtime}: ${fields.reason}`);
};

let s1: SandboxDriver | undefined;
let world: FleetWorld | undefined;

beforeAll(async () => {
	const drivers = await sandboxDrivers({ cap: SandboxTier.S1_CONTAINER, log });
	s1 = drivers.find((driver) => driver.tier === SandboxTier.S1_CONTAINER);
}, 300_000);

afterEach(async () => {
	await world?.stop();
	world = undefined;
}, 60_000);

const BOTH = [Role.DISPATCHER, Role.EXECUTOR];

async function runOwnJob(flow: "token" | "browser") {
	expect(
		NATS_BINARY,
		"nats-server is not available: set HOBO_FLEET_NATS_SERVER_BIN or put nats-server on PATH",
	).not.toBe("");
	expect(
		s1,
		`no S1 sandbox driver passed its self-test:\n${unavailable.join("\n")}`,
	).toBeDefined();
	const sandbox = s1;
	if (sandbox === undefined) return;
	world = await createFleetWorld({ bus: natsBusProvider });
	const w = world;
	await w.defineFleet("laptops", "dev", { workKinds: ["oci-command"] });
	const token = flow === "token" ? await w.token("laptops", "box", BOTH) : "";
	const device = await enrollDevice(w, {
		fleet: "laptops",
		name: flow === "token" ? "box" : "laptop",
		roles: BOTH,
		deviceClass:
			flow === "token" ? DeviceClass.DEDICATED : DeviceClass.PERSONAL,
		sandboxes: [sandbox],
		egress: createEgressProxyFactory({ fleetAllow: () => [], log }),
		proof:
			flow === "token"
				? async () => ({ case: "bootstrapToken", value: token })
				: (keys) => browserApproval(w, "dev", keys),
	});
	expect(device.response.ok ? "ok" : device.response.error.message).toBe("ok");
	const receipts = watchReceipts(w);
	await device.agent.start();
	expect(device.agent.status().bus).toBe("connected");
	const submitted = await submitJob(w, "dev", "laptops", [
		"echo",
		"hello from the fleet",
	]);
	const receipt = await finalReceipt(receipts, submitted, 150_000);
	const self = await device.keys.open();
	expect({
		status: ReceiptStatus[receipt.status],
		reason: receipt.reason,
	}).toEqual({ status: "SUCCEEDED", reason: "" });
	expect(receipt.memberId).toBe(self.memberId);
	expect(receipt.sandboxTier).toBe(SandboxTier.S1_CONTAINER);
	expect(receipt.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
}

describe("O2: a developer enrolls a device and runs their own job (nats-server, the authority, the real S1 driver)", () => {
	it("the bootstrap-token flow reaches a SUCCEEDED receipt", async () => {
		await runOwnJob("token");
	}, 240_000);

	it("the browser-approval flow reaches a SUCCEEDED receipt", async () => {
		await runOwnJob("browser");
	}, 240_000);
});
