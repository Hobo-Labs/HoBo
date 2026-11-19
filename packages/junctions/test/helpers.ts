import { camp } from "@hobo/camps";
import { type Yard, yard } from "@hobo/yards";

export function makeYard(name: string, providerId: string): Yard {
	const dev = camp("dev", {
		envType: "development",
		require: ["managed-http-runtime"],
		runtimeRequirements: ["local"],
	});
	return yard(name, {
		provider: providerId,
		regions: ["local"],
		camps: [dev],
	});
}
