// Makes an owned temp dir (src/owned-temp-dir.ts), says where on stdout, and
// then ends the way it is told:
//   node --import tsx owned-temp-dir.mts <normal|throw|wait|asked-twice|two|graceful|graceful-first|library-emit|entry-emit-hup|worker> <ready file>
// `wait`, `asked-twice`, `two`, `graceful` and `graceful-first` write the ready
// file and wait for a signal; `asked-twice` asks for the signal handlers a
// second time, as a shell's loader may on every command; `two` makes a
// second directory first, as a process holding both a hobo-yard-* store and a
// hobo-pulumi-live-* workspace does; `graceful`
// first installs a SIGTERM handler of its own, as a server's graceful stop does,
// which records whether the directory is still there, then exits 0.
// `graceful-first` installs that handler before the entry point asks for the
// signal handlers, as a shell can have its own before a command first loads
// the composition.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, Worker, workerData } from "node:worker_threads";

import {
	ownedTempDir,
	removeOwnedDirsOnSignals,
} from "../../src/owned-temp-dir.ts";

// `worker`: the entry point's call made from a worker thread, which shares its
// pid with the whole process, then a SIGTERM emitted there with nothing else listening.
if (!isMainThread && workerData === "worker") {
	removeOwnedDirsOnSignals();
	ownedTempDir("hobo-yard-");
	process.emit("SIGTERM");
	process.stdout.write("worker ran\n");
	process.exit(0);
}

const [mode, ready] = process.argv.slice(2);
if (mode === "worker") {
	const worker = new Worker(new URL(import.meta.url), { workerData: "worker" });
	await new Promise((resolve) => worker.once("exit", resolve));
	process.stdout.write("process still running after its worker\n");
	process.exit(0);
}
function stopGracefully(): void {
	process.stdout.write(`dir during stop: ${existsSync(dir)}\n`);
	setTimeout(() => process.exit(0), 50);
}
if (mode === "graceful-first") process.once("SIGTERM", stopGracefully);
// As the bins do; `library-emit` plays a host that composed HoBo and asked for nothing.
if (mode !== "library-emit") removeOwnedDirsOnSignals();
if (mode === "asked-twice") removeOwnedDirsOnSignals();
const dir = ownedTempDir("hobo-yard-");
writeFileSync(join(dir, "eventstore.sqlite"), "");
process.stdout.write(`${dir}\n`);
if (mode === "two")
	process.stdout.write(`${ownedTempDir("hobo-pulumi-live-")}\n`);

if (mode === "library-emit") {
	// No entry-point handlers: a host that emits SIGTERM to its own listeners
	// (a test of its graceful stop, say) and has none yet.
	process.emit("SIGTERM");
	process.stdout.write("host still running\n");
}
if (mode === "entry-emit-hup") {
	// As an entry point does; then a SIGHUP emitted with no signal argument.
	process.emit("SIGHUP");
	setInterval(() => {}, 1000);
}
if (mode === "throw") throw new Error("the composed run failed");
if (mode === "graceful") process.once("SIGTERM", stopGracefully);
if (
	mode === "wait" ||
	mode === "asked-twice" ||
	mode === "two" ||
	mode === "graceful" ||
	mode === "graceful-first"
) {
	setInterval(() => {}, 1000);
	if (ready !== undefined) writeFileSync(ready, "ready");
}
