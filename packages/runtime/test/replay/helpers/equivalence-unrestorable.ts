import { assertReplayEqualsLive } from "../../../src/replay/equivalence.js";

const originalClock = Date.now;
try {
	assertReplayEqualsLive({
		events: [
			{ id: "one", streamId: "stream", seq: 1, type: "value", data: null },
		],
		initialState: null,
		fold: () => {
			Object.defineProperty(Math, "random", {
				value: () => 1,
				writable: false,
				configurable: false,
			});
			throw new Error("fold failed");
		},
	});
} catch {
	// This process deliberately makes the random intrinsic impossible to restore.
}
if (Date.now !== originalClock) {
	process.stderr.write(
		"clock was not restored after random restoration failed\n",
	);
	process.exitCode = 1;
}
