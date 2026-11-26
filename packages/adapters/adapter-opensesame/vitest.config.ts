import { configDefaults, defineConfig } from "vitest/config";

// The default lane needs no OpenSesame. `test/real/` runs against a locally
// built kit under vitest.real.config.ts (`pnpm run test:real`) and is left out
// here by configuration, not by a skip: a skipped real test reads as a passed one.
//
// Most tests here start processes (the stand-in is a Node script that starts the
// command, itself Node), up to four in a row. On a busy machine one start takes
// seconds, so vitest's 5 s default fails tests whose assertions held. The
// budget is a deadline for the machine, not the property under test: what
// must be fast says so itself (the stderr read ends within 10 s of a held
// pipe, a hostile line is read in under 500 ms of CPU time).
export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, "test/real/**"],
		testTimeout: 20_000,
	},
});
