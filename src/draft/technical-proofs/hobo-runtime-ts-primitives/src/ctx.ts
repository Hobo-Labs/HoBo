import { type JsonValue, type JsonObject } from "./json.js";
export interface PrincipalRef {
  id: string;
  kind?: string;
}

export interface Ctx<B = JsonObject> {
  runId: string;
  seq: number;
  bindings: B;
  identity?: PrincipalRef;
}

export interface ActorCtx<S> extends Ctx {
  state: S;
  snapshot(): S;
  emit(type: string, data: JsonValue): Promise<number>;
}

export interface SagaCtx extends Ctx {
  emit(type: string, data: JsonValue): Promise<number>;
}
