import { camp } from "@hobo/camps";
import { type Yard, yard } from "@hobo/yards";

/** Build a provider-specific Yard with a neutral Camp shape (no Bindle ownership). */
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
