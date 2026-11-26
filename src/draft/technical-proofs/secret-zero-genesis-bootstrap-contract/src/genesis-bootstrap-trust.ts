const issuerUrl = "https://identity.acme-yard.example";
const rootKeyId = "yard-root-2026-06";
const discoveryFingerprint = "sha256:genesis-discovery";
const seedCredentialId = "seed-bootstrap-1";

export function baseGenesisBootstrapTrace() {
  return [
    {
      seq: 10,
      type: "issuer.urlPinned",
      issuerUrl,
      discoveryFingerprint
    },
    {
      seq: 20,
      type: "kms.rootGenerated",
      keyId: rootKeyId,
      keyRole: "svid-oidc-root",
      custody: "target-kms",
      generatedBy: "target-kms",
      exportable: false,
      publicKeyThumbprint: "sha256:root-public-key"
    },
    {
      seq: 30,
      type: "seed.credentialIssued",
      credentialId: seedCredentialId,
      delegated: true,
      durableRoot: false,
      canSignRoot: false
    },
    {
      seq: 40,
      type: "provider.federationConfigured",
      issuerUrl,
      discoveryFingerprint,
      rootKeyId
    },
    {
      seq: 50,
      type: "yard.selfDeploy",
      issuerUrl,
      rootKeyId
    },
    {
      seq: 60,
      type: "seed.credentialDestroyed",
      credentialId: seedCredentialId
    },
    {
      seq: 70,
      type: "handoff.completed",
      issuerUrl,
      rootKeyId,
      seedCredentialId
    }
  ];
}

