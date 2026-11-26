/**
 * Child of pins-hygiene.test.ts: makes a scratch directory with a file in it,
 * prints its path and exits normally, so the test can look at what is left.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratch } from "./pins-support.ts";

const dir = scratch("probe");
writeFileSync(join(dir, "file"), "x");
console.log(dir);
