import { createInProcessTransport } from "./in-process-transport.js";
import {
  NoRouteError,
  ProviderHandlerStore,
  WireVersionIncompatibleError,
  linkKey,
  parseInterfaceId,
  parseWireVersion,
  type ComponentRegistration,
  type EstablishedLink,
  type LinkRequest,
  type MembraneEvent,
  type ProviderRegistration,
  type WrpcLinkPort,
  type WrpcTransport,
} from "./ports.js";
import { negotiateWireVersion } from "./wire-version.js";
import { isJsonString, isJsonObject, type JsonValue } from "./json.js";


type IndexedPins = Map<
  string,
  ComponentRegistration["imports"][number] | ProviderRegistration["exports"][number]
>;

function indexPins(
  pins: ComponentRegistration["imports"] | ProviderRegistration["exports"],
): IndexedPins {
  const indexed: IndexedPins = new Map();
  for (const pin of pins) {
    indexed.set(pin.interfaceId, pin);
  }
  return indexed;
}

function assertId(id: string | undefined, kind: string): asserts id is string {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`wrpc.${kind}_id_required`);
  }
}

export function createWrpcLinkLayer(options: {
  transport: WrpcTransport;
  compatibilityFloor: string;
  store?: ProviderHandlerStore;
}): WrpcLinkPort {
  const floor = parseWireVersion(options.compatibilityFloor);
  const store = options.store ?? new ProviderHandlerStore();
  const transport = options.transport;
  const codec =
    "codec" in transport && isJsonObject(transport.codec) ? transport.codec : undefined;
  const namedCodec: { name?: JsonValue } =
    // SAFETY: transport.codec is a host codec bag when present.
    codec as never;
  const codecName = isJsonString(namedCodec.name) ? namedCodec.name : "unknown";

  const components = new Map<string, { id: string; imports: IndexedPins }>();
  const providers = new Map<string, { id: string; exports: IndexedPins }>();
  const links = new Map<string, EstablishedLink>();
  const events: MembraneEvent[] = [];

  return {
    registerComponent(component: ComponentRegistration) {
      assertId(component?.id, "component");
      components.set(component.id, {
        id: component.id,
        imports: indexPins(component.imports),
      });
    },

    registerProvider(provider: ProviderRegistration) {
      assertId(provider?.id, "provider");
      providers.set(provider.id, {
        id: provider.id,
        exports: indexPins(provider.exports),
      });
      store.register(provider);
    },

    establishLink(request: LinkRequest): EstablishedLink {
      const component = components.get(request.componentId);
      if (!component) {
        throw new Error(`wrpc.component_not_registered: ${request.componentId}`);
      }
      const provider = providers.get(request.providerId);
      if (!provider) {
        throw new Error(`wrpc.provider_not_registered: ${request.providerId}`);
      }

      const importInterface = parseInterfaceId(request.importInterface);
      const exportInterface = parseInterfaceId(request.exportInterface);
      const imported = component.imports.get(importInterface);
      const exported = provider.exports.get(exportInterface);
      if (!imported) {
        throw new Error(
          `wrpc.import_not_declared: ${request.componentId}:${importInterface}`,
        );
      }
      if (!exported) {
        throw new Error(
          `wrpc.export_not_found: ${request.providerId}:${exportInterface}`,
        );
      }

      try {
        const negotiatedWire = negotiateWireVersion({
          caller: imported,
          provider: exported,
          floor,
          componentId: request.componentId,
          providerId: request.providerId,
        });
        const link = Object.freeze({
          componentId: request.componentId,
          importInterface,
          providerId: request.providerId,
          exportInterface,
          transport: transport.kind,
          boundaryMode: "live" as const,
          negotiatedWire,
        });
        links.set(linkKey(request.componentId, importInterface), link);
        events.push({
          type: "link.Established",
          componentId: link.componentId,
          importInterface: link.importInterface,
          providerId: link.providerId,
          exportInterface: link.exportInterface,
          transport: link.transport,
          boundaryMode: link.boundaryMode,
          negotiatedWire: link.negotiatedWire,
        });
        return link;
      } catch (error) {
        if (error instanceof WireVersionIncompatibleError) {
          events.push({
            type: "link.Rejected",
            code: error.code,
            reason: error.reason,
            componentId: request.componentId,
            providerId: request.providerId,
            interfaceId: importInterface,
            floor: floor.raw,
          });
        }
        throw error;
      }
    },

    async callImport(
      componentId: string,
      importInterface: string,
      operation: string,
      payload: JsonValue = {},
      options: { deadline?: string | null } = {},
    ): Promise<JsonValue> {
      if (!components.has(componentId)) {
        throw new Error(`wrpc.component_not_registered: ${componentId}`);
      }
      const parsedInterface = parseInterfaceId(importInterface);
      const link = links.get(linkKey(componentId, parsedInterface));
      if (!link) {
        throw new NoRouteError({ componentId, importInterface: parsedInterface });
      }

      const result = await transport.invoke({
        link,
        operation,
        payload,
        deadline: options.deadline ?? null,
      });

      events.push({
        type: "link.Called",
        componentId: link.componentId,
        importInterface: link.importInterface,
        providerId: link.providerId,
        exportInterface: link.exportInterface,
        operation,
        boundaryMode: link.boundaryMode,
        transport: link.transport,
        codec: codecName,
        deadline: options.deadline ?? null,
      });
      return result;
    },

    get events() {
      return events;
    },
  };
}

export function createDefaultWrpcLinkLayer(compatibilityFloor: string): WrpcLinkPort {
  const store = new ProviderHandlerStore();
  const transport = createInProcessTransport({ store });
  return createWrpcLinkLayer({ transport, compatibilityFloor, store });
}
