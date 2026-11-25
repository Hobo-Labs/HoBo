import path from "node:path";
import { fileURLToPath } from "node:url";

export function cdProjectDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
