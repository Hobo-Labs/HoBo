--------------------------- MODULE LocalWorkBinding ---------------------------
EXTENDS Naturals
CONSTANTS CheckSnapshot, CheckMaterialize, BindSnapshot, BindDigest,
          CheckAfterApproval, CheckBeforeStart, CheckWorker, ExecuteSnapshot
VARIABLES version, baseline, execution, digest, launched, available, persistent,
          preparedChanged, launchObservation, workerObservation, phase
facts == <<available, persistent>>
vars == <<version, baseline, execution, digest, launched, facts,
          preparedChanged, launchObservation, workerObservation, phase>>

Init == /\ version = 0 /\ baseline = 2 /\ execution = 2 /\ digest = 2
        /\ launched = 2 /\ available \in BOOLEAN /\ persistent \in BOOLEAN
        /\ preparedChanged = FALSE /\ launchObservation = 2
        /\ workerObservation = 2 /\ phase = "snapshot"

TakeSnapshot == /\ phase = "snapshot"
                /\ phase' = IF available \/ ~CheckSnapshot THEN "review" ELSE "rejected"
                /\ baseline' = IF available THEN version ELSE 2
                /\ UNCHANGED <<version, execution, digest, launched, facts,
                                preparedChanged, launchObservation, workerObservation>>

Review == /\ phase = "review"
          /\ phase' = IF baseline # 2 /\ version = baseline THEN "materialize" ELSE "rejected"
          /\ UNCHANGED <<version, baseline, execution, digest, launched, facts,
                        preparedChanged, launchObservation, workerObservation>>

Materialize == /\ phase = "materialize"
               /\ phase' = IF version = baseline \/ ~CheckMaterialize
                            THEN "approval" ELSE "rejected"
               /\ execution' = IF phase' = "approval"
                                THEN IF BindSnapshot THEN version ELSE 1 - version
                                ELSE 2
               /\ UNCHANGED <<version, baseline, digest, launched, facts,
                               preparedChanged, launchObservation, workerObservation>>

Authorize == /\ phase = "approval"
             /\ digest' = IF BindDigest THEN baseline ELSE 1 - baseline
             /\ phase' = "approved"
             /\ UNCHANGED <<version, baseline, execution, launched, facts,
                             preparedChanged, launchObservation, workerObservation>>

Prepare == /\ phase = "approved"
           /\ phase' = IF version = baseline \/ ~CheckAfterApproval
                        THEN "preparing" ELSE "rejected"
           /\ preparedChanged' = (version # baseline /\ ~CheckAfterApproval)
           /\ UNCHANGED <<version, baseline, execution, digest, launched, facts,
                           launchObservation, workerObservation>>

CheckLaunch == /\ phase = "preparing"
               /\ phase' = IF version # baseline /\ CheckBeforeStart
                            THEN "rejected" ELSE "launch-checked"
               /\ launchObservation' = version
               /\ UNCHANGED <<version, baseline, execution, digest, launched,
                               facts, preparedChanged, workerObservation>>

Start == /\ phase = "launch-checked"
         /\ phase' = IF persistent THEN "worker-pending" ELSE "started"
         /\ launched' = IF persistent THEN 2
                         ELSE IF ExecuteSnapshot THEN execution ELSE version
         /\ UNCHANGED <<version, baseline, execution, digest, facts,
                        preparedChanged, launchObservation, workerObservation>>

CorruptSnapshot == /\ phase = "worker-pending"
                   /\ execution' = 1 - execution
                   /\ UNCHANGED <<version, baseline, digest, launched, facts,
                                   preparedChanged, launchObservation,
                                   workerObservation, phase>>

CheckWorkerInputs == /\ phase = "worker-pending"
                     /\ phase' = IF execution # baseline /\ CheckWorker
                                  THEN "rejected" ELSE "worker-checked"
                     /\ workerObservation' = execution
                     /\ UNCHANGED <<version, baseline, execution, digest,
                                    launched, facts, preparedChanged,
                                    launchObservation>>

WorkerStart == /\ phase = "worker-checked"
               /\ phase' = "started"
               /\ launched' = IF ExecuteSnapshot THEN execution ELSE version
               /\ UNCHANGED <<version, baseline, execution, digest, facts,
                               preparedChanged, launchObservation,
                               workerObservation>>

EditInputs == /\ phase \in {"review", "materialize", "approval", "approved",
                              "preparing", "launch-checked", "worker-pending",
                              "worker-checked"}
              /\ version' = 1 - version
              /\ UNCHANGED <<baseline, execution, digest, launched, facts,
                              preparedChanged, launchObservation,
                              workerObservation, phase>>

Done == /\ phase \in {"rejected", "started"} /\ UNCHANGED vars
Next == TakeSnapshot \/ Review \/ Materialize \/ Authorize \/ Prepare \/
        CheckLaunch \/ Start \/ CorruptSnapshot \/ CheckWorkerInputs \/
        WorkerStart \/ EditInputs \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ version \in 0..1 /\ baseline \in 0..2 /\ execution \in 0..2
          /\ digest \in 0..2 /\ launched \in 0..2
          /\ launchObservation \in 0..2 /\ workerObservation \in 0..2
          /\ available \in BOOLEAN /\ persistent \in BOOLEAN
          /\ preparedChanged \in BOOLEAN
          /\ phase \in {"snapshot", "review", "materialize", "approval",
                         "approved", "preparing", "launch-checked",
                         "worker-pending", "worker-checked", "started", "rejected"}

SnapshotRequired == phase \in {"review", "materialize", "approval", "approved",
                                "preparing", "launch-checked", "worker-pending",
                                "worker-checked", "started"} => baseline # 2
ExecutionBindsInputs == phase \in {"approval", "approved", "preparing",
                                    "launch-checked", "worker-checked", "started"}
                         => execution = baseline
ProofBindsInputs == phase \in {"approved", "preparing", "launch-checked",
                                "worker-pending", "worker-checked", "started"}
                    => digest = baseline
NoChangedPreparation == ~preparedChanged
LaunchWasChecked == phase \in {"launch-checked", "worker-pending",
                                "worker-checked", "started"}
                    => launchObservation = baseline
WorkerSnapshotChecked == persistent /\ phase \in {"worker-checked", "started"}
                         => workerObservation = baseline
ActualWorkMatches == phase = "started" => launched = baseline
=============================================================================
