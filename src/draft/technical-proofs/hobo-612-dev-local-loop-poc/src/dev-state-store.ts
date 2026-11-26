import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DevEvent,
  DevParseError,
  DevStateSnapshot,
  STATE_SCHEMA,
  emptyDevState,
  parseDevStateSnapshot,
} from "./types.js";

function eventsPath(projectRoot: string): string {
  return join(projectRoot, ".hobo", "dev-events.jsonl");
}

function snapshotPath(projectRoot: string): string {
  return join(projectRoot, ".hobo", "dev-state.json");
}

export function projectDevState(events: DevEvent[]): DevStateSnapshot {
  let state = emptyDevState();
  for (const event of events) {
    state = applyDevEvent(state, event);
  }
  return state;
}

function applyDevEvent(state: DevStateSnapshot, event: DevEvent): DevStateSnapshot {
  const next = { ...state, eventSequence: event.sequence };
  switch (event.family) {
    case "dev.SessionStarted":
      return next;
    case "dev.RequestServed": {
      const path = String(event.payload.path ?? "");
      const body = event.payload.body;
      const handlerGeneration = state.handlerGeneration;
      return {
        ...next,
        runCount: state.runCount + 1,
        requests: [...state.requests, { path, body, handlerGeneration }],
      };
    }
    case "dev.HandlerReloaded":
      return {
        ...next,
        handlerGeneration: state.handlerGeneration + 1,
        lastReloaded: String(event.payload.path ?? ""),
      };
    case "dev.ReloadFailed":
    case "dev.CodegenRan":
    case "dev.SessionStopped":
      return next;
    default:
      return next;
  }
}

export class DevStateStore {
  #projectRoot: string;
  #events: DevEvent[] = [];

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  async load(): Promise<DevStateSnapshot> {
    const projectRoot = this.#projectRoot;
    const snapshotFile = snapshotPath(projectRoot);
    let snapshotRaw: string | null = null;
    try {
      snapshotRaw = await readFile(snapshotFile, "utf8");
    } catch (error) {
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (snapshotRaw) {
      const parsed = parseDevStateSnapshot(JSON.parse(snapshotRaw));
      this.#events = await readEvents(projectRoot);
      const replayed = projectDevState(this.#events);
      if (replayed.runCount !== parsed.runCount || replayed.eventSequence !== parsed.eventSequence) {
        return replayed;
      }
      return parsed;
    }

    this.#events = await readEvents(projectRoot);
    if (this.#events.length === 0) {
      const state = emptyDevState();
      await this.#writeSnapshot(state);
      return state;
    }
    return projectDevState(this.#events);
  }

  async append(event: Omit<DevEvent, "sequence" | "at">): Promise<DevStateSnapshot> {
    const sequence = this.#events.length + 1;
    const record: DevEvent = {
      ...event,
      sequence,
      at: new Date(0).toISOString(),
    };
    this.#events.push(record);
    await mkdir(dirname(eventsPath(this.#projectRoot)), { recursive: true });
    await appendFile(eventsPath(this.#projectRoot), `${JSON.stringify(record)}\n`);
    const state = projectDevState(this.#events);
    await this.#writeSnapshot(state);
    return state;
  }

  events(): readonly DevEvent[] {
    return this.#events;
  }

  async #writeSnapshot(state: DevStateSnapshot): Promise<void> {
    const path = snapshotPath(this.#projectRoot);
    await mkdir(dirname(path), { recursive: true });
    const payload = {
      schema: STATE_SCHEMA,
      runCount: state.runCount,
      handlerGeneration: state.handlerGeneration,
      lastReloaded: state.lastReloaded,
      eventSequence: state.eventSequence,
      requests: state.requests,
    };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

async function readEvents(projectRoot: string): Promise<DevEvent[]> {
  try {
    const raw = await readFile(eventsPath(projectRoot), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const event: DevEvent =
          // SAFETY: each events.jsonl line is a DevEvent record.
          JSON.parse(line) as DevEvent;
        return event;
      });
  } catch (error) {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function assertDevStateReadable(projectRoot: string): Promise<DevStateSnapshot> {
  const store = new DevStateStore(projectRoot);
  try {
    return await store.load();
  } catch (error) {
    if (error instanceof DevParseError && error.code === "HOBO_DEV_STATE_VERSION_UNSUPPORTED") {
      throw error;
    }
    throw error;
  }
}
