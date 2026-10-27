use serde_json::Value;
use spine_core::host::{RawBoundary, SpineCompactBarrierV1, ThreadNamespace};
use spine_wasm::ABI_SCHEMA;
use spine_wasm::Command;
use spine_wasm::CommandResult;
use spine_wasm::FeatureFlag;
use spine_wasm::InitRequest;
use spine_wasm::Operation;
use spine_wasm::PortableRuntime;
use spine_wasm::ReplayItem;
use spine_wasm::Role;
use spine_wasm::SourceCharacter;
use spine_wasm::Terminal;

fn runtime() -> PortableRuntime {
    PortableRuntime::new(InitRequest {
        schema: ABI_SCHEMA.to_string(),
        thread: "portable-test".to_string(),
        epoch: 0,
        config_toml: None,
        features: vec![FeatureFlag::Jit, FeatureFlag::Spawn],
    })
    .expect("runtime")
}

fn user(boundary: u64) -> SourceCharacter {
    SourceCharacter::Message {
        boundary,
        role: Role::User,
        content: "implement the task".to_string(),
    }
}

fn assistant(boundary: u64) -> SourceCharacter {
    SourceCharacter::Message {
        boundary,
        role: Role::Assistant,
        content: "task started".to_string(),
    }
}

#[test]
fn prepare_requires_matching_persisted_transaction_before_install() {
    let mut runtime = runtime();
    runtime
        .execute(Command::ObserveSources {
            characters: vec![user(1)],
        })
        .expect("observe user");
    let started = runtime
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect("begin");
    assert!(matches!(started, CommandResult::SamplingStarted { .. }));
    runtime
        .execute(Command::RegisterExecution {
            key: "open-0".to_string(),
        })
        .expect("register");
    runtime
        .execute(Command::StageExecution {
            key: "open-0".to_string(),
            execution_ref: "tool-call-0".to_string(),
            operation: Operation::Open {
                summary: "implement portable SDK".to_string(),
            },
        })
        .expect("stage");
    runtime
        .execute(Command::FinishExecution {
            key: "open-0".to_string(),
            succeeded: true,
        })
        .expect("finish execution");
    runtime
        .execute(Command::ObserveSources {
            characters: vec![assistant(2)],
        })
        .expect("observe output");

    let prepared = runtime
        .execute(Command::PrepareFinish {
            terminal: Terminal::Completed,
            input_tokens: Some(42),
        })
        .expect("prepare");
    let transaction_id = match prepared {
        CommandResult::FinishPrepared { transaction_id, .. } => transaction_id,
        other => panic!("unexpected result: {other:?}"),
    };
    let mismatch = runtime
        .execute(Command::InstallPrepared {
            transaction_id: "0".repeat(64),
        })
        .expect_err("wrong transaction must fail");
    assert_eq!(mismatch.code, "invalid_state");
    let installed = runtime
        .execute(Command::InstallPrepared {
            transaction_id: transaction_id.clone(),
        })
        .expect("install after host persistence");
    assert!(matches!(
        installed,
        CommandResult::PreparedInstalled {
            transaction_id: installed_id,
            ..
        } if installed_id == transaction_id
    ));
}

