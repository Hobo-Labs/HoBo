/**
 * Shared state of the HoBo Fleet behaviour steps (ADR-0183; design §11.4
 * L26). Every `@fleet` scenario gets a fresh acceptance world on the
 * in-memory bus: the real authority (`assembleAuthority` behind
 * `createAuthorityHandler`), the real audit chain and witness, and device
 * agents built by `createFleetAgent` with the fake sandbox driver. Nothing
 * here decides anything; the steps drive the shipped code and assert on what
 * it answers. The world is stopped after each scenario.
 */
import { After, Before, setDefaultTimeout } from "@cucumber/cucumber";
import { createFleetWorld, type Enrolled, type FleetWorld, type Signer } from "../../../packages/fleet-authority/acceptance/index.js";

setDefaultTimeout(60_000);

export type FleetScenario = {
	world: FleetWorld | undefined;
	/** The device the scenario is about. */
	device: Enrolled | undefined;
	/** Named devices, for scenarios with several. */
	devices: Map<string, Enrolled>;
	/** What the last refused call answered, as its error code. */
	refusal: string | undefined;
	/** A SIGN key the device has rotated away from. */
	retiredSign: Signer | undefined;
	/** Free-form values a scenario carries between its steps. */
	notes: Map<string, string>;
};

export const fleet: FleetScenario = {
	world: undefined,
	device: undefined,
	devices: new Map(),
	refusal: undefined,
	retiredSign: undefined,
	notes: new Map(),
};

export function world(): FleetWorld {
	if (fleet.world === undefined) throw new Error("no fleet world: the scenario needs 'a fleet authority on the in-memory bus'");
	return fleet.world;
}

export function device(): Enrolled {
	if (fleet.device === undefined) throw new Error("no device has enrolled in this scenario");
	return fleet.device;
}

export async function startWorld(): Promise<FleetWorld> {
	fleet.world = await createFleetWorld();
	return fleet.world;
}

Before({ tags: "@fleet" }, () => {
	fleet.world = undefined;
	fleet.device = undefined;
	fleet.devices = new Map();
	fleet.refusal = undefined;
	fleet.retiredSign = undefined;
	fleet.notes = new Map();
});

After({ tags: "@fleet" }, async () => {
	await fleet.world?.stop();
	fleet.world = undefined;
});
