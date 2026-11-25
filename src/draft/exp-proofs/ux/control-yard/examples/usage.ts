/**
 * Runnable example for control-yard. Gate executes with node --import tsx
 * and diffs stdout against usage.expected.txt.
 */
import { strict as assert } from "node:assert";

import {
	assertYardZones,
	controlYardAcceptance,
	REQUIRED_ZONES,
} from "../src/control-yard.js";

const acceptance = controlYardAcceptance();
assert.equal(acceptance.adr, "ADR-0135");
assert.equal(acceptance.proof, "control-yard");
assert.equal(assertYardZones(REQUIRED_ZONES).ok, true);
assert.equal(acceptance.boWestIsNotMirror, true);
assert.equal(acceptance.noSecondLifecycle, true);

console.log(
	[
		"control-yard ok",
		`adr=${acceptance.adr}`,
		`zones=${acceptance.zones.length}`,
		`packages=${acceptance.packages.join(",")}`,
		"boWestIsNotMirror=true",
		"noSecondLifecycle=true",
	].join("\n"),
);
