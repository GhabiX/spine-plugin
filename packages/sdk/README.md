# @spinejit/spine-sdk

Portable SpineJIT protocol types and the Node WASM runtime used by SpineJIT host plugins.

The Node entrypoint is `@spinejit/spine-sdk/node`. `@spinejit/spine-sdk/host` is what every host adapter shares: the controller that drives a sampling's prepare, persist, install and publish steps, the host adapter contract, Spawn child coordination, Spine tool input decoding,
the model-visible text of Spine items, and `loadSpineConfigToml()` for
`spine.toml`, the SpineConfig every host passes as `configToml`. The package includes the matching Node WASM artifact; keep the SDK version aligned with `@spinejit/spine-host` and `@spinejit/pi-spinejit`.
