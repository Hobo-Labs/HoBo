import { camp, campToContract } from "@hobo/camps";
import { expect, it } from "vitest";
import { yard, yardToContract } from "../src/index.js";

it("projects an attached Camp through the shared planning contract", () => {
	const deploymentYard = yard("east", {
		provider: "example",
		camps: [
			camp("prod", {
				logicalId: "store/production",
				envType: "production",
				require: ["managed"],
				prefer: ["nearby"],
				labels: { region: "east" },
				runtimeRequirements: ["component"],
			}),
		],
	});
	const attached = deploymentYard.camps[0];
	if (!attached) throw new Error("attached Camp missing");
	const contract = campToContract(attached);
	expect(contract).toEqual({
		id: "prod",
		logicalId: "store/production",
		env: "prod",
		envType: "production",
		require: ["managed"],
		prefer: ["nearby"],
		labels: { region: "east" },
		runtimeRequirements: ["component"],
	});
	expect(yardToContract(deploymentYard).camps).toEqual([contract]);
	expect(Object.isFrozen(contract)).toBe(true);
});
