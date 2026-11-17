import { join } from "node:path";

export function defaultDbPath(dataDir: string): string {
	return join(dataDir, "eventstore.sqlite");
}
