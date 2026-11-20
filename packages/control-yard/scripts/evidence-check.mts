import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvidence } from "./evidence-validator.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.argv[2]
	? resolve(process.argv[2])
	: join(root, "public", "shots");
const lock = join(root, "public", "shots", ".capture-lock");
const checkout = resolve(root, "../..");
const rel = relative(checkout, shots);
const inCheckout =
	rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
const errors = validateEvidence(
	shots,
	lock,
	undefined,
	inCheckout ? checkout : undefined,
);
if (errors > 0) {
	console.error(`\nevidence:check failed (${errors} error(s))`);
	process.exitCode = 1;
} else {
	console.log("\nevidence:check passed");
}
