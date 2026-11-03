#!/usr/bin/env node
import { verifyBaseImageDigestResolves } from "./lib/ci-runner-contract.mts";

const check = await verifyBaseImageDigestResolves();
if (!check.ok) {
	console.error(`base image digest check failed: ${check.detail}`);
	process.exit(1);
}
console.log(`base image digest resolves: ${check.detail}`);
