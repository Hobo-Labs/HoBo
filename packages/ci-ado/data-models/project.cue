package project

import (
 "list"
 "struct"
 "strings"
)

#AdoProject: {
 schemaVersion: "hobo.ci.ado/v1"
 pool: string & =~"^[A-Za-z0-9_]([A-Za-z0-9_. -]{0,98}[A-Za-z0-9_.-])?$" & !~"(?i)^azure pipelines$"
 demands?: [...#Demand] & list.MaxItems(16) & list.UniqueItems()
 pipelinePath: string & =~"^[A-Za-z0-9_.-][A-Za-z0-9_./-]{0,499}$" & !~"(^|/)[.]{1,2}(/|$)" & !~"//|/$"
 artifactPrefix: string & =~"^[A-Za-z0-9_-]{1,64}$"
 environmentRefs?: {[#EnvironmentName & !="__proto__" & !~"^HOBO_CI_"]: #EnvironmentName & !~"^HOBO_CI_"} & struct.MaxFields(64)
 runnerArgv?: [...#Argument] & list.MaxItems(256)
 bootstrapArgv?: [...#Argument] & list.MaxItems(256)
 verifyArtifacts?: bool
}

#Project: #AdoProject | #AdoRunReport | #AdoLiveTarget | #AdoLiveResult

#Demand: string & =~"^[A-Za-z][A-Za-z0-9_.-]*( -equals [A-Za-z0-9_.-]+)?$" & (!~"(?i)^Agent[.]OS($| )" | "Agent.OS -equals Linux")

#EnvironmentName: string & =~"^[A-Za-z_][A-Za-z0-9_]{0,127}$"
#Argument: string & !="" & strings.MaxRunes(65536) & !~"\\x00" & !~"[$][(]|[$][{][{]|[$][[]"
#AdoArtifactRecord: {
 path: string & !=""
 sha256: string & =~"^[a-f0-9]{64}$"
 sizeBytes: int & >=0 & <=1048576
}
#AdoRunReport: {
 schemaVersion: "hobo.ci.ado-report/v1"
 planDigest: string & =~"^[a-f0-9]{64}$"
 executionId: string & =~"^[A-Za-z0-9_-]{1,100}$"
 status: "succeeded" | "failed" | "cancelled" | "timed_out" | "uncertain" | "blocked"
 artifacts: [...#AdoArtifactRecord] & list.MaxItems(16)
 stepCount: int & >=0 & <=128
 error: string
}

#AdoLiveTarget: {
 organizationUrl: string & =~"^https://dev[.]azure[.]com/[A-Za-z0-9][A-Za-z0-9-]{0,99}/?$"
 project: string & =~"^[A-Za-z0-9]([A-Za-z0-9_. -]{0,198}[A-Za-z0-9_.-])?$"
 pipelineId: int & >0
 refName: string & =~"^refs/heads/[A-Za-z0-9_./-]+$" & !~"[.][.]|//|/$|[.]$|(^|/)[.]|[.]lock(/|$)"
 sourceVersion: string & =~"^[a-f0-9]{40}$"
 tokenEnv: #EnvironmentName
 authentication: "pat" | "bearer"
 timeoutSeconds: int & >=1 & <=3600
}
#AdoLiveResult: {runId: int & >0, sourceVersion: string & =~"^[a-f0-9]{40}$", pool: string & !="", result: "succeeded", artifactNames: [string, ...string], url: string & =~"^https://dev[.]azure[.]com/"}
#AdoRemotePool: {id: int & >=0, name: string, isHosted?: bool}
#AdoRemotePools: {value: [...#AdoRemotePool]}
#AdoRemoteRun: {id?: int & >=0, finalYaml?: string}
#AdoRemoteQueue: {pool?: #AdoRemotePool}
#AdoRemoteBuild: {id: int & >=0, status: string, result?: string, sourceVersion: string, queue?: #AdoRemoteQueue}
#AdoRemoteTimelineRecord: {type: string, name: string, identifier?: string, state: string, result?: string}
#AdoRemoteTimeline: {records: [...#AdoRemoteTimelineRecord]}
#AdoRemoteArtifactResource: {type: string}
#AdoRemoteArtifact: {name: string, resource?: #AdoRemoteArtifactResource}
#AdoRemoteArtifacts: {value: [...#AdoRemoteArtifact]}
#AdoYamlPool: {name: string, vmImage?: string}
#AdoYamlJob: {job: string, pool?: #AdoYamlPool, steps?: [...#AdoYamlStep]}
#AdoYaml: {jobs?: [...#AdoYamlJob], stages?: [...#AdoYamlStage]}
#AdoYamlStage: {jobs: [...#AdoYamlJob]}

#AdoRemoteDefinition: {id: int & >0, revision: int & >0}

#AdoYamlStep: {bash?: string, task?: string, displayName?: string, inputs?: {[string]: string}}
