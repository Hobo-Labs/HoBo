package vercel

#TurboCiPlan: {
  taskIds: [...string & =~"^[^-[:space:]#][^[:space:]#]*#[^[:space:]#]+$"]
  runArgs: [...string & !=""]
  if len(taskIds) == 0 {runArgs: []}
  if len(taskIds) > 0 {
    runArgs: ["run", ...string & !=""]
  }
}
