import { isJsonObject, isJsonString, type JsonValue } from "./json.js";
import type { WorkspaceRecord } from "./workspace.js";

export function parseWorkspaceRecord(record: JsonValue): WorkspaceRecord {
	if (
		!isJsonObject(record) ||
		!isJsonString(record.name) ||
		!record.name ||
		!isJsonString(record.path) ||
		!record.path ||
		!isJsonString(record.source) ||
		!record.source ||
		!isJsonString(record.createdAt) ||
		!record.createdAt ||
		(record.tier !== "reflink" &&
			record.tier !== "overlayfs" &&
			record.tier !== "hardlink" &&
			record.tier !== "copy") ||
		(record.upper !== undefined && !isJsonString(record.upper)) ||
		(record.work !== undefined && !isJsonString(record.work)) ||
		(record.tier === "overlayfs" && (!record.upper || !record.work)) ||
		Object.keys(record).some(
			(key) =>
				![
					"name",
					"path",
					"source",
					"tier",
					"createdAt",
					"upper",
					"work",
				].includes(key),
		)
	)
		throw new TypeError("invalid workspace");
	return {
		name: record.name,
		path: record.path,
		source: record.source,
		tier: record.tier,
		createdAt: record.createdAt,
		...(isJsonString(record.upper) ? { upper: record.upper } : undefined),
		...(isJsonString(record.work) ? { work: record.work } : undefined),
	};
}
