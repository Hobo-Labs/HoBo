import { type JsonObject } from "./json.js";
export interface DataClient {
  query(statement: string, parameters?: readonly unknown[]): Promise<readonly unknown[]>;
}

export interface BindingDescriptor<TClientName extends string = string> {
  readonly port: string;
  readonly resource: string;
  readonly clientType: TClientName;
}

export interface ResourceHandle<TClientName extends string = string> {
  readonly kind: "resource";
  readonly name: string;
  readonly type: string;
  readonly port: string;
  readonly clientType: TClientName;
}

export type BindingMap<TBindings extends Record<string, ResourceHandle>> = {
  readonly [Name in keyof TBindings]: BindingDescriptor<TBindings[Name]["clientType"]>;
};

export interface ServiceHandle<TBindings extends Record<string, BindingDescriptor> = Record<string, BindingDescriptor>> {
  readonly kind: "service" | "container";
  readonly name: string;
  readonly bindings: TBindings;
  readonly typescript: {
    readonly ctxBindings: string;
  };
  binding<Name extends keyof TBindings>(name: Name): TBindings[Name];
}

export interface ContainerHandle<TBindings extends Record<string, BindingDescriptor> = Record<string, BindingDescriptor>>
  extends ServiceHandle<TBindings> {
  withEndpoint(endpoint: {
    name?: string;
    scheme: string;
    port: number;
    targetPort?: number;
    external?: boolean;
    protocol?: string;
  }): ContainerHandle<TBindings>;
  withHttpEndpoint(
    port: number,
    options?: { name?: string; targetPort?: number; external?: boolean; protocol?: string },
  ): ContainerHandle<TBindings>;
  withEnvironment(key: string, value: string): ContainerHandle<TBindings>;
  withArgs(...args: string[]): ContainerHandle<TBindings>;
  withBindMount(source: string, target: string, readOnly?: boolean): ContainerHandle<TBindings>;
  withVolume(name: string, target: string): ContainerHandle<TBindings>;
  withLifetime(lifetime: "session" | "persistent"): ContainerHandle<TBindings>;
  waitFor(dependency: ResourceHandle | ServiceHandle | ContainerHandle | string): ContainerHandle<TBindings>;
  waitForCompletion(dependency: ResourceHandle | ServiceHandle | ContainerHandle | string): ContainerHandle<TBindings>;
  withHttpHealthCheck(path: string): ContainerHandle<TBindings>;
  /** Scope guard: DNS is Yard-level and outside this contract; always throws. */
  withDnsRecord(record?: string): never;
}

export function data(name: string, options?: { paradigm?: string }): ResourceHandle<"DataClient">;

export function service<TBindings extends Record<string, ResourceHandle>>(
  name: string,
  options?: { bind?: TBindings; image?: string; env?: Record<string, string> },
): ServiceHandle<BindingMap<TBindings>>;

export function addContainer<TBindings extends Record<string, ResourceHandle>>(
  name: string,
  source: string,
  options?: { bind?: TBindings; env?: Record<string, string> },
): ContainerHandle<BindingMap<TBindings>>;

export function bindingTypesFor(
  serviceHandle: ServiceHandle,
): Record<string, string>;

export function compileBindleManifest(handles: readonly unknown[]): {
  readonly schema: "hobo.manifest/v1";
  readonly resources: JsonObject;
};
