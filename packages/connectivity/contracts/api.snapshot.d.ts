export declare function createOverlayTransport(overlay: OverlayNetwork): FleetTransport;

export declare function createTailscaleCredentialMinter(options: OverlayMinterOptions): OverlayCredentialMinter;
export declare function createNetbirdCredentialMinter(options: OverlayMinterOptions): OverlayCredentialMinter;
export type OverlayMinterOptions = Readonly<{
    apiBase: string;
    organisation: string;
    credential: () => Promise<string>;
    fetch: typeof fetch;
}>;
