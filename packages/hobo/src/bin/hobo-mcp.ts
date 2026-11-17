#!/usr/bin/env node
import { createHoboMcpServer, createSecretCaptureApp } from "@hobo/mcp";

import { createComposedHoboCli } from "../cli.js";
import {
	relaunchInputFor,
	relaunchMcpUnderOpenSesame,
	reportingCredentialRefusals,
	wantsOpenSesameRelaunch,
} from "../credentials-opensesame.js";
import { defaultHoboHome } from "../hobo-home.js";
import { openMcpAuditJournal } from "../mcp-audit-journal.js";
import {
	createInfisicalCaptureConnector,
	RELAY_SECRET_CAPTURE_SPECS,
	secretCaptureProjectDir,
} from "../mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	serveMcpStdio,
} from "../mcp-stdio.js";
import { removeOwnedDirsOnSignals } from "../owned-temp-dir.js";

async function serve(): Promise<number> {
	removeOwnedDirsOnSignals();
	let audit: ReturnType<typeof openMcpAuditJournal>;
	try {
		audit = openMcpAuditJournal(defaultHoboHome());
	} catch {
		process.stderr.write("hobo-mcp: audit journal unavailable\n");
		return 1;
	}
	try {
		return await serveWithAudit(audit);
	} finally {
		audit.close();
	}
}

async function serveWithAudit(
	audit: ReturnType<typeof openMcpAuditJournal>,
): Promise<number> {
	const server = createHoboMcpServer({
		cli: createComposedHoboCli(),
		auditSink: audit.record,
		rateLimitAuditSink: audit.record,
	});
	const capture = createSecretCaptureApp({
		specs: RELAY_SECRET_CAPTURE_SPECS,
		connector: createInfisicalCaptureConnector({
			projectDir: secretCaptureProjectDir(process.cwd(), process.env),
		}),
		notify: (method, params) => {
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	try {
		await serveMcpStdio({
			server,
			auth: localOperatorAuth(),
			input: process.stdin,
			output: process.stdout,
			session: createMcpStdioSession(capture),
		});
	} finally {
		await capture.close();
	}
	return 0;
}

process.exitCode = wantsOpenSesameRelaunch(process.env)
	? await relaunchMcpUnderOpenSesame(relaunchInputFor(process))
	: await reportingCredentialRefusals(serve);
