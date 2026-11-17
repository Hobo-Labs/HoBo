import { afterEach, expect, it } from "vitest";
import {
	CAPTURE_SECRET_TOOL,
	createSecretCaptureApp,
	END_SECRET_CAPTURE_TOOL,
	SECRET_CAPTURE_STATUS_TOOL,
	type SecretCaptureApp,
	type SecretCaptureEvent,
	type SecretCaptureOutcome,
	type SecretStoreConnector,
	SecretStoreConnectorError,
	SUBMIT_SECRET_VALUE_TOOL,
} from "../src/index.js";
import { isJsonObject, isJsonString } from "../src/json.js";
import {
	memoryConnector,
	SPECS,
	sealAsTheFormDoes,
	synthetic,
} from "./secret-capture-support.js";

const support = { apps: true, urlElicitation: false };
const apps: SecretCaptureApp[] = [];

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close().catch(() => undefined);
});

function content(outcome: SecretCaptureOutcome) {
	if (
		outcome.kind !== "result" ||
		!isJsonObject(outcome.result.structuredContent)
	)
		throw new Error("expected structured result");
	return outcome.result.structuredContent;
}

async function open(app: SecretCaptureApp) {
	const shown = content(
		await app.callTool(
			CAPTURE_SECRET_TOOL,
			{ name: "HOBO_CI_WEBHOOK_SECRET" },
			support,
		),
	);
	const key = shown.key;
	if (
		!isJsonString(shown.ticketId) ||
		!isJsonString(shown.name) ||
		!isJsonObject(key) ||
		key.kty !== "EC" ||
		key.crv !== "P-256" ||
		!isJsonString(key.x) ||
		!isJsonString(key.y)
	)
		throw new Error("expected a capture ticket");
	return {
		ticketId: shown.ticketId,
		name: shown.name,
		key: { kty: "EC" as const, crv: "P-256" as const, x: key.x, y: key.y },
	};
}

it("persists the write intent before contacting the store and retries the same event id", async () => {
	const store = memoryConnector();
	let writes = 0;
	let auditDown = true;
	const attempts: SecretCaptureEvent[] = [];
	const persisted = new Map<string, SecretCaptureEvent>();
	const connector: SecretStoreConnector = {
		...store.connector,
		async store(target, value) {
			writes += 1;
			return store.connector.store(target, value);
		},
	};
	const app = createSecretCaptureApp({
		specs: SPECS,
		connector,
		onEvent(event) {
			attempts.push(event);
			persisted.set(event.id, event);
			if (auditDown && event.type === "secret.CaptureWriteStarted")
				throw new Error("lost acknowledgement");
		},
	});
	apps.push(app);
	const ticket = await open(app);
	const value = synthetic("secret", 24);
	const sealed = await sealAsTheFormDoes(ticket, value);
	expect(
		content(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: ticket.ticketId, sealed },
				support,
			),
		),
	).toMatchObject({ code: "SECRET_CAPTURE_AUDIT_UNAVAILABLE" });
	expect(writes).toBe(0);
	auditDown = false;
	expect(
		content(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: ticket.ticketId, sealed },
				support,
			),
		),
	).toMatchObject({ stored: true });
	expect(writes).toBe(1);
	const intents = attempts.filter(
		(event) => event.type === "secret.CaptureWriteStarted",
	);
	expect(intents).toHaveLength(2);
	expect(intents[0]?.id).toBe(intents[1]?.id);
	expect([...persisted.values()].map((event) => event.type)).toEqual([
		"secret.CaptureOpened",
		"secret.CaptureWriteStarted",
		"secret.CaptureStored",
	]);
	expect(JSON.stringify([...persisted.values()])).not.toContain(value);
});

