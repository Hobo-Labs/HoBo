import { isJsonObject, isJsonString } from "./json.js";
export type ResourceVerb = string;

export type AllowFacts = {
  declaredAllow?: readonly ResourceVerb[];
  dynamicAllow?: readonly ResourceVerb[];
  dynamicReason?: string;
};

export type ResourceHandle<_V extends ResourceVerb = ResourceVerb> = {
  readonly kind: string;
  readonly name: string;
  readonly port: string;
  readonly catalogVerbs: readonly ResourceVerb[];
  readonly facts: AllowFacts;
  allow<const W extends readonly ResourceVerb[]>(
    ...verbs: W
  ): ResourceHandle<W[number]>;
  allow<const W extends readonly ResourceVerb[]>(
    options: { dynamic: true; reason: string },
    ...verbs: W
  ): ResourceHandle<W[number]>;
};

export function createResourceHandle(input: {
  kind: string;
  name: string;
  port: string;
  catalogVerbs: readonly ResourceVerb[];
  facts?: AllowFacts;
}): ResourceHandle {
  const facts: AllowFacts = { ...input.facts };

  function allow<const W extends readonly ResourceVerb[]>(
    ...args:
      | W
      | [{ dynamic: true; reason: string }, ...W]
  ): ResourceHandle<W[number]> {
    if (args.length === 0) {
      throw new TypeError(".allow() requires at least one verb; omit the call instead.");
    }

    const first = args[0];
    if (
      isJsonObject(first) &&
      first !== null &&
      "dynamic" in first &&
      first.dynamic === true
    ) {
      const options = first;
      const rest = args.slice(1);
      // SAFETY: remaining args after the dynamic option bag are the verb list.
      const verbs: W = rest as never;
      if (verbs.length === 0) {
        throw new TypeError(".allow() requires at least one verb; omit the call instead.");
      }
      if (!isJsonString(options.reason) || options.reason.trim().length === 0) {
        throw new TypeError("dynamic .allow() grants require a non-empty reason.");
      }
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      return createResourceHandle({
        ...input,
        facts: {
          ...facts,
          dynamicAllow: [...verbs],
          dynamicReason: options.reason,
          declaredAllow: [...verbs],
        },
      }) as ResourceHandle<W[number]>;
    }

    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    // SAFETY: non-dynamic .allow() args are the verb list.
    const verbs: W = args as never;
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    return createResourceHandle({
      ...input,
      facts: {
        ...facts,
        declaredAllow: [...verbs],
      },
    }) as ResourceHandle<W[number]>;
  }

  return {
    kind: input.kind,
    name: input.name,
    port: input.port,
    catalogVerbs: input.catalogVerbs,
    facts,
    allow,
  };
}
