// Test preload: holds the full hobo-mcp server (mcp-serve) from loading
// until this process gets SIGUSR2, as a cold machine's slow load would.
import { register } from "node:module";

register("./hold-mcp-serve-hooks.mjs", import.meta.url);

globalThis.hoboMcpServeReleased = new Promise((resolve) =>
	process.once("SIGUSR2", resolve),
);