it("does not repeat a successful store write when its result audit fails", async () => {
	const store = memoryConnector();
	let writes = 0;
	let auditDown = true;
	const connector: SecretStoreConnector = {
		...store.connector,
		async store(target, value) {
			writes += 1;
			return store.connector.store(target, value);
		},
	};
	const app = createSecretCaptureApp({
		specs: SPECS,
		connector,
		onEvent(event) {
			if (auditDown && event.type === "secret.CaptureStored")
				throw new Error("unavailable");
		},
	});
	apps.push(app);
	const ticket = await open(app);
	const sealed = await sealAsTheFormDoes(ticket, synthetic("secret", 24));
	expect(
		content(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: ticket.ticketId, sealed },
				support,
			),
		),
	).toMatchObject({ code: "SECRET_CAPTURE_AUDIT_UNAVAILABLE" });
	expect(writes).toBe(1);
	expect(
		content(
			await app.callTool(
				SECRET_CAPTURE_STATUS_TOOL,
				{ ticketId: ticket.ticketId },
				support,
			),
		),
	).toMatchObject({ code: "SECRET_CAPTURE_AUDIT_UNAVAILABLE" });
	auditDown = false;
	expect(
		content(
			await app.callTool(
				SECRET_CAPTURE_STATUS_TOOL,
				{ ticketId: ticket.ticketId },
				support,
			),
		),
	).toMatchObject({ state: "stored" });
	expect(
		content(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: ticket.ticketId, sealed },
				support,
			),
		),
	).toMatchObject({ code: "SECRET_CAPTURE_UNKNOWN_TICKET" });
	expect(writes).toBe(1);
});

it("serializes simultaneous submissions of the same ticket", async () => {
	const store = memoryConnector();
	let writes = 0;
	let release = () => {};
	let entered = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const connector: SecretStoreConnector = {
		...store.connector,
		async store(target, value) {
			writes += 1;
			entered();
			await gate;
			return store.connector.store(target, value);
		},
	};
	const app = createSecretCaptureApp({ specs: SPECS, connector });
	apps.push(app);
	const ticket = await open(app);
	const sealed = await sealAsTheFormDoes(ticket, synthetic("secret", 24));
	const first = app.callTool(
		SUBMIT_SECRET_VALUE_TOOL,
		{ ticketId: ticket.ticketId, sealed },
		support,
	);
	try {
		await started;
		const second = app.callTool(
			SUBMIT_SECRET_VALUE_TOOL,
			{ ticketId: ticket.ticketId, sealed },
			support,
		);
		release();
		expect(content(await first)).toMatchObject({ stored: true });
		expect(content(await second)).toMatchObject({
			code: "SECRET_CAPTURE_UNKNOWN_TICKET",
		});
		expect(writes).toBe(1);
	} finally {
		release();
	}
});

it("closes an uncertain write instead of repeating it", async () => {
	const store = memoryConnector();
	let writes = 0;
	const connector: SecretStoreConnector = {
		...store.connector,
		async store(target, value) {
			writes += 1;
			await store.connector.store(target, value);
			throw new Error("lost store response");
		},
	};
	const app = createSecretCaptureApp({ specs: SPECS, connector });
	apps.push(app);
	const ticket = await open(app);
	const sealed = await sealAsTheFormDoes(ticket, synthetic("secret", 24));
	expect(
		content(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: ticket.ticketId, sealed },
				support,
			),
		),
	).toMatchObject({ code: "SECRET_STORE_WRITE_FAILED" });
	expect(
		content(
			await app.callTool(
				SECRET_CAPTURE_STATUS_TOOL,
				{ ticketId: ticket.ticketId },
				support,
			),
		),
	).toMatchObject({ state: "uncertain" });
	expect(
		content(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: ticket.ticketId, sealed },
				support,
			),
		),
	).toMatchObject({ code: "SECRET_CAPTURE_UNKNOWN_TICKET" });
	expect(app.events().map((event) => event.type)).toEqual([
		"secret.CaptureOpened",
		"secret.CaptureWriteStarted",
		"secret.CaptureWriteUncertain",
	]);
	expect(writes).toBe(1);
});

it("never returns or audits a store reference containing the captured value", async () => {
	const store = memoryConnector();
	const connector: SecretStoreConnector = {
		...store.connector,
		async store(_target, value) {
			return { ref: `secref://runtime/${value.reveal()}` };
		},
	};
	const app = createSecretCaptureApp({ specs: SPECS, connector });
	apps.push(app);
	const ticket = await open(app);
	const value = synthetic("secret", 24);
	const sealed = await sealAsTheFormDoes(ticket, value);
	const answer = await app.callTool(
		SUBMIT_SECRET_VALUE_TOOL,
		{ ticketId: ticket.ticketId, sealed },
		support,
	);
	expect(content(answer)).toMatchObject({ code: "SECRET_STORE_WRITE_FAILED" });
	expect(JSON.stringify(answer)).not.toContain(value);
	expect(JSON.stringify(app.events())).not.toContain(value);
	expect(
		content(
			await app.callTool(
				SECRET_CAPTURE_STATUS_TOOL,
				{ ticketId: ticket.ticketId },
				support,
			),
		),
	).toMatchObject({ state: "uncertain" });
});

