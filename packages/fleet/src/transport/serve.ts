/**
 * The session server (design §6.12): accepts on every transport, asks
 * `authoriseSession` before any byte is delivered, serves shell, forward and
 * blob sessions inside the order's sandbox (never on the host), and publishes
 * a signed session-close fact with byte counts when each session ends.
 */
import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	SessionCloseSchema,
	type SessionGrant,
	SessionPurpose,
} from "../_generated/fleet_pb.js";
import { SESSION_CLOSE_CONTEXT } from "../contexts.js";
import { signEnvelope } from "../keys/index.js";
import type {
	Clock,
	DeviceKeys,
	FleetBus,
	FleetLog,
	FleetStream,
	FleetTransport,
	RegistryView,
	Sandbox,
	Subscription,
	TransportKind,
} from "../ports.js";
import { authorise } from "./authorise.js";
import { blobPath, digestHex } from "./blob.js";
import {
	exitPayload,
	readMessages,
	SESSION_TAG,
	type SessionMessage,
	writeMessage,
} from "./wire.js";

/** The most input a shell or forward session buffers for its command. */
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
// public-contract: the event kind of a session-close fact on FLEET_EVENTS (§7.3 EventChannel).
const SESSION_CLOSE_KIND = "session-close";
const encoder = new TextEncoder();

export type ServeDeps = Readonly<{
	transports: readonly FleetTransport[];
	registry: RegistryView;
	self: DeviceKeys;
	sandboxOf(orderId: string): Sandbox | undefined;
	bus: FleetBus;
	now: Clock;
	log: FleetLog;
}>;

type Session = Readonly<{
	deps: ServeDeps;
	kind: TransportKind;
	stream: FleetStream;
	grant: SessionGrant;
	messages: AsyncIterator<SessionMessage>;
	signal: AbortSignal;
}>;

const fail = (session: Session, reason: string) =>
	writeMessage(session.stream, SESSION_TAG.ERROR, encoder.encode(reason));

function sandboxFor(session: Session): Sandbox | undefined {
	const orderId = session.grant.orderId;
	if (orderId.length === 0) return undefined;
	const sandbox = session.deps.sandboxOf(orderId);
	if (sandbox === undefined)
		session.deps.log("hobo_fleet_sandbox_unavailable", {
			session: session.grant.sessionId,
			order: orderId,
		});
	return sandbox;
}

function commandFor(grant: SessionGrant): readonly string[] {
	return grant.purpose === SessionPurpose.SHELL
		? ["/bin/sh", "-s"]
		: ["nc", "127.0.0.1", String(grant.port)];
}

/** Shell and forward: the input until `END`, run once in the order's sandbox, output streamed back, then the exit code. */
async function serveCommand(session: Session): Promise<void> {
	const sandbox = sandboxFor(session);
	if (sandbox === undefined) {
		await fail(
			session,
			"no sandbox runs this session's order; a session never runs on the host",
		);
		return;
	}
	const input: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const next = await session.messages.next();
		if (next.done === true) return;
		if (next.value.tag === SESSION_TAG.END) break;
		if (next.value.tag !== SESSION_TAG.INPUT) {
			await fail(session, "a command session takes INPUT then END");
			return;
		}
		size += next.value.payload.length;
		if (size > MAX_INPUT_BYTES) {
			await fail(session, "the session input is too large");
			return;
		}
		input.push(next.value.payload);
	}
	let writes: Promise<void> = Promise.resolve();
	let result: Readonly<{ exitCode: number }>;
	try {
		result = await sandbox.exec({
			argv: commandFor(session.grant),
			env: {},
			stdin: new Uint8Array(Buffer.concat(input)),
			signal: session.signal,
			onOutput(chunk) {
				const copy = chunk.slice();
				writes = writes.then(() =>
					writeMessage(session.stream, SESSION_TAG.OUTPUT, copy),
				);
			},
		});
	} catch {
		await writes.catch(() => undefined);
		await fail(session, "the command could not run in the sandbox");
		return;
	}
	await writes;
	await writeMessage(
		session.stream,
		SESSION_TAG.EXIT,
		exitPayload(result.exitCode),
	);
}

