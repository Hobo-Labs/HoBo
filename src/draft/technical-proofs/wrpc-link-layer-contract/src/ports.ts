import { isJsonString, type JsonValue } from "./json.js";
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INTERFACE_ID_RE =
  /^[a-z][a-z0-9-]*:[a-z0-9-]+\/[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type WireVersion = Readonly<{
  raw: string;
  major: number;
  minor: number;
  patch: number;
}>;

export type InterfaceId = string & { readonly __brand: "InterfaceId" };

export type TransportKind = "in-process" | "lattice";

export interface WitCodec {
  readonly name: string;
  encode(value: JsonValue): JsonValue;
  decode(value: JsonValue): JsonValue;
}

export interface TransportInvocation {
  link: EstablishedLink;
  operation: string;
  payload: JsonValue;
  deadline: string | null;
}

export interface WrpcTransport {
  readonly kind: TransportKind;
  invoke(invocation: TransportInvocation): Promise<JsonValue>;
}

// domain-view: parse-produced draft-proof record; its wire form is the InterfacePin proto message in data-models/.
export interface InterfacePin {
  interfaceId: InterfaceId;
  stability: "stable" | "preview" | "experimental";
  versions: WireVersion[];
}

export type ProviderHandler = (
  payload: JsonValue,
  context: TransportInvocation,
) => JsonValue | void | Promise<JsonValue | void>;

export interface ComponentRegistration {
  id: string;
  imports: InterfacePin[];
}

export interface ProviderRegistration {
  id: string;
  exports: InterfacePin[];
  handlers: Record<string, Record<string, ProviderHandler>>;
}

export interface LinkRequest {
  componentId: string;
  importInterface: string;
  providerId: string;
  exportInterface: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the NegotiatedWire proto message in data-models/.
export interface NegotiatedWire {
  interfaceId: string;
  version: string;
  minor: string;
  stability: string;
  floor: string;
}

export interface EstablishedLink {
  readonly componentId: string;
  readonly importInterface: string;
  readonly providerId: string;
  readonly exportInterface: string;
  readonly transport: TransportKind;
  readonly boundaryMode: "live";
  readonly negotiatedWire: NegotiatedWire;
}

export interface LinkEstablishedEvent {
  type: "link.Established";
  componentId: string;
  importInterface: string;
  providerId: string;
  exportInterface: string;
  transport: TransportKind;
  boundaryMode: "live";
  negotiatedWire: NegotiatedWire;
}

export interface LinkCalledEvent {
  type: "link.Called";
  componentId: string;
  importInterface: string;
  providerId: string;
  exportInterface: string;
  operation: string;
  boundaryMode: "live";
  transport: TransportKind;
  codec: string;
  deadline: string | null;
}

export interface LinkRejectedEvent {
  type: "link.Rejected";
  code: "version-incompatible";
  reason: "no-shared-minor" | "shared-minor-below-floor";
  componentId: string;
  providerId: string;
  interfaceId: string;
  floor: string;
}

export type MembraneEvent =
  | LinkEstablishedEvent
  | LinkCalledEvent
  | LinkRejectedEvent;

export interface WrpcLinkPort {
  registerComponent(c: ComponentRegistration): void;
  registerProvider(p: ProviderRegistration): void;
  establishLink(req: LinkRequest): EstablishedLink;
  callImport(
    componentId: string,
    importInterface: string,
    operation: string,
    payload?: JsonValue,
    options?: { deadline?: string | null },
  ): Promise<JsonValue>;
  readonly events: readonly MembraneEvent[];
}

export class NoRouteError extends Error {
  readonly code = "no-route" as const;
  readonly componentId: string;
  readonly importInterface: string;
  readonly routeKey: string;

  constructor({
    componentId,
    importInterface,
  }: {
    componentId: string;
    importInterface: string;
  }) {
    super(`wrpc.no_route: ${componentId}:${importInterface}`);
    this.name = "NoRouteError";
    this.componentId = componentId;
    this.importInterface = importInterface;
    this.routeKey = linkKey(componentId, importInterface);
  }
}

export class WireVersionIncompatibleError extends Error {
  readonly code = "version-incompatible" as const;
  readonly phase = "link-establishment" as const;
  readonly reason: "no-shared-minor" | "shared-minor-below-floor";
  readonly floor: string;
  readonly callerVersions: string[];
  readonly providerVersions: string[];
  readonly sharedVersions: string[];

  constructor({
    reason,
    componentId,
    providerId,
    interfaceId,
    floor,
    callerVersions,
    providerVersions,
    sharedVersions,
  }: {
    reason: "no-shared-minor" | "shared-minor-below-floor";
    componentId: string;
    providerId: string;
    interfaceId: string;
    floor: string;
    callerVersions: string[];
    providerVersions: string[];
    sharedVersions: string[];
  }) {
    super(`wrpc.version_incompatible: ${reason}`);
    this.name = "WireVersionIncompatibleError";
    this.reason = reason;
    this.floor = floor;
    this.callerVersions = callerVersions;
    this.providerVersions = providerVersions;
    this.sharedVersions = sharedVersions;
    Object.assign(this, { componentId, providerId, interfaceId });
  }
}

export function parseWireVersion(raw: string): WireVersion {
  if (!isJsonString(raw) || !SEMVER_RE.test(raw)) {
    throw new Error(`wrpc.invalid_semver: ${String(raw)}`);
  }
  const [core] = raw.split(/[+-]/, 1);
  const [major, minor, patch] = core.split(".").map(Number);
  return Object.freeze({ raw, major, minor, patch });
}

export function parseInterfaceId(raw: string): InterfaceId {
  if (!isJsonString(raw) || raw.length === 0) {
    throw new Error("wrpc.interface_id_required");
  }
  if (!INTERFACE_ID_RE.test(raw)) {
    throw new Error(`wrpc.invalid_interface_id: ${raw}`);
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return raw as InterfaceId;
}

export function linkKey(componentId: string, importInterface: string): string {
  return `${componentId}\0${importInterface}`;
}

export class ProviderHandlerStore {
  readonly #providers = new Map<string, ProviderRegistration>();

  register(provider: ProviderRegistration): void {
    this.#providers.set(provider.id, provider);
  }

  getHandler(
    providerId: string,
    exportInterface: string,
    operation: string,
  ): ProviderHandler | undefined {
    const provider = this.#providers.get(providerId);
    return provider?.handlers?.[exportInterface]?.[operation];
  }

  getProvider(providerId: string): ProviderRegistration | undefined {
    return this.#providers.get(providerId);
  }
}