#[test]
fn json_dispatch_rejects_wrong_schema_without_mutating_runtime() {
    let mut runtime = runtime();
    let response: Value = serde_json::from_str(
        &runtime.dispatch_json(r#"{"schema":"spine-sdk/v1","request":{"type":"preview"}}"#),
    )
    .expect("response json");
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "unsupported_schema");

    let valid: Value = serde_json::from_str(
        &runtime.dispatch_json(r#"{"schema":"spine-sdk/v3","request":{"type":"preview"}}"#),
    )
    .expect("response json");
    assert_eq!(valid["ok"], true);
}

#[test]
fn discard_returns_runtime_to_idle() {
    let mut runtime = runtime();
    runtime
        .execute(Command::ObserveSources {
            characters: vec![user(1)],
        })
        .expect("observe");
    runtime
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect("begin");
    runtime
        .execute(Command::ObserveSources {
            characters: vec![assistant(2)],
        })
        .expect("observe");
    let transaction_id = match runtime
        .execute(Command::PrepareFinish {
            terminal: Terminal::Completed,
            input_tokens: None,
        })
        .expect("prepare")
    {
        CommandResult::FinishPrepared { transaction_id, .. } => transaction_id,
        other => panic!("unexpected result: {other:?}"),
    };
    runtime
        .execute(Command::DiscardPrepared { transaction_id })
        .expect("discard");
    runtime
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect("new sampling after discard");
}

#[test]
fn failed_prepare_faults_the_portable_runtime() {
    let mut runtime = runtime();
    runtime
        .execute(Command::ObserveSources {
            characters: vec![user(1)],
        })
        .expect("observe");
    runtime
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect("begin");
    runtime
        .execute(Command::RegisterExecution {
            key: "pending".to_string(),
        })
        .expect("register pending execution");

    runtime
        .execute(Command::PrepareFinish {
            terminal: Terminal::Completed,
            input_tokens: None,
        })
        .expect_err("pending execution prevents prepare");
    let faulted = runtime
        .execute(Command::Preview)
        .expect_err("consumed sampling handle cannot be retried");
    assert_eq!(faulted.code, "invalid_state");
    assert_eq!(faulted.message, "runtime is faulted");
}

#[test]
fn canonical_replay_installs_the_prepared_projection() {
    let mut live = runtime();
    let user = user(1);
    let assistant = assistant(2);
    live.execute(Command::ObserveSources {
        characters: vec![user.clone()],
    })
    .expect("observe user");
    let started = match live
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect("begin")
    {
        CommandResult::SamplingStarted { record } => *record,
        other => panic!("unexpected result: {other:?}"),
    };
    live.execute(Command::ObserveSources {
        characters: vec![assistant.clone()],
    })
    .expect("observe assistant");
    let (transaction_id, committed, expected_plan, expected_projection) = match live
        .execute(Command::PrepareFinish {
            terminal: Terminal::Completed,
            input_tokens: Some(17),
        })
        .expect("prepare")
    {
        CommandResult::FinishPrepared {
            transaction_id,
            record,
            context_plan,
            projection,
        } => (transaction_id, *record, context_plan, projection),
        other => panic!("unexpected result: {other:?}"),
    };
    live.execute(Command::InstallPrepared { transaction_id })
        .expect("install");

    let mut replayed = runtime();
    let replay = replayed
        .execute(Command::Replay {
            inputs: vec![
                ReplayItem::Source { character: user },
                ReplayItem::Archive {
                    record: Box::new(started),
                },
                ReplayItem::Source {
                    character: assistant,
                },
                ReplayItem::Archive {
                    record: Box::new(committed),
                },
            ],
        })
        .expect("replay");
    match replay {
        CommandResult::ReplayInstalled {
            context_plan,
            projection,
            applied_commits,
            ..
        } => {
            assert_eq!(context_plan, Some(expected_plan));
            assert_eq!(projection, expected_projection);
            assert_eq!(applied_commits.len(), 1);
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[test]
fn incremental_replay_matches_one_shot_replay() {
    let mut live = runtime();
    let user = user(1);
    let assistant = assistant(2);
    live.execute(Command::ObserveSources {
        characters: vec![user.clone()],
    })
    .expect("observe user");
    let started = match live
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect("begin")
    {
        CommandResult::SamplingStarted { record } => *record,
        other => panic!("unexpected result: {other:?}"),
    };
    live.execute(Command::ObserveSources {
        characters: vec![assistant.clone()],
    })
    .expect("observe assistant");
    live.execute(Command::RegisterExecution {
        key: "exec".to_string(),
    })
    .expect("register");
    live.execute(Command::StageExecution {
        key: "exec".to_string(),
        execution_ref: "exec".to_string(),
        operation: Operation::Open {
            summary: "open".to_string(),
        },
    })
    .expect("stage");
    live.execute(Command::FinishExecution {
        key: "exec".to_string(),
        succeeded: true,
    })
    .expect("finish exec");
    let (transaction_id, committed, expected_plan, expected_projection) = match live
        .execute(Command::PrepareFinish {
            terminal: Terminal::Completed,
            input_tokens: Some(17),
        })
        .expect("prepare")
    {
        CommandResult::FinishPrepared {
            transaction_id,
            record,
            context_plan,
            projection,
        } => (transaction_id, *record, context_plan, projection),
        other => panic!("unexpected result: {other:?}"),
    };
    live.execute(Command::InstallPrepared { transaction_id })
        .expect("install");

    let inputs = vec![
        ReplayItem::Source {
            character: user.clone(),
        },
        ReplayItem::Archive {
            record: Box::new(started.clone()),
        },
        ReplayItem::Source {
            character: assistant.clone(),
        },
        ReplayItem::Archive {
            record: Box::new(committed.clone()),
        },
    ];
    let mut one_shot = runtime();
    let one_shot_result = one_shot
        .execute(Command::Replay {
            inputs: inputs.clone(),
        })
        .expect("one-shot replay");

    let mut incremental = runtime();
    incremental
        .execute(Command::ReplayBegin)
        .expect("replay begin");
    incremental
        .execute(Command::ReplayApply {
            inputs: inputs[..2].to_vec(),
        })
        .expect("replay apply prefix");
    incremental
        .execute(Command::ReplayApply {
            inputs: inputs[2..].to_vec(),
        })
        .expect("replay apply suffix");
    let incremental_result = incremental
        .execute(Command::ReplayFinish)
        .expect("replay finish");

    match (one_shot_result, incremental_result) {
        (
            CommandResult::ReplayInstalled {
                context_plan: one_plan,
                projection: one_projection,
                applied_commits: one_commits,
                ..
            },
            CommandResult::ReplayInstalled {
                context_plan: split_plan,
                projection: split_projection,
                applied_commits: split_commits,
                ..
            },
        ) => {
            assert_eq!(one_plan, Some(expected_plan));
            assert_eq!(one_projection, expected_projection);
            assert_eq!(split_plan, one_plan);
            assert_eq!(split_projection, one_projection);
            assert_eq!(split_commits, one_commits);
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[test]
fn tool_catalog_matches_spine_core_names_and_spawn_arity() {
    let runtime = runtime();
    let catalog: Value = serde_json::from_str(&runtime.tool_catalog_json().expect("catalog"))
        .expect("json");
    let ids: Vec<&str> = catalog
        .as_array()
        .expect("array")
        .iter()
        .map(|tool| tool["id"].as_str().expect("id"))
        .collect();
    assert_eq!(ids, ["open", "close", "next", "spawn"]);
    let spawn = catalog.as_array().unwrap().iter().find(|tool| tool["id"] == "spawn").unwrap();
    assert_eq!(spawn["parameters"]["properties"]["tasks"]["minItems"], 2);
}

#[test]
fn json_dispatch_rejects_requests_over_four_mib() {
    let mut runtime = runtime();
    let oversized = "x".repeat(4 * 1024 * 1024 + 1);
    let envelope = runtime.dispatch_json(&oversized);
    let value: Value = serde_json::from_str(&envelope).expect("json");
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "request_too_large");
}

#[test]
fn feature_off_does_not_enable_sampling_implicitly() {
    let mut runtime = PortableRuntime::new(InitRequest {
        schema: ABI_SCHEMA.to_string(),
        thread: "feature-off".to_string(),
        epoch: 0,
        config_toml: None,
        features: Vec::new(),
    })
    .expect("feature-off runtime");
    let error = runtime
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect_err("sampling stays disabled");
    assert_eq!(error.code, "core_error");
}

#[test]
fn live_compact_is_idle_transaction_and_returns_new_projection() {
    let mut runtime = runtime();
    runtime
        .execute(Command::ObserveSources {
            characters: vec![user(1), assistant(2)],
        })
        .expect("observe source history");
    let barrier = SpineCompactBarrierV1::new(
        ThreadNamespace::parse("portable-test").expect("thread"),
        spine_core::host::ContextEpoch::new(0),
        spine_core::host::ContextEpoch::new(1),
        RawBoundary(2),
        vec![RawBoundary(3)],
    )
    .expect("valid compact barrier");
    let compacted = runtime
        .execute(Command::Compact { barrier })
        .expect("compact");
    match compacted {
        CommandResult::Compacted {
            context_plan,
            projection,
        } => {
            assert_eq!(context_plan.epoch, spine_core::host::ContextEpoch::new(1));
            assert_eq!(projection.last_boundary, Some(RawBoundary(3)));
        }
        other => panic!("unexpected result: {other:?}"),
    }
    runtime
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect("compact returns runtime to idle");
}

#[test]
fn source_snapshot_and_namespace_continuation_expose_exact_bindings() {
    let mut runtime = runtime();
    let observed = runtime
        .execute(Command::ObserveSources {
            characters: vec![user(1), assistant(2)],
        })
        .expect("observe sources");
    let observed_ids = match observed {
        CommandResult::SourcesObserved { source_ids } => source_ids,
        other => panic!("unexpected result: {other:?}"),
    };

    let snapshot = runtime
        .execute(Command::SourceSnapshot)
        .expect("source snapshot");
    match snapshot {
        CommandResult::SourceSnapshot { source } => {
            assert_eq!(source.thread, "portable-test");
            assert_eq!(source.cells.len(), 2);
            assert_eq!(source.cells[0].source_id, observed_ids[0]);
            assert_eq!(source.cells[1].boundary, 2);
        }
        other => panic!("unexpected result: {other:?}"),
    }

    let continued = runtime
        .execute(Command::ContinueNamespace {
            thread: "portable-fork".to_string(),
        })
        .expect("continue namespace");
    match continued {
        CommandResult::NamespaceContinued { source } => {
            assert_eq!(source.thread, "portable-fork");
            assert!(
                source
                    .cells
                    .iter()
                    .all(|cell| cell.source_id.thread().as_str() == "portable-fork")
            );
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

fn commit_sampling(runtime: &mut PortableRuntime, executions: Vec<Operation>, output: SourceCharacter) -> Value {
    runtime
        .execute(Command::BeginSampling {
            prompt_digest: None,
        })
        .expect("begin");
    for (index, operation) in executions.into_iter().enumerate() {
        let key = format!("call-{index}");
        runtime
            .execute(Command::RegisterExecution { key: key.clone() })
            .expect("register");
        runtime
            .execute(Command::StageExecution {
                key: key.clone(),
                execution_ref: key.clone(),
                operation,
            })
            .expect("stage");
        runtime
            .execute(Command::FinishExecution {
                key,
                succeeded: true,
            })
            .expect("finish execution");
    }
    runtime
        .execute(Command::ObserveSources {
            characters: vec![output],
        })
        .expect("observe output");
    let transaction_id = match runtime
        .execute(Command::PrepareFinish {
            terminal: Terminal::Completed,
            input_tokens: None,
        })
        .expect("prepare")
    {
        CommandResult::FinishPrepared { transaction_id, .. } => transaction_id,
        other => panic!("unexpected result: {other:?}"),
    };
    match runtime
        .execute(Command::InstallPrepared { transaction_id })
        .expect("install")
    {
        CommandResult::PreparedInstalled { projection, .. } => {
            serde_json::to_value(projection).expect("projection json")
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

fn spawn_nodes(projection: &Value) -> Vec<Value> {
    projection["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .filter(|node| node["kind"] == "Spawn")
        .cloned()
        .collect()
}

#[test]
fn spawn_arrival_and_reply_cross_the_json_abi() {
    let mut runtime = runtime();
    runtime
        .execute(Command::ObserveSources {
            characters: vec![user(1)],
        })
        .expect("observe user");
    let spawn = serde_json::from_value::<Operation>(serde_json::json!({
        "type": "spawn",
        "tasks": [
            { "summary": "first", "prompt": "do the first part" },
            { "summary": "second", "prompt": "do the second part" }
        ]
    }))
    .expect("spawn operation");
    let projection = commit_sampling(&mut runtime, vec![spawn], assistant(2));
    let births = spawn_nodes(&projection);
    assert_eq!(births.len(), 2);
    assert!(births.iter().all(|node| node["spawn_outcome"].is_null()));
    assert_eq!(births[0]["memory"][0]["Birth"]["task"]["summary"], "first");

    let arrival = serde_json::json!({
        "schema": ABI_SCHEMA,
        "request": {
            "type": "observe_sources",
            "characters": [{
                "type": "arrival",
                "boundary": 3,
                "arrival": {
                    "producer": births[0]["id"],
                    "outcome": "completed",
                    "memory": "first part done"
                }
            }]
        }
    });
    let response: Value =
        serde_json::from_str(&runtime.dispatch_json(&arrival.to_string())).expect("response");
    assert_eq!(response["ok"], true, "{response}");

    let reply = serde_json::from_value::<SourceCharacter>(serde_json::json!({
        "type": "message", "boundary": 4, "role": "reply", "content": "first part is in"
    }))
    .expect("reply character");
    let projection = commit_sampling(&mut runtime, Vec::new(), reply);
    let births = spawn_nodes(&projection);
    assert_eq!(births[0]["spawn_outcome"], "completed");
    assert!(births[1]["spawn_outcome"].is_null());
}