/** Blob: one `REQUEST` for a digest the grant names, read from the order's sandbox and verified before `END`. */
async function serveBlob(session: Session): Promise<void> {
	const next = await session.messages.next();
	if (next.done === true) return;
	if (next.value.tag !== SESSION_TAG.REQUEST) {
		await fail(session, "a blob session starts with REQUEST");
		return;
	}
	const digest = new TextDecoder().decode(next.value.payload);
	const hex = digestHex(digest);
	if (hex === undefined || !session.grant.blobDigests.includes(digest)) {
		await fail(session, `blob ${digest} is not named in the grant`);
		return;
	}
	const sandbox = sandboxFor(session);
	if (sandbox === undefined) {
		await fail(session, "no sandbox holds this session's order");
		return;
	}
	const hash = createHash("sha256");
	let writes: Promise<void> = Promise.resolve();
	let exitCode: number;
	try {
		({ exitCode } = await sandbox.exec({
			argv: ["cat", blobPath(hex)],
			env: {},
			signal: session.signal,
			onOutput(chunk) {
				const copy = chunk.slice();
				hash.update(copy);
				writes = writes.then(() =>
					writeMessage(session.stream, SESSION_TAG.OUTPUT, copy),
				);
			},
		}));
	} catch {
		exitCode = -1;
	}
	await writes;
	if (exitCode !== 0) {
		await fail(session, `blob ${digest} is not held here`);
		return;
	}
	if (hash.digest("hex") !== hex) {
		await fail(session, `the held bytes do not match ${digest}`);
		return;
	}
	await writeMessage(session.stream, SESSION_TAG.END, new Uint8Array());
}

async function publishClose(
	deps: ServeDeps,
	kind: TransportKind,
	sessionId: string,
	counts: Readonly<{ bytesSent: number; bytesReceived: number }>,
): Promise<void> {
	const fact = create(SessionCloseSchema, {
		sessionId,
		memberId: deps.self.memberId,
		transport: kind,
		bytesSent: BigInt(counts.bytesSent),
		bytesReceived: BigInt(counts.bytesReceived),
		at: new Date(deps.now()).toISOString(),
	});
	let published = true;
	try {
		const envelope = await signEnvelope(
			deps.self.sign,
			SESSION_CLOSE_CONTEXT,
			toBinary(SessionCloseSchema, fact),
		);
		await deps.bus.events.publish(
			envelope,
			deps.self.memberId,
			SESSION_CLOSE_KIND,
		);
	} catch {
		published = false;
	}
	deps.log("hobo_fleet_session_closed", {
		session: sessionId,
		transport: kind,
		bytes_sent: counts.bytesSent,
		bytes_received: counts.bytesReceived,
		published,
	});
}

export function serve(deps: ServeDeps): Subscription {
	/** Grants `authorise` accepted, by session id, until their handler takes them. */
	const authorised = new Map<string, SessionGrant>();
	const running = new Set<AbortController>();
	let stopped = false;

	const handle = async (
		kind: TransportKind,
		stream: FleetStream,
		handed: SessionGrant,
	): Promise<void> => {
		const grant = authorised.get(handed.sessionId);
		authorised.delete(handed.sessionId);
		if (
			stopped ||
			grant === undefined ||
			grant.initiator?.transportIdentity !== stream.peer
		) {
			await stream.close().catch(() => undefined);
			return;
		}
		const controller = new AbortController();
		running.add(controller);
		const messages = readMessages(stream);
		const session: Session = {
			deps,
			kind,
			stream,
			grant,
			messages,
			signal: controller.signal,
		};
		try {
			if (grant.purpose === SessionPurpose.BLOB) await serveBlob(session);
			else await serveCommand(session);
		} catch {
			// A session that breaks off ends here; the close fact still records it.
		} finally {
			running.delete(controller);
			await messages.return(undefined).catch(() => undefined);
			const counts = await stream
				.close()
				.catch(() => ({ bytesSent: 0, bytesReceived: 0 }));
			await publishClose(deps, kind, grant.sessionId, counts);
		}
	};

	const subscriptions = deps.transports.map((transport) =>
		transport.accept(
			async (peer, envelope) => {
				if (stopped) return false;
				const outcome = await authorise(peer, envelope, {
					self: deps.self.memberId,
					registry: deps.registry,
					nowMs: deps.now(),
				});
				if (!outcome.ok) return false;
				authorised.set(outcome.value.sessionId, outcome.value);
				return true;
			},
			(stream, grant) => handle(transport.kind, stream, grant),
		),
	);

	return {
		async stop() {
			stopped = true;
			for (const controller of running) controller.abort();
			await Promise.all(
				subscriptions.map((subscription) => subscription.stop()),
			);
		},
	};
}
