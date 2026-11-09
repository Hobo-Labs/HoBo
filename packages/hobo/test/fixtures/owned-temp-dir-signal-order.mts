// Asks for the removal on a signal, as an entry point does, for an owner that
// records each signal it is given a handler for, and prints them in order:
//   node --import tsx owned-temp-dir-signal-order.mts
// A process of its own: the handlers are installed in a main thread only.
import { removeOwnedDirsOnSignals } from "../../src/owned-temp-dir.ts";

const handled: string[] = [];
removeOwnedDirsOnSignals({
	pid: process.pid,
	on: () => {},
	prependListener: (signal) => {
		handled.push(signal);
	},
	off: () => {},
	listenerCount: () => 0,
	kill: () => {},
});
process.stdout.write(`${JSON.stringify(handled)}\n`);
