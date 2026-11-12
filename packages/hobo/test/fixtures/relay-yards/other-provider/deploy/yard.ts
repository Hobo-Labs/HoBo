// A Yard on another provider: the provider is named here, never in the Bindle.
import { camp } from "@hobo/camps";
import { yard } from "@hobo/yards";

export default yard("relay-fixture", {
	provider: "netlify",
	properties: { project: "relay-fixture", repository: "example/hobo" },
	camps: [camp("preview", { envType: "preview" })],
});
