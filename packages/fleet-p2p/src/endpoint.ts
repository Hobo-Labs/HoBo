export type EndpointOptions = Readonly<{
	secretKey: Uint8Array;
	relayUrls: readonly string[];
	alpn: Uint8Array;
}>;

export interface DuplexStream {
	write(bytes: Uint8Array): Promise<void>;
	finish(): Promise<void>;
	flushed(timeoutMs: number): Promise<void>;
	read(max: number): Promise<Uint8Array>;
}

export interface EndpointConnection {
	readonly remoteId: string;
	openStream(): Promise<DuplexStream>;
	acceptStream(): Promise<DuplexStream>;
	close(): void;
	closed(): Promise<void>;
}

export interface BoundEndpoint {
	readonly id: string;
	online(): Promise<void>;
	connect(peer: string): Promise<EndpointConnection>;
	accept(): Promise<EndpointConnection | undefined>;
	close(): Promise<void>;
}

export interface EndpointBinding {
	bind(options: EndpointOptions): Promise<BoundEndpoint>;
}
