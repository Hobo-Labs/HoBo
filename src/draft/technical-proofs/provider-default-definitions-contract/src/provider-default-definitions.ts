const DEFAULT_EQUIVALENCE = {
  database: {
    resourceClass: "rds-aurora-postgres",
    driver: "terraform",
    satisfies: ["postgres", "managed", "ha"],
    options: { service: "aws:rds", engine: "postgres" }
  },
  objectStore: {
    resourceClass: "s3-bucket",
    driver: "terraform",
    satisfies: ["durable", "versioned"],
    options: { service: "aws:s3" }
  },
  compute: {
    resourceClass: "fargate-service",
    driver: "terraform",
    satisfies: ["container", "http"],
    options: { service: "aws:fargate" }
  }
};

const DEFAULT_CAPABILITIES = [
  { type: "database", satisfies: ["postgres", "managed"] },
  { type: "objectStore", satisfies: ["durable"] },
  { type: "compute", satisfies: ["container"] }
];

export function buildFixtureProvider(overrides = {}) {
  const equivalence = {
    ...DEFAULT_EQUIVALENCE,
    ...(overrides.equivalence)
  };
  const provider = {
    id: overrides.id ?? "aws",
    capabilities: structuredClone(overrides.capabilities ?? DEFAULT_CAPABILITIES),
    equivalence: structuredClone(equivalence),
    realize:
      overrides.realize ??
      ((type, equivalenceEntry) => ({
        type,
        resourceClass: equivalenceEntry.resourceClass,
        driver: equivalenceEntry.driver,
        with: equivalenceEntry.options ?? {}
      }))
  };

  return provider;
}

export function createDefinitionCatalog(definitions = []) {
  return { definitions: structuredClone(definitions) };
}

export function defineResource(definition) {
  return {
    source: "platform-defined",
    priority: 0,
    match: {},
    satisfies: [],
    ...structuredClone(definition)
  };
}

export function registerProviderDefaults(provider) {
  const validation = validateProviderDefaults(provider);
  if (!validation.ok) {
    return { provider: provider.id, definitions: [], errors: validation.errors };
  }

  const definitions = provider.capabilities
    .map((capability) => {
      const equivalence = provider.equivalence[capability.type];
      if (!equivalence) {
        return null;
      }
      const realized = provider.realize(capability.type, equivalence);

      return defineResource({
        id: `${provider.id}.default.${capability.type}`,
        source: "provider-default",
        type: capability.type,
        provider: provider.id,
        driver: realized.driver,
        resourceClass: realized.resourceClass,
        satisfies: equivalence.satisfies,
        with: realized.with,
        match: {},
        equivalence: {
          providerResourceClass: equivalence.resourceClass
        },
        realization: {
          resourceClass: realized.resourceClass,
          driver: realized.driver,
          with: realized.with
        }
      });
    })
    .filter(Boolean);

  return { provider: provider.id, definitions, errors: [] };
}

export function register(provider, catalog = createDefinitionCatalog()) {
  const registration = registerProviderDefaults(provider);
  if (registration.errors.length === 0) {
    catalog.definitions.push(...registration.definitions);
  }

  return { ...registration, catalog };
}

export function validateProviderDefaults(provider) {
  const errors = [];
  const capabilityCounts = new Map();

  for (const capability of provider.capabilities ?? []) {
    capabilityCounts.set(capability.type, (capabilityCounts.get(capability.type) ?? 0) + 1);
  }

  for (const [type, count] of capabilityCounts) {
    if (count > 1) {
      errors.push(`duplicate default Resource Definition for ${type}`);
    }
  }

  for (const [type, equivalence] of Object.entries(provider.equivalence ?? {})) {
    const capability = (provider.capabilities ?? []).find((entry) => entry.type === type);
    if (!capability) {
      errors.push(`${type} equivalence is not declared as a provider capability`);
      continue;
    }

    const missingSatisfies = (capability.satisfies ?? []).filter(
      (required) => !(equivalence.satisfies ?? []).includes(required)
    );
    if (missingSatisfies.length > 0) {
      errors.push(`${type} equivalence cannot satisfy required capability facts: ${missingSatisfies.join(", ")}`);
    }

    const realized = provider.realize?.(type, equivalence);
    if (!realized?.resourceClass) {
      errors.push(`${type} realize output missing resourceClass`);
    } else if (realized.resourceClass !== equivalence.resourceClass) {
      errors.push(
        `${type} realize emitted ${realized.resourceClass}, but equivalence declares ${equivalence.resourceClass}`
      );
    }

    if (!realized?.driver) {
      errors.push(`${type} realize output missing driver`);
    } else if (realized.driver !== equivalence.driver) {
      errors.push(`${type} realize emitted driver ${realized.driver}, but equivalence declares ${equivalence.driver}`);
    }

    if (!Object.hasOwn(realized ?? {}, "with")) {
      errors.push(`${type} realize output missing with options`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function selectFromCatalogWithControlPlaneScorer(request, catalog, context) {
  return selectResourceDefinition(request, catalog.definitions, context);
}

function selectResourceDefinition(request, definitions, context) {
  const viable = definitions
    .filter((definition) => definition.type === request.type)
    .filter((definition) => criteriaMatch(definition.match ?? {}, context))
    .filter((definition) => satisfiesRequire(definition.satisfies ?? [], request.require ?? []))
    .map((definition) => ({
      ...definition,
      matchScore: Object.keys(definition.match ?? {}).length
    }));

  viable.sort((left, right) => {
    if (right.matchScore !== left.matchScore) return right.matchScore - left.matchScore;
    if ((right.priority ?? 0) !== (left.priority ?? 0)) return (right.priority ?? 0) - (left.priority ?? 0);
    return left.id.localeCompare(right.id);
  });

  const [winner, ...rejected] = viable;
  const second = rejected[0];
  return {
    winner: winner ?? null,
    rejected,
    tie: Boolean(
      winner &&
        second &&
        winner.matchScore === second.matchScore &&
        (winner.priority ?? 0) === (second.priority ?? 0)
    )
  };
}

export function remediationForUnsupportedPort(provider, port) {
  return {
    provider,
    port,
    code: "provider-capability-missing",
    message: `Provider ${provider} does not ship a default Resource Definition for ${port}`
  };
}

function criteriaMatch(match, context) {
  return Object.entries(match).every(([key, expected]) => context[key] === expected);
}

function satisfiesRequire(satisfies, required) {
  return required.every((item) => satisfies.includes(item));
}
