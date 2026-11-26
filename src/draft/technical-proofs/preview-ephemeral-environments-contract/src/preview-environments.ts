const DEFAULT_TTL_HOURS = 72;
const DEFAULT_HARD_CEILING_HOURS = 96;

export function openPullRequestPreview(request, options = {}) {
  const normalized = normalizeRequest(request);
  const now = toDate(options.now ?? new Date());
  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;
  const hardCeilingHours = options.hardCeilingHours ?? Math.max(DEFAULT_HARD_CEILING_HOURS, ttlHours);
  const generation = options.generation ?? 1;
  const campId = previewCampId(normalized);
  const streamId = `stream:${campId}`;
  const baselineStreamId = normalized.baselineStreamId ?? `stream:${normalized.baselineCampId}`;
  const ttlExpiresAt = addHours(now, ttlHours).toISOString();
  const hardExpiresAt = addHours(now, hardCeilingHours).toISOString();
  const previewUrl = previewUrlFor(normalized, options.urlBase ?? "https://preview.hobo.dev");
  const resources = bindEphemeralResources(normalized.resourceRequests);

  const camp = {
    id: campId,
    tenant: normalized.tenant,
    project: normalized.project,
    repository: normalized.repository,
    pullRequestNumber: normalized.pullRequest.number,
    headSha: normalized.pullRequest.headSha,
    baselineCampId: normalized.baselineCampId,
    envType: "ephemeral",
    state: "active",
    generation,
  };
  const stream = {
    id: streamId,
    baselineStreamId,
    isolated: true,
  };

  const preview = {
    kind: "hobo.preview.ephemeral.v1",
    camp,
    stream,
    previewUrl,
    resources,
    ttl: {
      requestedHours: ttlHours,
      expiresAt: ttlExpiresAt,
      hardCeilingHours,
      hardExpiresAt,
    },
    clone: {
      sourceCampId: normalized.baselineCampId,
      sourceSetId: normalized.baselineSetId,
      resources: cloneValue(normalized.baselineResources),
    },
  };

  return {
    ...preview,
    events: [
      event(preview, "env.PreviewCloneRequested", now, {
        baselineCampId: normalized.baselineCampId,
        baselineSetId: normalized.baselineSetId,
        headSha: normalized.pullRequest.headSha,
      }),
      event(preview, "env.PreviewCampCreated", now, {
        envType: "ephemeral",
        ttlExpiresAt,
        hardExpiresAt,
      }),
      event(preview, "deploy.PreviewUrlAssigned", now, { url: previewUrl }),
    ],
  };
}

export function clonePreviewEnvironment(request, options = {}) {
  const baseline = request.baseline ?? {};

  return openPullRequestPreview({
    ...request,
    baselineCampId: baseline.campId ?? request.baselineCampId,
    baselineSetId: baseline.setId ?? request.baselineSetId,
    baselineStreamId: baseline.streamId ?? request.baselineStreamId,
    baselineResources: baseline.resources ?? request.baselineResources,
  }, options);
}

export function reopenPullRequestPreview(previousPreview, request, options = {}) {
  const generation = (previousPreview.camp.generation ?? 1) + 1;
  const reopened = openPullRequestPreview(request, { ...options, generation });

  if (reopened.camp.id !== previousPreview.camp.id) {
    throw new Error(`reopened PR would orphan ${previousPreview.camp.id} as ${reopened.camp.id}`);
  }

  const reopenedEvent = event(reopened, "env.PreviewReopened", toDate(options.now ?? new Date()), {
    previousGeneration: previousPreview.camp.generation ?? 1,
    nextGeneration: generation,
    previousState: previousPreview.camp.state,
  });

  return {
    ...reopened,
    replacesCampId: previousPreview.camp.id,
    events: [reopenedEvent, ...reopened.events],
  };
}

