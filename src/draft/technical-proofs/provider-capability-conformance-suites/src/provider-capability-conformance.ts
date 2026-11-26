const SEED_CAPABILITIES = Object.freeze([
  "cache",
  "compute",
  "database",
  "dns",
  "objectStore",
  "queue"
]);

const LOCAL_CHECKS = Object.freeze([
  "provision-connects",
  "honors-require-prefer",
  "refresh-reports-drift",
  "destroy-cleans-state"
]);

const CAMP_CHECKS = Object.freeze([
  "real-provider-drift",
  "iam-mtls-quota-evidence"
]);

export function listSeedProviderSuites() {
  return SEED_CAPABILITIES.map((capability) => ({
    capability,
    suite: `@hobo/conformance/provider-capability/${capability}`,
    version: "0.1.0",
    tags: ["local", "camp"],
    checks: [
      ...LOCAL_CHECKS.map((name) => ({ id: `${capability}.local.${name}`, tag: "local" })),
      ...CAMP_CHECKS.map((name) => ({ id: `${capability}.camp.${name}`, tag: "camp" }))
    ]
  }));
}

export function runProviderCapabilitySuites(provider, {
  capabilities = provider?.manifest?.claimedCapabilities ?? [],
  tags = ["local", "camp"]
} = {}) {
  const suites = new Map(listSeedProviderSuites().map((suite) => [suite.capability, suite]));
  const failures = [];
  const executed = [];
  const requestedTags = new Set(tags);

  for (const capability of capabilities) {
    const suite = suites.get(capability);
    if (!suite) {
      failures.push({
        capability,
        checkId: `${capability}.suite.exists`,
        tag: "coverage",
        message: `claimed capability ${capability} has no provider-capability suite`
      });
      continue;
    }

    if (requestedTags.has("local")) {
      runLocalSuite(provider, capability, failures, executed);
    }
    if (requestedTags.has("camp")) {
      runCampSuite(provider, capability, failures, executed);
    }
  }

  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    checks: executed,
    coverage: summarizeCoverage(executed, failures, capabilities, requestedTags)
  };
}

export function hoboVerify(provider, {
  capabilities = provider?.manifest?.claimedCapabilities ?? [],
  runTags = ["local"],
  claimProdReady = false
} = {}) {
  const run = runProviderCapabilitySuites(provider, { capabilities, tags: runTags });
  const suites = new Set(SEED_CAPABILITIES);
  const missingSuites = capabilities
    .filter((capability) => !suites.has(capability))
    .sort()
    .map((capability) => ({
      capability,
      message: `claimed capability ${capability} has no provider-capability suite`
    }));
  const localUnrun = !runTags.includes("local");
  const campUnrun = !runTags.includes("camp");
  const prodReady = claimProdReady
    ? prodReadyStatus({ localUnrun, campUnrun, missingSuites, run })
    : { status: "not-claimed", message: "prod readiness was not requested" };

  return {
    status: run.status === "pass" && missingSuites.length === 0 && prodReady.status !== "blocked"
      ? "pass"
      : "fail",
    coverage: {
      ...run.coverage,
      missingSuites
    },
    prodReady,
    failures: run.failures
  };
}

export function createReferenceLocalProvider({
  claimedCapabilities = ["database", "objectStore", "compute"],
  campBehavior = "unrun"
} = {}) {
  return new FixtureProvider({ claimedCapabilities, campBehavior });
}

export function createBrokenProvider(options = {}) {
  return new FixtureProvider({
    claimedCapabilities: ["database"],
    ...options
  });
}

export function createFlakyProvider() {
  return new FixtureProvider({
    claimedCapabilities: ["database"],
    refreshSequence: [true, false, true]
  });
}

function runLocalSuite(provider, capability, failures, executed) {
  const resource = tryCheck({
    failures,
    executed,
    capability,
    tag: "local",
    name: "provision-connects",
    fn: () => {
      const provisioned = provider.provision(capability, {
        require: { region: "local" },
        prefer: { durability: "ephemeral" }
      });
      const client = provider.client(capability, provisioned);
      if (client.ping() !== `${capability}:ok`) {
        throw new Error("agnostic client must connect to the provisioned resource");
      }
      return provisioned;
    }
  });

  tryCheck({
    failures,
    executed,
    capability,
    tag: "local",
    name: "honors-require-prefer",
    fn: () => {
      const decision = provider.negotiate(capability, {
        require: { region: "local" },
        prefer: { durability: "ephemeral" }
      });
      if (!decision.requireSatisfied) {
        throw new Error("require hints must be enforced, not ignored");
      }
      if (!decision.preferHonored.includes("durability")) {
        throw new Error("prefer hints must be recorded as honored or rejected");
      }
    }
  });

  if (resource) {
    provider.injectDrift(resource.id);
    tryCheck({
      failures,
      executed,
      capability,
      tag: "local",
      name: "refresh-reports-drift",
      fn: () => {
        const first = provider.refresh(resource.id);
        const second = provider.refresh(resource.id);
        if (!first.drift || !second.drift) {
          throw new Error("refresh must report injected drift deterministically");
        }
      }
    });

    tryCheck({
      failures,
      executed,
      capability,
      tag: "local",
      name: "destroy-cleans-state",
      fn: () => {
        provider.destroy(resource.id);
        if (provider.hasResource(resource.id)) {
          throw new Error("destroy must remove provisioned state");
        }
      }
    });
  }
}

