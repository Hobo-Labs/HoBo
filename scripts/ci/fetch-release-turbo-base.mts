#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchReleaseTurboBase } from "./stage-release-oci-app.mts";

const root = join(import.meta.dirname, "..", "..");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const base = process.env.HOBO_RELEASE_TURBO_BASE?.trim() ?? "";
	if (base) {
		try {
			fetchReleaseTurboBase(root, base);
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			const detail = raw
				.replace(/%/gu, "%25")
				.replace(/\r/gu, "%0D")
				.replace(/\n/gu, "%0A");
			console.log(
				`::warning title=release-turbo-base::${detail}; release OCI build may fall back to full turbo graph`,
			);
		}
	}
}
