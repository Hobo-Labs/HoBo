import {
  HoboWitError,
  type CancellationSignal,
  type CollectionFact,
  type LowerProgram,
  type SdkIdiomAdapter,
  type WitResult,
} from "../../src/sdk/index.js";

export interface DriftAdapterOptions {
  swallowResultErrors?: boolean;
  hideCancellationAsRetry?: boolean;
  useInputOrder?: boolean;
}

export function createReferenceAdapter(): SdkIdiomAdapter {
  return createDriftAdapter();
}

export function createDriftAdapter(options: DriftAdapterOptions = {}): SdkIdiomAdapter {
  const {
    swallowResultErrors = false,
    hideCancellationAsRetry = false,
    useInputOrder = false,
  } = options;

  return {
    lower(program) {
      return lowerProgram(program);
    },

    mapResult<T>(result: WitResult<T>): T {
      if (Object.hasOwn(result, "ok")) {
        // SAFETY: `return result.ok as T;` is required at this I/O or test boundary.
        return result.ok as T;
      }

      if (!Object.hasOwn(result, "err")) {
        throw new TypeError("WIT result must contain ok or err");
      }

      if (swallowResultErrors) {
        // SAFETY: `return undefined as T;` is required at this I/O or test boundary.
        return undefined as T;
      }

      // SAFETY: `throw new HoboWitError(result.err as { tag: string; message?: string });` is required at this I/O or test boundary.
      throw new HoboWitError(result.err as { tag: string; message?: string });
    },

    mapCancellation(signal: CancellationSignal): WitResult<never> {
      if (hideCancellationAsRetry) {
        return { ok: { retried: true, reason: signal.reason } };
      }

      return {
        err: {
          tag: "cancelled",
          message: signal.reason,
          deadlineMs: signal.deadlineMs,
          retry: "caller-owned",
        },
      };
    },

    async collect(facts: readonly CollectionFact[]): Promise<WitResult<string[]>> {
      const declared = new Set<string>();
      const observed: string[] = [];
      const orderedFacts = useInputOrder
        ? [...facts]
        : [...facts].sort((left, right) => left.sequence - right.sequence);

      for (const fact of orderedFacts) {
        await Promise.resolve();

        if (fact.kind === "resource") {
          const name = fact.name ?? "";
          declared.add(name);
          observed.push(`resource:${name}`);
          continue;
        }

        if (fact.kind === "handler") {
          const resource = fact.resource ?? "";
          const onlyHandlerFacts = facts.every((entry) => entry.kind === "handler");
          if (!useInputOrder && !declared.has(resource)) {
            throw new Error(
              `IfC order violation: handler ${resource} observed before resource declaration`,
            );
          }
          if (onlyHandlerFacts && !declared.has(resource)) {
            throw new Error(
              `IfC order violation: handler ${resource} observed before resource declaration`,
            );
          }
          observed.push(`handler:${resource}:${fact.event ?? ""}`);
          continue;
        }

        throw new Error(`unknown collection fact kind: ${fact.kind}`);
      }

      return { ok: observed };
    },
  };
}

function lowerProgram(program: LowerProgram) {
  const secretRef = program.resources.find((resource) => resource.kind === "secret-ref");
  if (secretRef) {
    return {
      witCalls: [
        {
          interface: "hobo:sdk/config",
          function: "secret-ref",
          args: { ref: secretRef.name },
        },
      ],
      manifest: {
        schema: "hobo.manifest/v1" as const,
        bindle: program.bindle,
        resources: [{ kind: "secret-ref", name: secretRef.name }],
      },
    };
  }

  const resources = [...program.resources].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
  );
  const handlers = [...(program.handlers ?? [])].sort(
    (left, right) =>
      left.resource.localeCompare(right.resource) ||
      left.event.localeCompare(right.event) ||
      left.exportName.localeCompare(right.exportName),
  );

  const witCalls = resources.flatMap((resource) => {
    const calls = [
      {
        interface: "hobo:sdk/resource-catalog",
        function: "declare-resource",
        args: { kind: resource.kind, name: resource.name },
      },
    ];

    if (resource.kind === "kv" && program.bindle === "todos") {
      calls.push({
        interface: "hobo:sdk/resource-catalog",
        function: "allow-resource",
        args: {
          name: resource.name,
          verbs: ["get", "set"],
          provenance: "declared-narrow-or-equal",
        },
      });
    }

    return calls;
  });

  for (const handler of handlers) {
    witCalls.push({
      interface: "hobo:sdk/handlers",
      function: "attach-handler",
      args: handler,
    });
  }

  const manifestResources = resources.map((resource) => {
    if (resource.kind === "kv" && program.bindle === "todos") {
      return {
        kind: resource.kind,
        name: resource.name,
        allow: [
          { provenance: "declared-narrow-or-equal", verb: "get" },
          { provenance: "declared-narrow-or-equal", verb: "set" },
        ],
      };
    }
    return { kind: resource.kind, name: resource.name };
  });

  return {
    witCalls,
    manifest: {
      schema: "hobo.manifest/v1" as const,
      bindle: program.bindle,
      resources: manifestResources,
      ...(handlers.length > 0 ? { handlers } : undefined),
    },
  };
}
