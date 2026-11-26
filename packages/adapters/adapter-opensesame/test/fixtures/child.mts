// The proxied command in tests: record what it was given, exit as told.
//   node child.mts <out file> [exit code] [file whose text is written to stderr]
import { readFileSync, writeFileSync } from "node:fs";

const [out, code, stderrFile] = process.argv.slice(2);
if (out !== undefined) {
	writeFileSync(
		out,
		JSON.stringify({ env: process.env, argv: process.argv.slice(2) }),
	);
}
if (stderrFile !== undefined) {
	process.stderr.write(readFileSync(stderrFile, "utf8"));
}
process.exit(Number(code ?? 0));