export function validateGenesisBootstrapTrace(events) {
  const trace = normalizeTrace(events);
  const violations = [];

  const issuerPinned = first(trace, "issuer.urlPinned");
  const rootGenerated = trace.find(
    (event) => event.type === "kms.rootGenerated" && event.keyRole === "svid-oidc-root"
  );
  const seedIssued = first(trace, "seed.credentialIssued");
  const providerFederation = first(trace, "provider.federationConfigured");
  const selfDeploy = first(trace, "yard.selfDeploy");
  const seedDestroyed = first(trace, "seed.credentialDestroyed");
  const handoff = first(trace, "handoff.completed");
  const knownRootKeyId = rootGenerated?.keyId ?? selfDeploy?.rootKeyId ?? providerFederation?.rootKeyId;
  const pinnedIssuerUrl = issuerPinned?.issuerUrl;
  const pinnedDiscovery = issuerPinned?.discoveryFingerprint;

  if (!issuerPinned) {
    add(violations, "missing-genesis-issuer-pin", "issuer URL must be fixed from genesis");
  }
  if (!rootGenerated) {
    add(violations, "missing-kms-root-generation", "durable root key must be generated in target KMS");
  } else if (
    rootGenerated.custody !== "target-kms" ||
    rootGenerated.generatedBy !== "target-kms" ||
    rootGenerated.exportable !== false
  ) {
    add(
      violations,
      "root-key-outside-target-kms",
      "durable root key material must never leave target KMS custody",
      rootGenerated
    );
  }

  if (seedIssued && (seedIssued.durableRoot || seedIssued.canSignRoot || seedIssued.delegated !== true)) {
    add(
      violations,
      "seed-holds-durable-root",
      "seed credential must be delegated and must not hold durable signing authority",
      seedIssued
    );
  }
  if (!seedIssued) {
    add(violations, "missing-seed-delegation", "genesis must issue a delegated seed credential");
  }

  if (!providerFederation) {
    add(
      violations,
      "missing-provider-federation",
      "genesis trace must include provider federation against the pinned issuer"
    );
  } else {
    if (!issuerPinned || issuerPinned.seq > providerFederation.seq) {
      add(
        violations,
        "issuer-not-pinned-before-federation",
        "provider federation must consume the genesis-pinned issuer URL",
        providerFederation
      );
    }
    if (
      providerFederation.issuerUrl !== pinnedIssuerUrl ||
      providerFederation.discoveryFingerprint !== pinnedDiscovery
    ) {
      add(
        violations,
        "provider-federated-unpinned-issuer",
        "provider federation must match the pinned issuer URL and discovery fingerprint",
        providerFederation
      );
    }
  }

  if (!selfDeploy) {
    add(violations, "missing-self-deploy", "genesis trace must include seed to self-deploy handoff");
  }
  if (rootGenerated && selfDeploy && rootGenerated.seq > selfDeploy.seq) {
    add(
      violations,
      "root-not-generated-before-self-deploy",
      "target KMS root must exist before the seed Yard self-deploys",
      selfDeploy
    );
  }

  if (selfDeploy) {
    if (
      selfDeploy.issuerUrl !== pinnedIssuerUrl ||
      selfDeploy.rootKeyId !== knownRootKeyId ||
      selfDeploy.regenerateRoot ||
      selfDeploy.rotateRoot ||
      selfDeploy.newRootKeyId
    ) {
      add(
        violations,
        "self-deploy-root-regeneration",
        "self-deploy must preserve the genesis issuer URL and root key",
        selfDeploy
      );
    }
  }

  if (!handoff) {
    add(violations, "missing-handoff-completion", "genesis trace must complete identity handoff");
  }
  if (seedIssued && !seedDestroyed) {
    add(violations, "missing-seed-destruction", "seed credential must be destroyed during handoff");
  }
  if (seedIssued && handoff && (!seedDestroyed || seedDestroyed.seq > handoff.seq)) {
    add(
      violations,
      "seed-not-destroyed-before-handoff",
      "seed credential must be destroyed before handoff completes",
      handoff
    );
  }

  for (const event of trace) {
    if (leaksRootMaterial(event, knownRootKeyId)) {
      add(
        violations,
        "root-key-material-leaked",
        "genesis trace must not write durable root material to disk or logs",
        event
      );
    }

    if (event.type === "seed.signingAttempt" && event.credentialId === seedIssued?.credentialId) {
      const afterSelfDeploy = selfDeploy && event.seq > selfDeploy.seq;
      const afterSeedDestroyed = seedDestroyed && event.seq > seedDestroyed.seq;
      const afterHandoff = handoff && event.seq > handoff.seq;
      if (afterSelfDeploy || afterSeedDestroyed || afterHandoff) {
        add(
          violations,
          "captured-seed-credential-post-handoff",
          "captured seed credential must be unusable after self-deploy handoff",
          event
        );
      }
    }

    if (event.type === "issuer.discoveryPublished" && event.issuerUrl === pinnedIssuerUrl) {
      const beforeFederation = !providerFederation || event.seq < providerFederation.seq;
      if (beforeFederation && event.discoveryFingerprint !== pinnedDiscovery) {
        add(
          violations,
          "rogue-issuer-discovery-before-federation",
          "from-genesis issuer pin must reject rogue discovery before provider federation",
          event
        );
      }
    }

    if (event.type === "issuer.instanceCreated" && event.issuerUrl === pinnedIssuerUrl) {
      const mismatchedRoot = event.rootKeyId && event.rootKeyId !== knownRootKeyId;
      const mismatchedDiscovery =
        event.discoveryFingerprint && event.discoveryFingerprint !== pinnedDiscovery;
      if (mismatchedRoot || mismatchedDiscovery) {
        add(
          violations,
          "second-issuer-at-pinned-url",
          "a second issuer at the pinned URL would break established provider trust",
          event
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    evidence: {
      rootKeyId: knownRootKeyId,
      rootKeyCustody: rootGenerated?.custody,
      issuerUrl: pinnedIssuerUrl,
      issuerPinnedBeforeFederation: Boolean(
        issuerPinned && providerFederation && issuerPinned.seq < providerFederation.seq
      ),
      seedCredentialDestroyed: Boolean(
        seedIssued && seedDestroyed && (!handoff || seedDestroyed.seq < handoff.seq)
      ),
      providerFederationEstablished: Boolean(providerFederation),
      selfDeployPreservedRoot: Boolean(
        selfDeploy &&
          selfDeploy.issuerUrl === pinnedIssuerUrl &&
          selfDeploy.rootKeyId === knownRootKeyId &&
          !selfDeploy.regenerateRoot &&
          !selfDeploy.rotateRoot &&
          !selfDeploy.newRootKeyId
      ),
      rootMaterialSurfaces: trace.filter((event) => leaksRootMaterial(event, knownRootKeyId)).map(leakSurface)
    }
  };
}

function normalizeTrace(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("genesis bootstrap trace must be an array");
  }

  return [...events].sort((left, right) => left.seq - right.seq);
}

function first(trace, type) {
  return trace.find((event) => event.type === type);
}

function add(violations, code, message, event) {
  violations.push({
    code,
    message,
    seq: event?.seq
  });
}

function leaksRootMaterial(event, knownRootKeyId) {
  const hasRootNamedMaterial =
    event.rootPrivateKeyMaterial !== undefined || event.rawRootPrivateKey !== undefined;
  const rootRelated = hasRootNamedMaterial || event.type.startsWith("root.") || event.keyId === knownRootKeyId;
  const hasPrivateMaterial =
    event.type === "root.materialObserved" ||
    hasRootNamedMaterial ||
    event.privateKeyMaterial !== undefined ||
    event.rawPrivateKey !== undefined;

  return rootRelated && hasPrivateMaterial;
}

function leakSurface(event) {
  if (event.surface) {
    return event.surface;
  }
  if (event.type.includes("log")) {
    return "log";
  }
  return "trace";
}
