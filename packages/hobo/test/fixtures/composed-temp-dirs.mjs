// Composes what the composed binaries compose, as they do (signal handlers
// asked for first), and selects the live Pulumi lane over it, then ends the way
// it is told:
//   node composed-temp-dirs.mjs <normal|throw|wait> <report file> <data dir|default>
// It loads the built composition (`dist`, which turbo builds before `test`):
// what is checked is the directories, not how TypeScript is loaded, and a
// loader would compile the composition again in every child.
// With `default` the runtime makes its own event-store directory. The live lane
// is pointed at a pulumi that is not there: it is built, never run. It is given
// this process's HOBO_PULUMI_WORKDIR, when there is one. Once the lane is built,
// the report file lists the `hobo-pulumi-live-*` directories in TMPDIR (JSON),
// and its presence tells the test the process is ready for a signal.
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createDefaultYardRuntime,
	selectPulumiEstateAdapter,
} from "../../dist/compose.js";
import { removeOwnedDirsOnSignals } from "../../dist/owned-temp-dir.js";

const [mode, report, dataDir] = process.argv.slice(2);
// As the bins do before they compose.
removeOwnedDirsOnSignals();
const runtime = createDefaultYardRuntime(
	dataDir === undefined || dataDir === "default" ? {} : { dataDir },
);
const lane = {
	HOBO_PULUMI_LIVE: "1",
	HOBO_PULUMI_BIN: join(tmpdir(), "no-pulumi"),
};
const workDir = process.env.HOBO_PULUMI_WORKDIR;
selectPulumiEstateAdapter({
	store: runtime.store,
	env: workDir === undefined ? lane : { ...lane, HOBO_PULUMI_WORKDIR: workDir },
});
if (report !== undefined) {
	const made = readdirSync(tmpdir()).filter((name) =>
		name.startsWith("hobo-pulumi-live-"),
	);
	writeFileSync(report, JSON.stringify(made));
}

if (mode === "throw") throw new Error("the composed run failed");
if (mode === "wait") setInterval(() => {}, 1000);
