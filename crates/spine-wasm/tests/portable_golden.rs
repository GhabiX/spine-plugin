use serde_json::Value;
use serde_json::json;
use spine_wasm::PortableRuntime;

#[test]
fn native_runtime_matches_the_portable_golden_trace() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/conformance/portable-runtime-golden.json"
    ))
    .expect("golden fixture must be valid JSON");
    let expected = &fixture["expected"];
    let mut runtime = PortableRuntime::from_json(&fixture["init"].to_string())
        .expect("golden runtime must initialize");
    let mut outputs = fixture["requests"]
        .as_array()
        .expect("golden requests must be an array")
        .iter()
        .map(|request| {
            serde_json::from_str::<Value>(&runtime.dispatch_json(&request.to_string()))
                .expect("runtime response must be valid JSON")
        })
        .collect::<Vec<_>>();

    let transaction_id = outputs[3]["result"]["transaction_id"]
        .as_str()
        .expect("prepared transaction must have an id");
    let install = json!({
        "schema": "spine-sdk/v3",
        "request": {
            "type": "install_prepared",
            "transaction_id": transaction_id,
        },
    });
    outputs.push(
        serde_json::from_str(&runtime.dispatch_json(&install.to_string()))
            .expect("install response must be valid JSON"),
    );

    assert_eq!(
        outputs[0]["result"]["source_ids"][0],
        expected["first_source_id"]
    );
    assert_eq!(
        outputs[1]["result"]["record"]["record"]["attempt_id"],
        expected["started_attempt_id"]
    );
    assert_eq!(
        outputs[2]["result"]["source_ids"][0],
        expected["second_source_id"]
    );
    assert_eq!(
        outputs[3]["result"]["transaction_id"],
        expected["transaction_id"]
    );
    assert_eq!(
        outputs[3]["result"]["record"]["record"]["commit_id"],
        expected["commit_id"]
    );
    assert_eq!(
        outputs[3]["result"]["projection"]["cursor"],
        expected["cursor"]
    );
    assert_eq!(
        outputs[3]["result"]["projection"]["last_boundary"],
        expected["last_boundary"]
    );
    assert_eq!(
        outputs[4]["result"]["transaction_id"],
        expected["transaction_id"]
    );
    assert_eq!(outputs[3]["result"]["context_plan"], expected["context_plan"]);
    assert_eq!(outputs[4]["result"]["context_plan"], expected["context_plan"]);
    assert_eq!(
        outputs[4]["result"]["projection"],
        outputs[3]["result"]["projection"]
    );
}
