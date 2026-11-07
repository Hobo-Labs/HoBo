import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initStation,
	loadStationEvents,
	PAM_RAIL_CAPABILITY,
	persistStationEvents,
	StationService,
	stationRoot,
} from "@hobo/stations";
import { afterEach, describe, expect, it } from "vitest";

import { type HoboCodeCliResult, runHoboCodeCli } from "../src/cli.js";
import { type JsonObject, parseJsonObject } from "../src/json.js";
import {
	type OpenedGateway,
	openStationGateway,
	type StationBrokerContext,
} from "../src/machine-sessions.js";

// `hobo-code session serve --host <machine>` opens a Station authorization
// and hands it to the forward, which closes it. If the verb ends any other
// way once it is open, a refusal or a throw, the verb closes it, once, and the
// Station's pam.SessionEnded says why: otherwise it waited out its lease.

const STATION = "station:local";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/** A local Station whose active Rail enables privileged access. */
function stationWithPam(hoboHome: string): void {
	initStation({ hoboHome, id: STATION, tenant: "acme" });
	const service = StationService.fromEvents(
		loadStationEvents(hoboHome, STATION),
		{ stationId: STATION },
	);
	const rail = service.publishRail({
		id: "rail-pam",
		name: "PAM",
		version: "1.0.0",
		stationId: STATION,
		policyPacks: [PAM_RAIL_CAPABILITY],
	});
	service.approveRail(rail.contentHash);
	service.activateRail(rail.contentHash);
	persistStationEvents(hoboHome, STATION, service.events);
}

function auditPath(hoboHome: string): string {
	return join(stationRoot(hoboHome, STATION), "pam-audit.jsonl");
}

/** The Station's audit, as `type` or `type(reason)` for a session's end. */
function audit(hoboHome: string): readonly string[] {
	const path = auditPath(hoboHome);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line): JsonObject => parseJsonObject(line))
		.map((event) =>
			event.type === "pam.SessionEnded"
				? `${String(event.type)}(${String(event.reason)})`
				: String(event.type),
		);
}

interface Served {
	readonly result: HoboCodeCliResult;
	/** The reason of each close of the gateway, in order. */
	readonly closes: readonly (string | undefined)[];
	readonly hoboHome: string;
}

/**
 * Run `session serve --host box` in process against a real local Station,
 * with its gateway changed by `alter` (the real one when it changes nothing).
 */
async function serve(
	alter: (
		gateway: OpenedGateway,
		context: StationBrokerContext,
		hoboHome: string,
	) => OpenedGateway = (gateway) => gateway,
	upstream: "none" | "missing" = "none",
): Promise<Served> {
	const root = mkdtempSync(join(tmpdir(), "a"));
	roots.push(root);
	const hoboHome = join(root, "h");
	const project = join(root, "p");
	mkdirSync(project);
	stationWithPam(hoboHome);
	writeFileSync(
		join(project, "devenv.machines.json"),
		`${JSON.stringify({
			machines: [
				{ id: "box", host: "box.ts.net", isolationClass: "development" },
			],
		})}\n`,
	);
	const closes: (string | undefined)[] = [];
	const result = await runHoboCodeCli(
		[
			"session",
			"serve",
			"--host",
			"box",
			"--port",
			"4242",
			"--station",
			STATION,
		],
		{
			hoboHome,
			cwd: project,
			env: { PATH: process.env.PATH ?? "", HOBO_HOME: hoboHome },
			openStationGateway: async (context) => {
				const gateway = await openStationGateway(
					upstream === "missing"
						? { ...context, sshAuthSock: join(root, "no-agent.sock") }
						: context,
				);
				const altered = alter(gateway, context, hoboHome);
				return {
					...altered,
					close: async (reason) => {
						closes.push(reason);
						await altered.close(reason);
					},
				};
			},
		},
	);
	return { result, closes, hoboHome };
}

