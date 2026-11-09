// Compile-time tests: `tsc -p tsconfig.types.json` must pass. The package's
// default test run type-checks this file with it (vitest's typecheck,
// vitest.config.ts), and so does its `typecheck` script. Run as an ordinary
// test, an `expectTypeOf` checks nothing.
import { describe, expectTypeOf, it } from "vitest";

import type { VercelFetch } from "../src/vercel-client.js";

type SentInit = Parameters<VercelFetch>[1];

describe("VercelFetch", () => {
	it("is handed a request that may carry no body", () => {
		expectTypeOf<SentInit["body"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<{
			readonly method: string;
			readonly headers: Record<string, string>;
		}>().toExtend<SentInit>();
	});
});
