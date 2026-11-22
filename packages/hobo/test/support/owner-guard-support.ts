import {
	closeSync,
	constants,
	fsyncSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function supportsOwnerGuard(): boolean {
	if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0)
		return false;
	const directory = mkdtempSync(join(tmpdir(), "hobo-owner-guard-probe-"));
	try {
		let current = realpathSync(directory);
		for (;;) {
			const handle = openSync(
				current,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				fsyncSync(handle);
			} finally {
				closeSync(handle);
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		return true;
	} catch {
		return false;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
