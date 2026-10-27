use serde::Deserialize;
use serde::Serialize;
use spine_core::host::ContextItem;
use spine_core::host::ContextPlanRecipe;
use spine_core::host::ExecutionOrigin;
use spine_core::host::Message;
use spine_core::host::MessageRole;
use spine_core::host::RawBoundary;
use spine_core::host::SamplingArchiveRecord;
use spine_core::host::SamplingCommitId;
use spine_core::host::SourceCellId;
use spine_core::host::SpawnArrival;
use spine_core::host::SpawnTask;
use spine_core::host::SpineChar;
use spine_core::host::SpineCompactBarrierV1;
use spine_core::host::SpineOperationFact;
use spine_core::host::SpineProjection;
use spine_core::host::TokenUsageSample;

pub const ABI_SCHEMA: &str = "spine-sdk/v3";
pub const SOURCE_SNAPSHOT_SCHEMA: &str = "spine.source.snapshot.v1";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitRequest {
    pub schema: String,
    pub thread: String,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub config_toml: Option<String>,
    #[serde(default)]
    pub features: Vec<FeatureFlag>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeatureFlag {
    Jit,
    Spawn,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    pub schema: String,
    pub request: Command,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    ObserveSources {
        characters: Vec<SourceCharacter>,
    },
    BeginSampling {
        #[serde(default)]
        prompt_digest: Option<String>,
    },
    RegisterExecution {
        key: String,
    },
    StageExecution {
        key: String,
        execution_ref: String,
        operation: Operation,
    },
    FinishExecution {
        key: String,
        succeeded: bool,
    },
    PrepareFinish {
        terminal: Terminal,
        #[serde(default)]
        input_tokens: Option<u64>,
    },
    InstallPrepared {
        transaction_id: String,
    },
    DiscardPrepared {
        transaction_id: String,
    },
    Compact {
        barrier: SpineCompactBarrierV1,
    },
    Preview,
    SourceSnapshot,
    ContinueNamespace {
        thread: String,
    },
    Replay {
        inputs: Vec<ReplayItem>,
    },
    ReplayBegin,
    ReplayApply {
        inputs: Vec<ReplayItem>,
    },
    ReplayFinish,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Terminal {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceCharacter {
    Message {
        boundary: u64,
        role: Role,
        content: String,
    },
    Opaque {
        boundary: u64,
    },
    Synthetic {
        boundary: u64,
        item: ContextItem,
    },
    Arrival {
        boundary: u64,
        arrival: SpawnArrival,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    ContextualUser,
    Assistant,
    Reply,
    Developer,
    System,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Open {
        summary: String,
    },
    Close {
        memory: String,
    },
    Next {
        closed_memory: String,
        next_summary: String,
    },
    Spawn {
        tasks: Vec<SpawnTaskDto>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpawnTaskDto {
    pub summary: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReplayItem {
    Source { character: SourceCharacter },
    Archive { record: Box<SamplingArchiveRecord> },
    Compact { barrier: SpineCompactBarrierV1 },
    Usage { boundary: u64, input_tokens: i64 },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandResult {
    SourcesObserved {
        source_ids: Vec<SourceCellId>,
    },
    SamplingStarted {
        record: Box<SamplingArchiveRecord>,
    },
    ExecutionRegistered,
    ExecutionStaged,
    ExecutionFinished,
    FinishPrepared {
        transaction_id: String,
        record: Box<SamplingArchiveRecord>,
        context_plan: ContextPlanRecipe,
        projection: SpineProjection,
    },
    SamplingOrphaned,
    PreparedInstalled {
        transaction_id: String,
        context_plan: ContextPlanRecipe,
        projection: SpineProjection,
    },
    PreparedDiscarded {
        transaction_id: String,
    },
    Compacted {
        context_plan: ContextPlanRecipe,
        projection: SpineProjection,
    },
    Preview {
        context_plan: ContextPlanRecipe,
        projection: SpineProjection,
    },
    SourceSnapshot {
        source: PortableSourceSnapshot,
    },
    NamespaceContinued {
        source: PortableSourceSnapshot,
    },
    ReplayBegun,
    ReplayApplied,
    ReplayInstalled {
        context_plan: Option<ContextPlanRecipe>,
        projection: SpineProjection,
        applied_commits: Vec<SamplingCommitId>,
        source: PortableSourceSnapshot,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct PortableSourceSnapshot {
    pub schema: &'static str,
    pub thread: String,
    pub epoch: u64,
    pub cells: Vec<PortableSourceCell>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PortableSourceCell {
    pub source_id: SourceCellId,
    pub boundary: u64,
    pub item: ContextItem,
}

impl SourceCharacter {
    pub(crate) fn into_core(self) -> SpineChar {
        match self {
            Self::Message {
                boundary,
                role,
                content,
            } => SpineChar::Message(Message {
                boundary: RawBoundary(boundary),
                role: role.into_core(),
                content,
            }),
            Self::Opaque { boundary } => SpineChar::Opaque {
                boundary: RawBoundary(boundary),
            },
            Self::Synthetic { boundary, item } => SpineChar::Synthetic {
                boundary: RawBoundary(boundary),
                item,
            },
            Self::Arrival { boundary, arrival } => SpineChar::Arrival {
                boundary: RawBoundary(boundary),
                arrival,
            },
        }
    }
}

impl Role {
    fn into_core(self) -> MessageRole {
        match self {
            Self::User => MessageRole::User,
            Self::ContextualUser => MessageRole::ContextualUser,
            Self::Assistant => MessageRole::Assistant,
            Self::Reply => MessageRole::Reply,
            Self::Developer => MessageRole::Developer,
            Self::System => MessageRole::System,
        }
    }
}

impl Operation {
    pub(crate) fn into_core(self, execution_ref: String) -> (ExecutionOrigin, SpineOperationFact) {
        let operation = match self {
            Self::Open { summary } => SpineOperationFact::Open { summary },
            Self::Close { memory } => SpineOperationFact::Close { memory },
            Self::Next {
                closed_memory,
                next_summary,
            } => SpineOperationFact::Next {
                closed_memory,
                next_summary,
            },
            Self::Spawn { tasks } => SpineOperationFact::Spawn {
                tasks: tasks.into_iter().map(SpawnTaskDto::into_core).collect(),
            },
        };
        (ExecutionOrigin::Direct { execution_ref }, operation)
    }
}

impl SpawnTaskDto {
    fn into_core(self) -> SpawnTask {
        SpawnTask {
            summary: self.summary,
            prompt: self.prompt,
        }
    }
}

impl ReplayItem {
    pub(crate) fn into_core(self) -> spine_core::host::ReplayInput {
        match self {
            Self::Source { character } => {
                spine_core::host::ReplayInput::Source(character.into_core())
            }
            Self::Archive { record } => spine_core::host::ReplayInput::Archive(*record),
            Self::Compact { barrier } => spine_core::host::ReplayInput::Compact(barrier),
            Self::Usage {
                boundary,
                input_tokens,
            } => spine_core::host::ReplayInput::Usage(TokenUsageSample {
                boundary: RawBoundary(boundary),
                input_tokens,
            }),
        }
    }
}
