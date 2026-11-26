package hobo

#RuntimeRunStarted: {
  run_id: string & != ""
  workflow: string & != ""
}

#RuntimeStepCompleted: {
  run_id: string & != ""
  step_key: string & != ""
  idempotency_key: string & =~ "^[a-f0-9]{32}$"
}

#RuntimeSagaCompensated: {
  saga_name: string & != ""
  trigger: string & != ""
}

#HoboRuntimeTsPrimitivesRecord: {
  issue: string & != ""
  summary: string & != ""
  catalog_event_types: [...=~"^(run|actor|saga)\\."]
}
