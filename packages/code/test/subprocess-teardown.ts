import { afterAll } from "vitest";

import { killTrackedSubprocesses } from "./subprocess-cleanup.js";

afterAll(() => {
	killTrackedSubprocesses();
});
