export const RESOURCE_ACTOR_FSM_VERSION = "hobo.resource-actor-fsm/v1";

export const RESOURCE_ACTOR_STATES = Object.freeze([
  "Pending",
  "Planning",
  "Provisioning",
  "Provisioned",
  "Updating",
  "Failed",
  "Compensating",
  "Destroying",
  "Destroyed"
]);

const TRANSITIONS = Object.freeze({
  Pending: Object.freeze({
    markDependenciesSatisfied: {
      next: "Planning",
      eventType: "resource.Planning"
    }
  }),
  Planning: Object.freeze({
    previewOk: {
      next: "Provisioning",
      eventType: "resource.Provisioning"
    }
  }),
  Provisioning: Object.freeze({
    applyOk: {
      next: "Provisioned",
      eventType: "resource.Provisioned"
    },
    applyFailed: {
      next: "Failed",
      eventType: "resource.Failed"
    }
  }),
  Provisioned: Object.freeze({
    desiredChanged: {
      next: "Updating",
      eventType: "resource.Updating"
    },
    destroyRequested: {
      next: "Destroying",
      eventType: "resource.Destroying"
    }
  }),
  Updating: Object.freeze({
    updateOk: {
      next: "Provisioned",
      eventType: "resource.Provisioned"
    },
    updateFailed: {
      next: "Failed",
      eventType: "resource.Failed"
    }
  }),
  Failed: Object.freeze({
    rollbackRequested: {
      next: "Compensating",
      eventType: "resource.Compensating"
    }
  }),
  Compensating: Object.freeze({
    compensationDone: {
      next: "Destroyed",
      eventType: "resource.Destroyed"
    }
  }),
  Destroying: Object.freeze({
    destroyOk: {
      next: "Destroyed",
      eventType: "resource.Destroyed"
    }
  })
});

export function createResourceActor(plan) {
  return new ResourceActor(plan);
}

export function createInMemoryActorHost() {
  const leases = new Map();

  return {
    acquire(actorKey, ownerId) {
      const heldBy = leases.get(actorKey);
      if (heldBy && heldBy !== ownerId) {
        throw new Error(`resource actor lease held by ${heldBy} for ${actorKey}`);
      }
      leases.set(actorKey, ownerId);
      return {
        actorKey,
        ownerId,
        release() {
          if (leases.get(actorKey) === ownerId) {
            leases.delete(actorKey);
          }
        }
      };
    },
    holder(actorKey) {
      return leases.get(actorKey) ?? null;
    }
  };
}

export function hydrateResourceActor(plan, events) {
  const actor = new ResourceActor(plan);

  for (const event of events) {
    if (event.actorKey !== actor.key) {
      throw new Error(`cannot hydrate ${actor.key} from event for ${event.actorKey}`);
    }
    if (!RESOURCE_ACTOR_STATES.includes(event.state)) {
      throw new Error(`cannot hydrate ${actor.key} from unknown state ${event.state}`);
    }
    actor.state = event.state;
    actor.sequence = Math.max(actor.sequence, event.seq ?? 0);
    actor.events.push(structuredClone(event));
  }

  return actor;
}

class ResourceActor {
  constructor(plan) {
    assertPlan(plan);
    this.plan = structuredClone(plan);
    this.key = `resource:${plan.deploymentId}:${plan.resource.name}`;
    this.state = "Pending";
    this.events = [];
    this.sequence = 0;
  }

  markDependenciesSatisfied(details = {}) {
    return this.#transition("markDependenciesSatisfied", details);
  }

  previewOk(details = {}) {
    return this.#transition("previewOk", details);
  }

  applyOk(details = {}) {
    return this.#transition("applyOk", details);
  }

  activate(actorHost, { ownerId }) {
    if (!actorHost?.acquire) {
      throw new Error("ResourceActor activation requires an ActorHost with acquire()");
    }
    if (!ownerId) {
      throw new Error("ResourceActor activation requires ownerId");
    }
    return actorHost.acquire(this.key, ownerId);
  }

  ingestEvent(event) {
    if (event?.actorKey !== this.key) {
      throw new Error(`cannot ingest event for ${event?.actorKey ?? "unknown"} into ${this.key}`);
    }
    if ((event.seq ?? 0) <= this.sequence) {
      return {
        accepted: false,
        reason: "already-observed"
      };
    }
    if (!RESOURCE_ACTOR_STATES.includes(event.state)) {
      throw new Error(`cannot ingest unknown ResourceActor state ${event.state}`);
    }

    this.state = event.state;
    this.sequence = event.seq;
    this.events.push(structuredClone(event));
    return {
      accepted: true,
      reason: "advanced"
    };
  }

  reconcile({ preview }) {
    if (this.state !== "Planning" && this.state !== "Updating") {
      throw new Error(`reconcile requires Planning or Updating state, got ${this.state}`);
    }
    if (preview?.empty) {
      return {
        kind: "converged",
        actorKey: this.key
      };
    }
    if (!preview?.programRef) {
      throw new Error("reconcile preview requires programRef when diff is non-empty");
    }

    if (this.state === "Planning") {
      this.previewOk(preview);
    }

    return {
      kind: "needs-executor-dispatch",
      actorKey: this.key,
      programRef: preview.programRef
    };
  }

  applyFailed(details = {}) {
    return this.#transition("applyFailed", details);
  }

  desiredChanged(details = {}) {
    return this.#transition("desiredChanged", details);
  }

  updateOk(details = {}) {
    return this.#transition("updateOk", details);
  }

  updateFailed(details = {}) {
    return this.#transition("updateFailed", details);
  }

  rollbackRequested(details = {}) {
    return this.#transition("rollbackRequested", details);
  }

  compensationDone(details = {}) {
    return this.#transition("compensationDone", details);
  }

  destroyRequested(details = {}) {
    return this.#transition("destroyRequested", details);
  }

  destroyOk(details = {}) {
    return this.#transition("destroyOk", details);
  }

  #transition(action, details) {
    const transition = TRANSITIONS[this.state]?.[action];
    if (!transition) {
      throw new Error(`illegal ResourceActor transition: ${action} from ${this.state}`);
    }

    this.state = transition.next;
    const event = {
      apiVersion: RESOURCE_ACTOR_FSM_VERSION,
      type: transition.eventType,
      actorKey: this.key,
      deploymentId: this.plan.deploymentId,
      resourceName: this.plan.resource.name,
      resourceType: this.plan.resource.type,
      seq: ++this.sequence,
      state: this.state,
      details: structuredClone(details)
    };
    this.events.push(event);
    return event;
  }
}

function assertPlan(plan) {
  if (!plan?.deploymentId) {
    throw new Error("ResourceActor plan requires deploymentId");
  }
  if (!plan.resource?.name) {
    throw new Error("ResourceActor plan requires resource.name");
  }
  if (!plan.resource?.type) {
    throw new Error("ResourceActor plan requires resource.type");
  }
}
