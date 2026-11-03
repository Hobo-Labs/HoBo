import { afterAll, beforeAll } from "vitest";

/**
 * Run this file's nested Turbo fixtures without the caller's TURBO_* config.
 * CI exports a shared TURBO_CACHE_DIR (and may export remote-cache settings);
 * fixtures are byte-identical across temp dirs, so their task hashes collide and
 * a shared cache replays logs instead of running the scripts the tests observe.
 */
export function isolateTurboEnv(): void {
	const inherited = Object.entries(process.env).filter(([name]) =>
		name.startsWith("TURBO_"),
	);
	beforeAll(() => {
		for (const [name] of inherited) delete process.env[name];
	});
	afterAll(() => {
		for (const [name, value] of inherited) process.env[name] = value;
	});
}
