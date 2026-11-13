/**
 * The seam between the p2p transport and the native binding (L11).
 *
 * `transport.ts` speaks only to these interfaces; `iroh.ts` implements them
 * over `@number0/iroh`, and the package's unit tests implement them in memory.
 * An endpoint is named by its id (the Ed25519 public key the binding derives
 * from the secret it was bound with), and a connection's `remoteId` is the id
 * the QUIC handshake proved, never one the peer claimed in a frame.
 */

/** What a binding binds an endpoint with. */
export type EndpointOptions = Readonly<{
	/** 32 bytes; the endpoint id is its Ed25519 public key. */
	secretKey: Uint8Array;
	/** The only relays the endpoint may use; empty disables relaying. */
	relayUrls: readonly string[];
	/** The one ALPN the endpoint serves and dials. */
	alpn: Uint8Array;
}>;

/** One direction-pair of a QUIC connection. */
export interface DuplexStream {
	write(bytes: Uint8Array): Promise<void>;
	/** Ends the send side; the peer reads end-of-stream after the bytes written. */
	finish(): Promise<void>;
	/** Waits, at most `timeoutMs`, until the peer has acknowledged everything sent or stopped reading. */
	flushed(timeoutMs: number): Promise<void>;
	/** Up to `max` bytes; an empty array at end-of-stream. */
	read(max: number): Promise<Uint8Array>;
}

export interface EndpointConnection {
	/** The peer's endpoint id, as proven by the handshake. */
	readonly remoteId: string;
	openStream(): Promise<DuplexStream>;
	acceptStream(): Promise<DuplexStream>;
	/** Closes the connection; unsent data is dropped. */
	close(): void;
	/** Resolves once the connection has ended, from either side. */
	closed(): Promise<void>;
}

export interface BoundEndpoint {
	readonly id: string;
	/** Resolves once the endpoint can be reached through a relay; immediately when it has none. */
	online(): Promise<void>;
	/** Dials `peer` by id over the endpoint's ALPN. Rejects when it cannot be reached. */
	connect(peer: string): Promise<EndpointConnection>;
	/** The next incoming connection whose handshake completed; undefined once the endpoint is closed. */
	accept(): Promise<EndpointConnection | undefined>;
	close(): Promise<void>;
}

export interface EndpointBinding {
	bind(options: EndpointOptions): Promise<BoundEndpoint>;
}
