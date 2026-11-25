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
