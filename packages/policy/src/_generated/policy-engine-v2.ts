export type SubjectKind = 'user' | 'service' | 'agent' | 'system';
export type Phase = 'author' | 'local' | 'test' | 'plan' | 'apply' | 'runtime' | 'observe' | 'train' | 'promote' | 'repair';
export type Effect = 'allow' | 'allow-degraded' | 'deny' | 'warn' | 'mutate' | 'require-approval';
export interface SubjectRef {
    kind: SubjectKind;
    id: string;
    roles: Array<string>;
    scopes: Array<string>;
    delegatedBy?: string;
}
export interface ResourceRef {
    kind: string;
    id: string;
}
export interface DecisionRequest {
    schema: string;
    subject: SubjectRef;
    action: string;
    resource: ResourceRef;
    phase: Phase;
    contextJson: string;
}
export interface Obligation {
    kind: string;
    reason: string;
}
export interface Evidence {
    engine: string;
    inputHash: string;
    policyIds: Array<string>;
    packId?: string;
    packVersion?: string;
}
export interface Decision {
    schemaVersion: string;
    effect: Effect;
    reason: string;
    violationsJson: string;
    mutationsJson: string;
    approvalsJson: string;
    obligationsJson: string;
    evidence: Evidence;
}
export interface Ruleset {
    schema: string;
    id: string;
    version: string;
    rulesJson: string;
}
export interface CompiledRuleset {
    rulesetId: string;
    version: string;
}
export interface PolicyError {
    code: string;
    message: string;
}
