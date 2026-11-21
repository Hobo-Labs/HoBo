#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchReleaseTurboBase } from "./stage-release-oci-app.mts";

const root = join(import.meta.dirname, "..", "..");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const base = process.env.HOBO_RELEASE_TURBO_BASE?.trim() ?? "";
	if (base) fetchReleaseTurboBase(root, base);
}