export function reapExpiredPreview(preview, options = {}) {
  const now = toDate(options.now ?? new Date());

  if (preview.camp.state !== "active") {
    return {
      ...preview,
      action: "none",
      events: [],
    };
  }

  if (now < toDate(preview.ttl.expiresAt)) {
    return {
      ...preview,
      action: "none",
      events: [],
    };
  }

  if (now >= toDate(preview.ttl.hardExpiresAt)) {
    const escalated = {
      ...preview,
      camp: { ...preview.camp, state: "escalated" },
      escalation: {
        severity: "page",
        reason: `preview ${preview.camp.id} passed hard ceiling ${preview.ttl.hardExpiresAt}`,
      },
    };

    return {
      ...escalated,
      action: "escalate",
      events: [
        event(escalated, "env.PreviewTtlExpired", now, {
          expiredAt: preview.ttl.expiresAt,
        }),
        event(escalated, "env.PreviewHardCeilingEscalated", now, {
          hardExpiresAt: preview.ttl.hardExpiresAt,
          severity: "page",
        }),
      ],
    };
  }

  const reaped = {
    ...preview,
    camp: { ...preview.camp, state: "reaped" },
  };

  return {
    ...reaped,
    action: "deprovision",
    events: [
      event(reaped, "env.PreviewTtlExpired", now, {
        expiredAt: preview.ttl.expiresAt,
      }),
      event(reaped, "deploy.PreviewTeardownRequested", now, {
        previewUrl: preview.previewUrl,
      }),
    ],
  };
}

export function rebuildBaselineProjection(events, baselineStreamId) {
  return {
    streamId: baselineStreamId,
    appliedEventIds: events
      .filter((item) => item.streamId === baselineStreamId)
      .map((item) => item.id),
  };
}

export function assertPreviewStreamIsolation(preview, events) {
  for (const item of events) {
    if (item.streamId === preview.stream.baselineStreamId) {
      throw new Error(`preview event ${item.id} targeted baseline stream ${preview.stream.baselineStreamId}`);
    }
    if (item.streamId !== preview.stream.id) {
      throw new Error(`preview event ${item.id} targeted foreign stream ${item.streamId}`);
    }
    if (item.campId !== preview.camp.id) {
      throw new Error(`preview event ${item.id} targeted foreign Camp ${item.campId}`);
    }
  }
}

export function bindEphemeralResources(resourceRequests = []) {
  return resourceRequests.map((request) => {
    const selectedVariant = request.variants?.find((variant) => variant.envType === "ephemeral");

    if (!selectedVariant) {
      throw new Error(`resource ${request.name} has no envType: ephemeral variant`);
    }

    return {
      name: request.name,
      capability: request.capability,
      requestedEnvType: "ephemeral",
      selectedVariant: cloneValue(selectedVariant),
    };
  });
}

function normalizeRequest(request) {
  const pullRequest = request.pullRequest ?? {};

  if (!request.tenant) {
    throw new Error("tenant is required");
  }
  if (!request.project) {
    throw new Error("project is required");
  }
  if (!request.repository) {
    throw new Error("repository is required");
  }
  if (!Number.isInteger(pullRequest.number)) {
    throw new Error("pullRequest.number must be an integer");
  }
  if (!pullRequest.headSha) {
    throw new Error("pullRequest.headSha is required");
  }
  if (!request.baselineCampId) {
    throw new Error("baselineCampId is required");
  }

  return {
    ...request,
    pullRequest,
    baselineSetId: request.baselineSetId ?? null,
    baselineResources: request.baselineResources ?? [],
    resourceRequests: request.resourceRequests ?? [],
  };
}

function event(preview, type, occurredAt, data) {
  const eventTypeSlug = type.replaceAll(".", "-").toLowerCase();
  const generation = preview.camp.generation ?? 1;

  return {
    id: `event:${preview.camp.id}:g${generation}:${eventTypeSlug}`,
    type,
    streamId: preview.stream.id,
    campId: preview.camp.id,
    occurredAt: occurredAt.toISOString(),
    data: {
      generation,
      ...data,
    },
  };
}

function previewCampId(request) {
  return `camp:${slug(request.tenant)}:${slug(request.project)}:pr-${request.pullRequest.number}`;
}

function previewUrlFor(request, urlBase) {
  const base = new URL(urlBase);
  const label = `pr-${request.pullRequest.number}-${slug(request.project)}-${slug(request.tenant)}`;

  return `${base.protocol}//${label}.${base.host}`;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid timestamp ${value}`);
  }

  return date;
}

function slug(value) {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error(`value ${value} cannot be slugged`);
  }

  return normalized;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}
