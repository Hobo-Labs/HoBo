import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratch } from "./pins-support.ts";

const dir = scratch("probe");
writeFileSync(join(dir, "file"), "x");
console.log(dir);
