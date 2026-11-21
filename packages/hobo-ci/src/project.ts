import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This package's directory: the CI project `hobo ci up` converges by default
 * (its `src/bindle.ts`). Resolved from the built module, `dist/project.js`.
 */
export function ciProjectDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
