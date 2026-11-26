// A preload for a check under test, so a test can see what still keeps the check's process alive
// without measuring how long it takes to exit:
//
//   node --import tsx --import report-active-resources.mts <script> ...
//
// Once the process has written a line containing "outcome" to stdout (the check's evidence line,
// its last act), the types of the resources that still keep its event loop alive go to
// $ACTIVE_RESOURCES_FILE as a JSON array. A "Timeout" in it is a timer left armed, however long it is.
import { writeFileSync } from "node:fs";

const file = process.env.ACTIVE_RESOURCES_FILE ?? "";
const write = process.stdout.write.bind(process.stdout);
let reported = false;

// SAFETY: a wrapper with write's own signature; every argument goes through to it unchanged.
process.stdout.write = ((...args: Parameters<typeof write>) => {
	const written = write(...args);
	if (!reported && String(args[0]).includes('"outcome"')) {
		reported = true;
		setImmediate(() => {
			writeFileSync(file, JSON.stringify(process.getActiveResourcesInfo()));
		});
	}
	return written;
}) as typeof process.stdout.write;
