// Relaunches itself under the OpenSesame stand-in exactly as bin/hobo.ts does
// (relaunchInputFor(process)), and, as the run's command, records the
// environment it was given instead.
//   node [node options] --import tsx relaunch-probe.mts <stand-in> <out file>
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
	OPENSESAME_PASS_ENV,
	relaunchInputFor,
	relaunchUnderOpenSesame,
} from "../../src/credentials-opensesame.ts";

const [standIn, out] = process.argv.slice(2);
if (standIn === undefined || out === undefined) process.exit(2);

if (process.env.HOBO_OPENSESAME_CHILD === "1") {
	writeFileSync(out, JSON.stringify({ env: process.env }));
} else {
	process.exitCode = await relaunchUnderOpenSesame({
		...relaunchInputFor(process),
		bin: standIn,
		passEnv: [...OPENSESAME_PASS_ENV, "FAKE_OPENSESAME_SCENARIO"],
		tmpRoot: dirname(out),
	});
}
