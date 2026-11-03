import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PrincipalRef } from "@hobo/core";
import { isJsonString } from "../json.js";
import type { YardSession } from "./yard-client.js";

// Mocked-lane session material. The Yard gateway (gateway.authorize) accepts any
// attributable principal — a non-`system` kind with a non-empty id — so a
// deterministic fixture principal is a sufficient dev identity until @hobo/
// identity SVID brokering lands. `hobo login` mints one; `hobo up`/`down` consume
// it. Persisted under `.hobo/session.json` (gitignored) so the verbs chain.

export const SESSION_FILE = path.join(".hobo", "session.json");
export const DEFAULT_TENANT = "hobo-dev"; // public-contract: tenant id recorded for a session opened without one
export const ANONYMOUS_SUBJECT = "anonymous"; // public-contract: subject recorded for an unauthenticated session

function sessionPath(dir: string): string {
	return path.join(dir, SESSION_FILE);
}

export function createFixtureSession(
	input: { tenant?: string; subject?: string; issuedAt?: string } = {},
): YardSession {
	const tenant = input.tenant ?? DEFAULT_TENANT;
	const subject = input.subject ?? ANONYMOUS_SUBJECT;
	const principal: PrincipalRef = { kind: "user", id: `user:${subject}` };
	const token = `hobo-svid-${createHash("sha256").update(`${tenant}:${subject}`).digest("hex").slice(0, 24)}`;
	return {
		tenant,
		principal,
		token,
		issuedAt: input.issuedAt ?? new Date().toISOString(),
	};
}

export async function persistSession(
	dir: string,
	session: YardSession,
): Promise<string> {
	const file = sessionPath(dir);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(session, null, 2)}\n`);
	return file;
}

export async function loadSession(dir: string): Promise<YardSession | null> {
	try {
		const raw = await readFile(sessionPath(dir), "utf8");
		// SAFETY: `const parsed = JSON.parse(raw) as YardSession;` is required at this I/O or test boundary.
		const parsed = JSON.parse(raw) as YardSession;
		if (
			parsed &&
			isJsonString(parsed.token) &&
			parsed.principal &&
			isJsonString(parsed.principal.id)
		) {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}
