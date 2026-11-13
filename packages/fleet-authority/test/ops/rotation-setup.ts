// A deployment after the ceremony and provisioning, a device refreshing every
// simulated second, and the rotation's dependencies, for the rotation tests.
import { setImmediate as yieldToTimers } from "node:timers/promises";
import { createMemoryEventStore } from "@hobo/fleet/testing";
import type { SecretsPort } from "@hobo/identity";
import { type RotatableKey, runCeremony } from "../../src/ops/index.js";
import type { Reached, RotationDeps } from "../../src/ops/rotation.js";
import { changeTrust, nextTrustRecord } from "../../src/ops/trust.js";
import { device, natsDouble } from "./device.js";
import { deployment, provisionNatsSlots } from "./harness.js";
import { opsFixture } from "./support.js";

export const ALL_KEYS: readonly RotatableKey[] = [
	"operator-signing",
	"account-signing",
	"scoped-observer",
	"scoped-executor",
	"scoped-dispatcher",
	"token-signing",
	"record-signing",
	"witness",
];

export async function rotationSetup(
	options: Readonly<{ secrets?: (inner: SecretsPort) => SecretsPort }> = {},
) {
	// Real time: @hobo/identity's ring judges a retired key's lifetime by Date.now().
	const fixture = await opsFixture({}, Date.now());
	const ran = await runCeremony(fixture.context);
	if (!ran.ok) throw new Error(ran.error.message);
	await provisionNatsSlots(fixture.secrets, fixture.prefix);
	const store = createMemoryEventStore();
	const dep = await deployment({
		secrets: fixture.secrets,
		prefix: fixture.prefix,
		store,
		now: fixture.clock.now,
	});
	const nats = await natsDouble(fixture.secrets, fixture.prefix);
	const dev = device(
		dep,
		fixture.secrets,
		fixture.prefix,
		nats,
		fixture.clock.now,
	);
	const secrets = options.secrets?.(fixture.secrets) ?? fixture.secrets;
	const deps = (witnessTimeoutMs = 10_000): RotationDeps => ({
		secrets,
		prefix: fixture.prefix,
		trust: dep.trustDeps(witnessTimeoutMs),
		nats: nats.port,
		now: fixture.clock.now,
		log: () => {},
	});
	return { fixture, store, dep, nats, dev, deps };
}

export type RotationSetup = Awaited<ReturnType<typeof rotationSetup>>;

/**
 * Runs `rotate` to "done" while the device refreshes once per simulated
 * second; between calls that stop early (waiting out the grace period), 60
 * simulated seconds pass. Returns every `reached` the calls answered.
 */
export async function rotateWhileRefreshing(
	setup: RotationSetup,
	which: RotatableKey,
	rotateOnce: () => Promise<Reached>,
): Promise<Reached[]> {
	const reached: Reached[] = [];
	let finished = false;
	let waiter: { at: number; resolve: () => void } | undefined;
	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			waiter = { at: setup.fixture.clock.now() + ms, resolve };
		});
	const rotation = (async () => {
		try {
			for (;;) {
				const step = await rotateOnce();
				reached.push(step);
				if (step === "done") return;
				await sleep(60_000);
			}
		} finally {
			finished = true;
		}
	})();
	while (!finished) {
		setup.fixture.clock.advance(1_000);
		// The witness process signs with its slot's active key, as after a restart.
		await setup.dep.witnessKey.refresh();
		await setup.dev.refresh(which);
		await setup.dep.tickAudit();
		if (waiter !== undefined && setup.fixture.clock.now() >= waiter.at) {
			const ready = waiter;
			waiter = undefined;
			ready.resolve();
		}
		await yieldToTimers();
	}
	await rotation;
	await setup.dep.witnessKey.refresh();
	await setup.dep.record.refresh();
	// The system still works: one more trust change, then a minute of refreshes.
	const pinned = setup.dep.bus.registry.trust();
	const changed = await changeTrust(setup.dep.trustDeps(), {
		payload: nextTrustRecord(pinned, setup.fixture.clock.now(), {}),
		signer: setup.dep.record.signer,
		reason: "test:after-rotation",
	});
	if (!changed.ok) throw new Error(`after rotation: ${changed.error.message}`);
	for (let i = 0; i < 60; i += 1) {
		setup.fixture.clock.advance(1_000);
		await setup.dev.refresh(which);
	}
	if (setup.dev.pinned().sequence !== pinned.sequence + 1)
		throw new Error(
			"the device did not follow the trust change after the rotation",
		);
	return reached;
}
