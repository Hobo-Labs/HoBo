import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Check both destinations before capture creates a lock, marker, or output. */
export function assertSafeCaptureDestinations(
	checkout: string,
	roots: readonly string[],
): void {
	const anchor = resolve(checkout);
	const canonicalAnchor = realpathSync(anchor);

	for (const root of roots) {
		const target = resolve(root);
		const pathFromAnchor = relative(anchor, target);
		if (
			!pathFromAnchor ||
			pathFromAnchor === ".." ||
			pathFromAnchor.startsWith(`..${sep}`) ||
			isAbsolute(pathFromAnchor)
		) {
			throw new Error(`Capture destination is outside checkout: ${target}`);
		}

		let current = canonicalAnchor;
		let exists = true;
		for (const component of pathFromAnchor.split(sep)) {
			current = join(current, component);
			let info: ReturnType<typeof lstatSync>;
			try {
				info = lstatSync(current);
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				) {
					exists = false;
					break;
				}
				throw new Error(`Cannot inspect capture destination ${current}`, {
					cause: error,
				});
			}
			if (info.isSymbolicLink() || !info.isDirectory()) {
				throw new Error(`Unsafe capture destination component: ${current}`);
			}
		}
		if (!exists) continue;

		const pending = [current];
		while (pending.length) {
			const dir = pending.pop();
			if (!dir) break;
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				const info = lstatSync(path);
				if (info.isSymbolicLink()) {
					throw new Error(`Unsafe capture destination symlink: ${path}`);
				}
				if (info.isDirectory()) {
					pending.push(path);
				} else if (!info.isFile() || info.nlink > 1) {
					throw new Error(`Unsafe capture destination file: ${path}`);
				}
			}
		}
	}
}
