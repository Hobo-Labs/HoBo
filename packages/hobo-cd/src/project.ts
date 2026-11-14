import path from "node:path";
import { fileURLToPath } from "node:url";

/** This package's directory: the CD project `hobo cd up` converges by default. */
export function cdProjectDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
