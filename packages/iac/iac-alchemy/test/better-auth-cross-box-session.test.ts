import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createBetterAuthHostHarness } from "./better-auth-host-harness.js";
import {
	loadSyntheticBetterAuthSession,
	openBetterAuthSessionStore,
	recordSyntheticBetterAuthSignIn,
} from "./better-auth-session-durability.js";

describe("better-auth cross-box session", () => {
	it("lets a second host read the session row written by the first box", () => {
		const previousHome = process.env.ALCHEMY_HOME;
		const previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
		const sharedPlane = mkdtempSync(
			join(tmpdir(), "hobo-better-auth-cross-box-"),
		);
		const sessionStorePath = join(sharedPlane, "shared-session.db");
		const boxA = createBetterAuthHostHarness({
			sharedSessionStorePath: sessionStorePath,
		});
		const boxB = createBetterAuthHostHarness({
			sharedSessionStorePath: sessionStorePath,
		});
		const databaseA = openBetterAuthSessionStore(sessionStorePath);
		let databaseAClosed = false;
		try {
			const signedIn = recordSyntheticBetterAuthSignIn(databaseA, {
				sessionToken: "tok_cross_box",
			});
			databaseA.close();
			databaseAClosed = true;
			const databaseB = openBetterAuthSessionStore(sessionStorePath);
			try {
				expect(boxA.stackName).toBe("better-auth-host");
				expect(boxB.stackName).toBe("better-auth-host");
				expect(boxA.sessionStorePath).toBe(boxB.sessionStorePath);
				expect(
					loadSyntheticBetterAuthSession(databaseB, signedIn.sessionToken),
				).toEqual(signedIn);
			} finally {
				databaseB.close();
			}
		} finally {
			if (!databaseAClosed) databaseA.close();
			boxB.dispose();
			boxA.dispose();
			rmSync(sharedPlane, { recursive: true, force: true });
		}
		expect(process.env.ALCHEMY_HOME).toBe(previousHome);
		expect(process.env.ALCHEMY_TELEMETRY_DISABLED).toBe(previousTelemetry);
	});
});
