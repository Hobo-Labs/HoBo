import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** The open file description stays in the relay, even if its lock helper exits. */
export async function acquirePartitionLock(databasePath: string): Promise<{
	release(): Promise<void>;
}> {
	if (process.platform !== "linux" || databasePath === ":memory:")
		throw new Error("partition locking requires a persistent Linux database");
	const absolute = resolve(databasePath);
	const canonical = await realpath(absolute).catch(async (error) => {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
		return join(await realpath(dirname(absolute)), basename(absolute));
	});
	const handle = await open(
		`${canonical}.lock`,
		constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		if (!(await handle.stat()).isFile())
			throw new Error("invalid partition lock");
		await handle.chmod(0o600);
	} catch (error) {
		await handle.close();
		throw error;
	}
	const child = spawn(
		"sh",
		[
			"-c",
			'flock --nonblock 3 || exit 73; printf "HOBO_LOCK_READY\\n"; cat >/dev/null',
		],
		{ detached: true, stdio: ["pipe", "pipe", "ignore", handle.fd] },
	);
	const input = child.stdin;
	const output = child.stdout;
	if (!input || !output) {
		child.kill("SIGKILL");
		await handle.close();
		throw new Error("partition lock helper pipes unavailable");
	}
	input.on("error", () => {
		/* A dead helper cannot release the parent's descriptor. */
	});
	const closed = new Promise<void>((resolveClosed) =>
		child.once("close", () => resolveClosed()),
	);
	let releaseTask: Promise<void> | undefined;
	const release = () => {
		releaseTask ??= (async () => {
			input.end();
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					closed,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							if (child.pid) {
								try {
									process.kill(-child.pid, "SIGKILL");
								} catch {
									/* Already stopped. */
								}
							}
							reject(new Error("partition lock helper did not stop"));
						}, 3000);
					}),
				]);
			} finally {
				clearTimeout(timer);
				await handle.close();
			}
		})();
		return releaseTask;
	};
	let timer: NodeJS.Timeout | undefined;
	try {
		await new Promise<void>((ready, reject) => {
			let acknowledgment = "";
			output.on("data", (chunk: Buffer) => {
				acknowledgment += chunk.toString();
				if (acknowledgment === "HOBO_LOCK_READY\n") ready();
				else if (acknowledgment.length > 64)
					reject(new Error("invalid partition lock acknowledgment"));
			});
			child.once("error", () =>
				reject(new Error("partition lock helper could not start")),
			);
			child.once("exit", () =>
				reject(
					new Error(
						"database partition is already locked or flock is unavailable",
					),
				),
			);
			timer = setTimeout(
				() => reject(new Error("partition lock startup timed out")),
				5000,
			);
		});
	} catch (error) {
		await release();
		throw error;
	} finally {
		clearTimeout(timer);
	}
	return { release };
}
