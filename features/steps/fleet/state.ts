import { After, Before, setDefaultTimeout } from "@cucumber/cucumber";
import { createFleetWorld, type Enrolled, type FleetWorld, type Signer } from "../../../packages/fleet-authority/acceptance/index.js";

setDefaultTimeout(60_000);

export type FleetScenario = {
	world: FleetWorld | undefined;
	device: Enrolled | undefined;
	devices: Map<string, Enrolled>;
	refusal: string | undefined;
	retiredSign: Signer | undefined;
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
