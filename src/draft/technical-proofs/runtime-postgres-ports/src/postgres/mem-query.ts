import type { IMemoryDb } from "pg-mem";
import { type JsonObject } from "../json.js";


export function execMemQuery(memDb: IMemoryDb, sql: string, params: JsonObject) {
  return memDb.public.query(sql, params);
}

export function execMemNone(memDb: IMemoryDb, sql: string, params: JsonObject = {}) {
  return memDb.public.none(sql, params);
}
