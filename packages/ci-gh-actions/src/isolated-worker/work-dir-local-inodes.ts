import type { WorkDirInodeBreakdown } from "./work-dir-inode-breakdown.js";

export function workDirLocalInodeEstimate(
	breakdown: WorkDirInodeBreakdown,
): number {
	return Math.max(
		0,
		breakdown.entries -
			breakdown.linkedNodeModules -
			breakdown.pnpmVirtualStoreInWork,
	);
}
