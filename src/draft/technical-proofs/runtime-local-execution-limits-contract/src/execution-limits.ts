import { isJsonString } from "./json.js";
const DEFAULT_LIMITS = Object.freeze({
  fuel: 10_000,
  epochTicks: 10_000,
  memoryBytes: 64 * 1024 * 1024,
});

export class HostExecutionLimitError extends Error {
  constructor({ componentId, requestId, reason, limit, cleanup }) {
    super(`host.execution_limit_exceeded: ${componentId}: ${reason}`);
    this.name = "HostExecutionLimitError";
    this.code = "host.execution_limit_exceeded";
    this.componentId = componentId;
    this.requestId = requestId;
    this.reason = reason;
    this.limit = { ...limit };
    this.cleanup = { ...cleanup };
  }
}

export function createRuntimeLocalExecutionHost({ limits = {} } = {}) {
  return new RuntimeLocalExecutionHost({ ...DEFAULT_LIMITS, ...limits });
}

export const guestFixtures = Object.freeze({
  healthy({ response }) {
    return createGuestFixture("healthy", () => response);
  },

  burnFuel({ steps, fuelPerStep }) {
    return createGuestFixture("burn-fuel", async (context) => {
      for (let step = 0; step < steps; step += 1) {
        context.consumeFuel(fuelPerStep);
        context.tickEpoch();
      }
      return { status: 200, body: "completed" };
    });
  },

  infiniteLoop({ fuelPerTick }) {
    return createGuestFixture("infinite-loop", async (context) => {
      while (true) {
        context.consumeFuel(fuelPerTick);
        context.tickEpoch();
      }
    });
  },

  allocateUntilInterrupted({ bytesPerStep, steps }) {
    return createGuestFixture("allocate-until-interrupted", async (context) => {
      for (let step = 0; step < steps; step += 1) {
        context.allocate(bytesPerStep);
        context.consumeFuel(1);
        context.tickEpoch();
      }
      return { status: 200, body: "allocated" };
    });
  },
});

class RuntimeLocalExecutionHost {
  #components = new Map();
  #leaseStates = new Map();
  #auditEvents = [];

  constructor(limits) {
    this.limits = normalizeLimits(limits);
  }

  loadComponent(component) {
    assertId(component?.id, "component");
    if (!(component.guest?.run instanceof Function)) {
      throw new Error(`component_host.guest_required: ${component.id}`);
    }

    const leases = [...(component.leases ?? [])];
    this.#components.set(component.id, {
      id: component.id,
      guest: component.guest,
      onLimitCleanup: component.onLimitCleanup,
    });
    this.#leaseStates.set(component.id, {
      componentId: component.id,
      state: leases.length > 0 ? "active" : "released",
      leases,
      owner: leases.length > 0 ? component.id : null,
    });
    this.#auditEvents.push({
      type: "component.Loaded",
      componentId: component.id,
      leaseCount: leases.length,
    });
  }

  async invoke(componentId, request = {}) {
    const component = this.#requireLoaded(componentId);
    const context = new LimitContext(this.limits);
    const requestId = request.requestId ?? null;

    try {
      const response = await component.guest.run(context, request);
      this.#auditEvents.push({
        type: "component.Invoked",
        componentId,
        requestId,
      });
      return response;
    } catch (error) {
      if (!(error instanceof LimitSignal)) {
        throw error;
      }

      const cleanup = this.#cleanupAfterLimit(component, error);
      const fact = {
        type: "exec.ExecutionLimitTrapped",
        componentId,
        requestId,
        reason: error.reason,
        limit: { ...this.limits },
        cleanupState: cleanup.state,
      };
      this.#auditEvents.push(fact);
      throw new HostExecutionLimitError({
        componentId,
        requestId,
        reason: error.reason,
        limit: this.limits,
        cleanup,
      });
    }
  }

  isLive() {
    return true;
  }

  activeLeases() {
    return [...this.#leaseStates.values()]
      .filter((leaseState) => leaseState.state !== "released")
      .flatMap((leaseState) => leaseState.leases);
  }

  leaseState(componentId) {
    const leaseState = this.#leaseStates.get(componentId);
    if (!leaseState) {
      return {
        componentId,
        state: "missing",
        leases: [],
        owner: null,
      };
    }

    return {
      componentId: leaseState.componentId,
      state: leaseState.state,
      leases: [...leaseState.leases],
      owner: leaseState.owner,
    };
  }

  auditEvents() {
    return this.#auditEvents.map((event) => ({
      ...event,
      limit: event.limit ? { ...event.limit } : undefined,
    }));
  }

  #requireLoaded(componentId) {
    const component = this.#components.get(componentId);
    if (!component) {
      throw new Error(`component_host.component_not_loaded: ${componentId}`);
    }
    return component;
  }

  #cleanupAfterLimit(component, signal) {
    const current = this.leaseState(component.id);
    try {
      component.onLimitCleanup?.(signal);
      this.#leaseStates.set(component.id, {
        componentId: component.id,
        state: "released",
        leases: [],
        owner: null,
      });
      return { state: "released", message: null };
    } catch (error) {
      this.#leaseStates.set(component.id, {
        componentId: component.id,
        state: "owned-for-teardown",
        leases: current.leases,
        owner: "runtime-local-teardown",
      });
      return { state: "owned-for-teardown", message: error.message };
    }
  }
}

class LimitContext {
  #limits;
  #fuelUsed = 0;
  #epochTicks = 0;
  #memoryUsed = 0;

  constructor(limits) {
    this.#limits = limits;
  }

  consumeFuel(units) {
    this.#fuelUsed += positiveInteger(units, "fuel units");
    if (this.#fuelUsed > this.#limits.fuel) {
      throw new LimitSignal("fuel-exhausted");
    }
  }

  tickEpoch() {
    this.#epochTicks += 1;
    if (this.#epochTicks > this.#limits.epochTicks) {
      throw new LimitSignal("epoch-deadline-exceeded");
    }
  }

  allocate(bytes) {
    this.#memoryUsed += positiveInteger(bytes, "memory bytes");
    if (this.#memoryUsed > this.#limits.memoryBytes) {
      throw new LimitSignal("memory-limit-exceeded");
    }
  }
}

class LimitSignal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function createGuestFixture(kind, run) {
  return Object.freeze({ kind, run });
}

function normalizeLimits(limits) {
  return Object.freeze({
    fuel: positiveInteger(limits.fuel, "fuel"),
    epochTicks: positiveInteger(limits.epochTicks, "epoch ticks"),
    memoryBytes: positiveInteger(limits.memoryBytes, "memory bytes"),
  });
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`execution_limits.${name.replaceAll(" ", "_")}_must_be_positive_integer`);
  }
  return value;
}

function assertId(id, kind) {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`component_host.${kind}_id_required`);
  }
}
