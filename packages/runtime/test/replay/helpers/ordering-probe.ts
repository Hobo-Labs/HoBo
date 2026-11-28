import { digest } from "../../../src/replay/divergence.js";
import {
	compareCanonicalEventOrder,
	stableStringify,
} from "../../../src/replay/equivalence.js";

const state = { ä: 2, z: 3, a: 1 };
const events = ["z", "ä", "a"].map((streamId) => ({
	id: streamId,
	streamId,
	seq: 1,
	type: "value",
	data: null,
}));
process.stdout.write(
	JSON.stringify({
		canonical: stableStringify(state),
		digest: digest(state),
		order: [...events]
			.sort(compareCanonicalEventOrder)
			.map((event) => event.streamId),
	}),
);
