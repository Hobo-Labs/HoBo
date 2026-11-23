import { camp } from "@hobo/camps";
import { yard } from "@hobo/yards";

export const topology = yard("{{name}}-yard", {
	provider: "{{provider}}",
	network: [
		"{{network}}",
	],
	camps: [
		camp("{{campName}}"),
	],
});
