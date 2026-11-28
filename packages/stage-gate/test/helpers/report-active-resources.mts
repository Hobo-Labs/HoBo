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
