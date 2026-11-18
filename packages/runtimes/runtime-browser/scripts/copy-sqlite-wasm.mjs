import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
	import.meta.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"),
);
const output = new URL("../dist/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(source, new URL("sqlite3.wasm", output));
