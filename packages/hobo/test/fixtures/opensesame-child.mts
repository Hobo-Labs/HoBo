// The command a proxied run starts in credentials-opensesame.test.ts: records
// the environment it was given and exits with the status it was told.
//   node opensesame-child.mts <out file> [exit status]
import { writeFileSync } from "node:fs";

const [out, status] = process.argv.slice(2);
if (out !== undefined) writeFileSync(out, JSON.stringify({ env: process.env }));
process.exit(Number(status ?? "0"));
