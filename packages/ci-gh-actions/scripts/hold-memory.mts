import process from "node:process";
import { parseArgs } from "node:util";

const USAGE = "usage: hold-memory.mts --mb <megabytes> --seconds <seconds>";
const CHUNK_MB = 64;

function fail(message: string): never {
	console.error(`${message}\n${USAGE}`);
	process.exit(2);
}

function whole(
	value: string | undefined,
	name: string,
	min: number,
	max: number,
) {
	if (value === undefined || !/^\d{1,7}$/u.test(value))
		fail(`--${name} must be a whole number`);
	const parsed = Number(value);
	if (parsed < min || parsed > max)
		fail(`--${name} must be between ${min} and ${max}`);
	return parsed;
}

let values: Record<string, string | undefined>;
try {
	values = parseArgs({
		options: { mb: { type: "string" }, seconds: { type: "string" } },
		strict: true,
		allowPositionals: false,
	}).values;
} catch (error) {
	fail(error instanceof Error ? error.message : "invalid arguments");
}
const megabytes = whole(values.mb, "mb", 1, 1_048_576);
const seconds = whole(values.seconds, "seconds", 0, 86_400);

const held: Buffer[] = [];
for (let left = megabytes; left > 0; left -= CHUNK_MB) {
	held.push(Buffer.allocUnsafe(Math.min(left, CHUNK_MB) * 1024 * 1024).fill(1));
}
const heldBytes = held.reduce((sum, chunk) => sum + chunk.length, 0);
console.log(
	JSON.stringify({
		event: "hold_memory_held",
		mb: heldBytes / (1024 * 1024),
		seconds,
		at: new Date().toISOString(),
	}),
);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
held.length = 0;
console.log(
	JSON.stringify({
		event: "hold_memory_released",
		mb: megabytes,
		at: new Date().toISOString(),
	}),
);
