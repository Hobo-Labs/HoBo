import { bench, describe } from "vitest";

import {
	createAdoptionGraph,
	createFixtureIacState,
	detectAdoptedDrift,
	graphDigest,
	importIacState,
	planReconcile,
} from "../src/adopt-in-place-contract.ts";

const source = { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" };
const { graph } = importIacState({
	graph: createAdoptionGraph(),
	state: createFixtureIacState(),
	source,
});

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("adopt-in-place hot path", () => {
	bench("importIacState over fixture state", () => {
		importIacState({ graph: createAdoptionGraph(), state: createFixtureIacState(), source });
	});

	bench("planReconcile + detectAdoptedDrift on adopted graph", () => {
		planReconcile({ graph });
		detectAdoptedDrift({
			graph,
			observedOutputs: {
				"legacy-db": {
					endpoint: "postgres://moved-db.internal:5432/shop",
					passwordRef: "secret://legacy-db/password",
				},
			},
		});
	});

	bench("graphDigest (canonical graph hash)", () => {
		graphDigest(graph);
	});
});
