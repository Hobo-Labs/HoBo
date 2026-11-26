import { bench, describe } from "vitest";
import { convexImpedanceFindings } from "@hobo/provider-convex";

import {
	parseDeployReceipt,
	parseImpedanceRecords,
	parseShipPreflight,
} from "../src/index.ts";

describe("convex impedance", () => {
	bench("findings for document paradigm", () => {
		convexImpedanceFindings({ paradigm: "document", features: ["replay"] });
	});

	bench("parse findings into refined records", () => {
		parseImpedanceRecords([
			...convexImpedanceFindings({
				paradigm: "relational",
				features: ["replay", "wit"],
			}),
		]);
	});
});

// The parse boundary sits on every ship, so its cost is part of the deploy
// path's cost — measure it rather than assume it is free.
describe("parse boundary", () => {
	const response = Object.freeze({
		ok: true as const,
		deploymentUrl: "https://swaghaus.convex.cloud",
		deploymentName: "swaghaus",
		mocked: false,
		mode: "cloud" as const,
	});

	bench("parse a cloud deploy receipt", () => {
		parseDeployReceipt(response);
	});

	bench("fold a preflight", () => {
		parseShipPreflight({
			missing: ["VITE_WORKOS_CLIENT_ID"],
			remediation: "route WorkOS AuthKit env through a Camp secretRef",
			mode: "cloud",
		});
	});
});
