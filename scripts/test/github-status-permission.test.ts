import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import {
	githubAppStatusIsReadOnly,
	hasReadOnlyStatusInstallation,
} from "../ci/github-status-permission.mts";

describe("GitHub App status permissions", () => {
	it("recognizes only one explicit read-only installation for the target owner", () => {
		const read = JSON.stringify({ owner: "HoBo-Labs", statuses: "read" });
		const other = JSON.stringify({ owner: "other", statuses: "write" });
		assert.equal(
			hasReadOnlyStatusInstallation("hobo-labs/HoBo", `${other}\n${read}`),
			true,
		);
		for (const value of [
			"",
			other,
			JSON.stringify({ owner: "HoBo-Labs", statuses: "write" }),
			JSON.stringify({ owner: "HoBo-Labs", statuses: null }),
			`${read}\n${read}`,
			`${read}\nnot-json`,
			`${read}\n{}`,
		])
			assert.equal(
				hasReadOnlyStatusInstallation("HoBo-Labs/HoBo", value),
				false,
				value,
			);
	});

	it("checks App user tokens without treating other credentials or failed reads as read-only", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-status-permission-"));
		try {
			const calls = join(root, "calls");
			writeFileSync(
				join(root, "gh"),
				'#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n[ "${FAIL:-}" = 1 ] && exit 1\nprintf "%s\\n" "$INSTALLATIONS"\n',
				{ mode: 0o755 },
			);
			const env = {
				PATH: [root, process.env.PATH ?? ""].join(delimiter),
				GH_HOST: "github.com",
				GH_REPO: "github.com/HoBo-Labs/HoBo",
				GH_TOKEN: "ghu_test",
				CALLS: calls,
				INSTALLATIONS: JSON.stringify({ owner: "hobo-labs", statuses: "read" }),
			};
			assert.equal(githubAppStatusIsReadOnly({ cwd: root, env }), true);
			assert.match(
				readFileSync(calls, "utf8"),
				/user\/installations\?per_page=100.*--paginate/u,
			);
			assert.equal(
				githubAppStatusIsReadOnly({ cwd: root, env: { ...env, FAIL: "1" } }),
				false,
			);
			const before = readFileSync(calls, "utf8");
			assert.equal(
				githubAppStatusIsReadOnly({
					cwd: root,
					env: { ...env, GH_TOKEN: "gho_test" },
				}),
				false,
			);
			assert.equal(readFileSync(calls, "utf8"), before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
