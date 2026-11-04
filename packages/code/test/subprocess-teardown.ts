import { afterEach } from "vitest";

import {
	assertNoLeakedEvidenceSidecars,
	drainOrphanedEvidenceSidecars,
	killRegisteredSidecarGroups,
	killTrackedSubprocesses,
} from "./subprocess-cleanup.js";

afterEach(async () => {
	killRegisteredSidecarGroups();
	killTrackedSubprocesses();
	await drainOrphanedEvidenceSidecars();
	assertNoLeakedEvidenceSidecars();
});