describe("session serve --host, failing once the Station authorization is open", () => {
	it("closes the authorization after a throw, and the Station's audit says why", async () => {
		// The Station's own gateway, which throws once it has authorized the
		// session: reading its audit types, the next step.
		const served = await serve((gateway) => ({
			...gateway,
			auditTypes: () => {
				throw new Error("the gateway's audit could not be read");
			},
		}));
		expect(served.result.ok).toBe(false);
		expect(served.result.code).toBe("HOBO_CODE_SESSION_FAILED");
		expect(served.result.message).toContain(
			"the gateway's audit could not be read",
		);
		expect(served.closes).toEqual(["session-serve-failed"]);
		expect(audit(served.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.SessionEnded(session-serve-failed)",
			"pam.GatewayStopped",
		]);
	});

	it("closes it once, saying why, when the SSH agent cannot be resolved", async () => {
		const served = await serve(undefined, "missing");
		expect(served.result.code).toBe(
			"HOBO_CODE_SESSION_REMOTE_IDENTITY_UNAVAILABLE",
		);
		expect(served.closes).toEqual(["session-serve-failed"]);
		expect(audit(served.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.SessionEnded(session-serve-failed)",
			"pam.GatewayStopped",
		]);
	});

	it("closes it once, saying why, when the start audit event is missing", async () => {
		const served = await serve((gateway) => ({
			...gateway,
			auditTypes: () => [],
		}));
		expect(served.result.code).toBe("HOBO_CODE_SESSION_REMOTE_AUDIT_MISSING");
		expect(served.closes).toEqual(["session-serve-failed"]);
		expect(audit(served.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.SessionEnded(session-serve-failed)",
			"pam.GatewayStopped",
		]);
	});

	it("closes it once when the Station refuses the session", async () => {
		const served = await serve((gateway) => ({
			...gateway,
			broker: {
				registerTarget: (target) => gateway.broker.registerTarget(target),
				brokerSession: async () => {
					throw new Error("policy denied browser access");
				},
			},
		}));
		expect(served.result.code).toBe("HOBO_CODE_SESSION_REMOTE_DENIED");
		expect(served.closes).toEqual(["session-serve-failed"]);
		expect(audit(served.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.GatewayStopped",
		]);
	});
});

/** Make the Station's audit unwritable (a directory where the file was); the undo. */
function breakAudit(hoboHome: string): () => void {
	const path = auditPath(hoboHome);
	renameSync(path, `${path}.saved`);
	mkdirSync(path);
	return () => {
		rmSync(path, { recursive: true });
		renameSync(`${path}.saved`, path);
	};
}

describe("session serve --host, when closing the authorization fails too", () => {
	it("still answers with the verb's own failure, and notes the close's", async () => {
		const served = await serve((gateway, _context, hoboHome) => ({
			...gateway,
			auditTypes: () => {
				breakAudit(hoboHome);
				throw new Error("the gateway's audit could not be read");
			},
		}));
		expect(served.result.ok).toBe(false);
		expect(served.result.code).toBe("HOBO_CODE_SESSION_FAILED");
		expect(served.result.message).toContain(
			"the gateway's audit could not be read",
		);
		expect(served.result.message).toMatch(
			/closing the Station authorization failed too: .*EISDIR/u,
		);
		expect(served.result.data).toEqual(
			expect.objectContaining({
				authorizationCloseError: expect.stringContaining("EISDIR"),
			}),
		);
	});
});

describe("session serve --host, its close retried once the audit is writable again", () => {
	it("writes the session's end, then the gateway's stop", async () => {
		let opened: OpenedGateway | undefined;
		let restore = (): void => {};
		const served = await serve((gateway, _context, hoboHome) => {
			opened = gateway;
			return {
				...gateway,
				auditTypes: () => {
					restore = breakAudit(hoboHome);
					throw new Error("the gateway's audit could not be read");
				},
			};
		});
		expect(served.result.code).toBe("HOBO_CODE_SESSION_FAILED");
		restore();
		await opened?.close("retried");
		expect(audit(served.hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.SessionEnded(retried)",
			"pam.GatewayStopped",
		]);
	});
});

describe("the Station gateway's close", () => {
	it("is done only once every step is: retried, it writes what it could not", async () => {
		const root = mkdtempSync(join(tmpdir(), "a"));
		roots.push(root);
		const hoboHome = join(root, "h");
		stationWithPam(hoboHome);
		const gateway = await openStationGateway({
			hoboHome,
			stationId: STATION,
			isolationClass: "development",
		});
		const restore = breakAudit(hoboHome);
		await expect(gateway.close("first-try")).rejects.toThrow(/EISDIR/u);
		restore();
		await gateway.close("second-try");
		await gateway.close("third-try");
		expect(audit(hoboHome)).toEqual([
			"pam.GatewayStarted",
			"pam.GatewayStopped",
		]);
	});
});
