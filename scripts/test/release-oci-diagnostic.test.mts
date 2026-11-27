import assert from "node:assert/strict";
import { test } from "vitest";
import { ociRegistryFailure } from "../lib/release-oci-diagnostic.mts";

test("extracts the operation and status without emitting registry content", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	assert.equal(
		ociRegistryFailure(`upload blob ${digest} answered HTTP 403 (DENIED)`),
		"oci operation=upload blob http=403",
	);
	assert.equal(
		ociRegistryFailure("token realm for registry ghcr.io answered HTTP 401"),
		"oci operation=token exchange http=401",
	);
	assert.equal(
		ociRegistryFailure(
			`blob ${digest} is 200 bytes, over the 100-byte transport bound`,
		),
		"oci blob-too-large",
	);
	assert.equal(
		ociRegistryFailure(
			"registry transport failed (TRANSPORT_HOST_FORBIDDEN); nothing past the last observation is assumed",
		),
		"oci transport-failed",
	);
});

test("rejects injected suffixes, newlines, invalid status and arbitrary realms", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	for (const value of [
		`upload blob ${digest} answered HTTP 403 (DENIED) secret=ghp_secret`,
		`upload blob ${digest} answered HTTP 403\n::error::injection`,
		`upload blob ${digest} answered HTTP 999`,
		"token realm for registry evil.example answered HTTP 403",
	])
		assert.equal(ociRegistryFailure(value), undefined);
});
