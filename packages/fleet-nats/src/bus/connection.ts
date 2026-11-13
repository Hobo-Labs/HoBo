/**
 * Opening a NATS connection the way every fleet client does: TLS always
 * (§6.7, every listener requires it), the URLs checked, and the CA file named
 * by `HOBO_FLEET_NATS_CA` trusted besides the system roots, for deployments on
 * a private certificate authority.
 */
import {
	type Authenticator,
	connect,
	type NatsConnection,
	type NodeConnectionOptions,
} from "@nats-io/transport-node";

const SCHEMES = /^(tls|nats):\/\/[^\s/]+(:\d+)?\/?$/u;

/** Parses the server list: `tls://` or `nats://` host URLs only; TLS is required either way. */
export function parseServers(servers: readonly string[]): string[] {
	if (servers.length === 0) throw new Error("no NATS servers");
	for (const server of servers)
		if (!SCHEMES.test(server))
			throw new Error(
				`a NATS server must be a tls:// or nats:// URL: ${server}`,
			);
	return servers.map((server) => server.replace(/^tls:\/\//u, "nats://"));
}

export type OpenOptions = Readonly<{
	servers: readonly string[];
	authenticator: Authenticator | Authenticator[];
	name: string;
	inboxPrefix?: string;
	/** Keep reconnecting for the life of the process (devices); else fail fast (provisioning). */
	persistent: boolean;
}>;

export function connectionOptions(options: OpenOptions): NodeConnectionOptions {
	const ca = process.env.HOBO_FLEET_NATS_CA;
	const settings: NodeConnectionOptions = {
		servers: parseServers(options.servers),
		name: options.name,
		authenticator: options.authenticator,
		tls: ca === undefined || ca === "" ? {} : { caFile: ca },
		maxReconnectAttempts: options.persistent ? -1 : 0,
		reconnectTimeWait: 2_000,
		timeout: 10_000,
	};
	if (options.inboxPrefix !== undefined)
		settings.inboxPrefix = options.inboxPrefix;
	return settings;
}

export function open(options: OpenOptions): Promise<NatsConnection> {
	return connect(connectionOptions(options));
}
