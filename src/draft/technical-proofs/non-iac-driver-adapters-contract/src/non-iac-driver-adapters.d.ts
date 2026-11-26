import type {
  Driver,
  MatchContext,
  ResourceDefinition
} from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.d.js";
import { type JsonValue, type JsonObject } from "./json.js";


export declare const NON_IAC_DRIVER_ADAPTERS_VERSION = "hobo.non-iac-driver-adapters/v1";

export declare class NonIacDriverAdapterError extends Error {
  name: "NonIacDriverAdapterError";
  code: string;
  details: JsonObject;
  constructor(code: string, message: string, details?: JsonObject);
}

export type ContainerScript = {
  id: string;
  command?: string;
  egress?: string[];
  outputs?: JsonObject;
};

export type ContainerSandbox = {
  runtime?: string;
  image?: string;
  allowedEgress?: string[];
  network?: { allowedEgress?: string[] };
  mounts?: JsonValue[];
};

export type ContainerExecutorRequest = {
  apiVersion: typeof NON_IAC_DRIVER_ADAPTERS_VERSION;
  context: MatchContext;
  script: ContainerScript;
  sandbox: {
    runtime: string;
    image: string;
    network: { allowedEgress: string[] };
    mounts: JsonValue[];
  };
};

export type ContainerExecutorResult = {
  status?: "succeeded" | "failed";
  execId?: string;
  outputs: JsonObject;
  manifests?: JsonValue[];
  reason?: string;
};

export type ContainerExecutor = {
  calls?: ContainerExecutorRequest[];
  run?(request: ContainerExecutorRequest): Promise<ContainerExecutorResult> | ContainerExecutorResult;
  dispatch?(
    script: ContainerScript,
    options: { context: MatchContext; sandbox: ContainerExecutorRequest["sandbox"] }
  ): Promise<ContainerExecutorResult> | ContainerExecutorResult;
};

export type WebhookRequest = {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: JsonObject;
};

export type WebhookResponse = {
  statusCode?: number;
  outputs: JsonObject;
  manifests?: JsonValue[];
};

export type WebhookService = {
  requests?: WebhookRequest[];
  handle(request: WebhookRequest): Promise<WebhookResponse> | WebhookResponse;
};

export declare function createNonIacDriverAdapters(options?: {
  template?: { manifests?: JsonValue[] };
  echo?: Record<string, never>;
  container?: { executor?: ContainerExecutor };
  webhook?: {
    service?: WebhookService;
    secret?: string;
    svid?: string;
    url?: string;
    signer?: (input: {
      body: JsonObject;
      context: MatchContext;
      inputs: JsonObject;
    }) => { svid: string; signature: string; bodyDigest?: string };
  };
}): Driver[];

export declare function selectDriverForResourceDefinition(
  definition: ResourceDefinition,
  adapters: Driver[]
): Driver;

export declare function createTemplateDriverAdapter(options?: { manifests?: JsonValue[] }): Driver;
export declare function createEchoDriverAdapter(): Driver;
export declare function createContainerDriverAdapter(options?: { executor?: ContainerExecutor }): Driver;
export declare function createFixtureContainerExecutor(options?: {
  execId?: string;
  outputs?: JsonObject;
  manifests?: JsonValue[];
}): ContainerExecutor & { calls: ContainerExecutorRequest[] };
export declare function createCustomWebhookDriverAdapter(options?: {
  service?: WebhookService;
  secret?: string;
  svid?: string;
  url?: string;
  signer?: (input: {
    body: JsonObject;
    context: MatchContext;
    inputs: JsonObject;
  }) => { svid: string; signature: string; bodyDigest?: string };
}): Driver;
export declare function createFixtureWebhookService(options?: {
  secret?: string;
  trustDomain?: string;
  outputs?: JsonObject;
  manifests?: JsonValue[];
}): WebhookService & { requests: WebhookRequest[] };
export declare function signSvidRequest(input: {
  body: JsonValue;
  svid: string;
  secret: string;
}): { svid: string; bodyDigest: string; signature: string };
export declare function verifySvidRequest(input: {
  request: WebhookRequest;
  secret: string;
  trustDomain?: string;
}): boolean;