function runCampSuite(provider, capability, failures, executed) {
  tryCheck({
    failures,
    executed,
    capability,
    tag: "camp",
    name: "real-provider-drift",
    fn: () => {
      const evidence = provider.campEvidence(capability);
      if (!evidence.realProviderDrift) {
        throw new Error("camp evidence must prove real-provider drift detection");
      }
    }
  });

  tryCheck({
    failures,
    executed,
    capability,
    tag: "camp",
    name: "iam-mtls-quota-evidence",
    fn: () => {
      const evidence = provider.campEvidence(capability);
      if (!evidence.iam || !evidence.mtls || !evidence.quota) {
        throw new Error("camp evidence must include IAM, mTLS, and quota checks");
      }
    }
  });
}

function tryCheck({ failures, executed, capability, tag, name, fn }) {
  const checkId = `${capability}.${tag}.${name}`;
  try {
    const result = fn();
    executed.push({ capability, tag, checkId, status: "pass" });
    return result;
  } catch (error) {
    failures.push({
      capability,
      tag,
      checkId,
      message: error instanceof Error ? error.message : String(error)
    });
    executed.push({ capability, tag, checkId, status: "fail" });
    return null;
  }
}

function summarizeCoverage(executed, failures, capabilities, requestedTags) {
  return {
    local: summarizeTag(executed, "local", requestedTags),
    camp: summarizeTag(executed, "camp", requestedTags),
    failed: failures.length,
    requestedCapabilities: [...capabilities].sort()
  };
}

function summarizeTag(executed, tag, requestedTags) {
  const checks = executed.filter((check) => check.tag === tag);
  if (!requestedTags.has(tag)) {
    return {
      status: "unrun",
      capabilities: [],
      passed: 0,
      failed: 0,
      total: 0
    };
  }
  return {
    status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
    capabilities: [...new Set(checks.map((check) => check.capability))].sort(),
    passed: checks.filter((check) => check.status === "pass").length,
    failed: checks.filter((check) => check.status === "fail").length,
    total: checks.length
  };
}

function prodReadyStatus({ localUnrun, campUnrun, missingSuites, run }) {
  if (missingSuites.length > 0) {
    return {
      status: "blocked",
      message: "prod-ready claim refused because claimed capabilities lack suites"
    };
  }
  if (localUnrun) {
    return {
      status: "blocked",
      message: "prod-ready claim refused because local checks are unrun"
    };
  }
  if (campUnrun) {
    return {
      status: "blocked",
      message: "prod-ready claim refused because camp checks are unrun"
    };
  }
  if (run.status !== "pass") {
    return {
      status: "blocked",
      message: "prod-ready claim refused because conformance checks failed"
    };
  }
  return {
    status: "pass",
    message: "local and camp coverage are green"
  };
}

class FixtureProvider {
  constructor({
    claimedCapabilities,
    destroyLeaksState = false,
    refreshNeverReportsDrift = false,
    refreshSequence = null,
    campBehavior = "unrun"
  }) {
    this.manifest = { claimedCapabilities };
    this.destroyLeaksState = destroyLeaksState;
    this.refreshNeverReportsDrift = refreshNeverReportsDrift;
    this.refreshSequence = refreshSequence ? [...refreshSequence] : null;
    this.campBehavior = campBehavior;
    this.resources = new Map();
    this.nextId = 0;
  }

  provision(capability, plan) {
    this.assertCapability(capability);
    const id = `${capability}-${++this.nextId}`;
    const resource = {
      id,
      capability,
      plan,
      drift: false
    };
    this.resources.set(id, resource);
    return resource;
  }

  client(capability, resource) {
    this.assertCapability(capability);
    if (!this.resources.has(resource.id)) {
      throw new Error(`resource ${resource.id} is not provisioned`);
    }
    return {
      ping: () => `${capability}:ok`
    };
  }

  negotiate(capability, hints) {
    this.assertCapability(capability);
    return {
      requireSatisfied: hints?.require?.region === "local",
      preferHonored: hints?.prefer?.durability ? ["durability"] : []
    };
  }

  injectDrift(id) {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new Error(`cannot drift missing resource ${id}`);
    }
    resource.drift = true;
  }

  refresh(id) {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new Error(`cannot refresh missing resource ${id}`);
    }
    if (this.refreshSequence) {
      return { drift: Boolean(this.refreshSequence.shift()) };
    }
    return { drift: this.refreshNeverReportsDrift ? false : resource.drift };
  }

  destroy(id) {
    if (!this.resources.has(id)) {
      throw new Error(`cannot destroy missing resource ${id}`);
    }
    if (!this.destroyLeaksState) {
      this.resources.delete(id);
    }
  }

  hasResource(id) {
    return this.resources.has(id);
  }

  campEvidence(capability) {
    this.assertCapability(capability);
    if (this.campBehavior === "pass") {
      return {
        realProviderDrift: true,
        iam: true,
        mtls: true,
        quota: true
      };
    }
    return {
      realProviderDrift: false,
      iam: false,
      mtls: false,
      quota: false
    };
  }

  assertCapability(capability) {
    if (!this.manifest.claimedCapabilities.includes(capability)) {
      throw new Error(`provider does not claim ${capability}`);
    }
  }
}
