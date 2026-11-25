import { join } from "node:path";
import {
	acquireLocalStateLock,
	LocalStateLockBusyError,
} from "./local-state-lock.js";

/** The operating system releases this exclusive lock even if the CLI is killed. */
export function acquireLocalDeploymentLock(directory: string): () => void {
	try {
		return acquireLocalStateLock(
			join(directory, "local-deployment-lock.sqlite"),
		);
	} catch (cause) {
		if (!(cause instanceof LocalStateLockBusyError)) throw cause;
		throw new Error(
			"Another hobo up operation holds the local deployment lock",
			{
				cause,
			},
		);
	}
}