it("never returns or audits a connector error containing the captured value", async () => {
	const store = memoryConnector();
	const connector: SecretStoreConnector = {
		...store.connector,
		async store(_target, value) {
			throw new SecretStoreConnectorError(value.reveal());
		},
	};
	const app = createSecretCaptureApp({ specs: SPECS, connector });
	apps.push(app);
	const ticket = await open(app);
	const value = "abcdefghijklmnopqrstuvwxyzabcdef";
	const sealed = await sealAsTheFormDoes(ticket, value);
	const answer = await app.callTool(
		SUBMIT_SECRET_VALUE_TOOL,
		{ ticketId: ticket.ticketId, sealed },
		support,
	);
	expect(content(answer)).toMatchObject({ code: "SECRET_STORE_WRITE_FAILED" });
	expect(JSON.stringify(answer)).not.toContain(value);
	expect(JSON.stringify(app.events())).not.toContain(value);
});

it("records a completed write even if the capture clock fails during the store call", async () => {
	const store = memoryConnector();
	let clockFailed = false;
	const connector: SecretStoreConnector = {
		...store.connector,
		async store(target, value) {
			const receipt = await store.connector.store(target, value);
			clockFailed = true;
			return receipt;
		},
	};
	const app = createSecretCaptureApp({
		specs: SPECS,
		connector,
		now: () => {
			if (clockFailed) throw new Error("clock unavailable");
			return Date.now();
		},
	});
	apps.push(app);
	const ticket = await open(app);
	const sealed = await sealAsTheFormDoes(ticket, synthetic("secret", 24));
	expect(
		content(
			await app.callTool(
				SUBMIT_SECRET_VALUE_TOOL,
				{ ticketId: ticket.ticketId, sealed },
				support,
			),
		),
	).toMatchObject({ stored: true });
	expect(app.events().map((event) => event.type)).toEqual([
		"secret.CaptureOpened",
		"secret.CaptureWriteStarted",
		"secret.CaptureStored",
	]);
});

it("closes the loopback page and writer even when the closing audit is unavailable", async () => {
	const store = memoryConnector();
	let auditDown = true;
	let ended = 0;
	const connector: SecretStoreConnector = {
		...store.connector,
		async endWriterSession() {
			ended += 1;
			return store.connector.endWriterSession();
		},
	};
	const app = createSecretCaptureApp({
		specs: SPECS,
		connector,
		onEvent(event) {
			if (auditDown && event.type === "secret.CaptureClosed")
				throw new Error("unavailable");
		},
	});
	apps.push(app);
	const shown = content(
		await app.callTool(
			CAPTURE_SECRET_TOOL,
			{ name: "HOBO_CI_WEBHOOK_SECRET" },
			{ apps: false, urlElicitation: false },
		),
	);
	if (!isJsonString(shown.url)) throw new Error("expected loopback URL");
	expect(new URL(shown.url).hostname).toBe("127.0.0.1");
	expect(
		(await fetch(shown.url, { signal: AbortSignal.timeout(3000) })).status,
	).toBe(200);
	await expect(app.close()).rejects.toMatchObject({
		code: "SECRET_CAPTURE_AUDIT_UNAVAILABLE",
	});
	expect(ended).toBe(1);
	await expect(
		fetch(shown.url, { signal: AbortSignal.timeout(3000) }),
	).rejects.toThrow();
	expect(
		content(
			await app.callTool(
				CAPTURE_SECRET_TOOL,
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				support,
			),
		),
	).toMatchObject({ code: "SECRET_CAPTURE_CLOSED" });
	auditDown = false;
	await app.close();
	expect(app.events().map((event) => event.type)).toEqual([
		"secret.CaptureOpened",
		"secret.CaptureClosed",
		"secret.CaptureWriterSessionEnded",
	]);
});

it("records an uncertain writer-session revocation without exposing the error", async () => {
	const store = memoryConnector();
	const connector: SecretStoreConnector = {
		...store.connector,
		async endWriterSession() {
			throw new Error("private connector error");
		},
	};
	const app = createSecretCaptureApp({ specs: SPECS, connector });
	apps.push(app);
	const answer = await app.callTool(END_SECRET_CAPTURE_TOOL, {}, support);
	expect(content(answer)).toMatchObject({ writerSession: "unavailable" });
	expect(app.events().map((event) => event.type)).toEqual([
		"secret.CaptureWriterSessionUncertain",
	]);
	expect(JSON.stringify(answer)).not.toContain("private connector error");
});
