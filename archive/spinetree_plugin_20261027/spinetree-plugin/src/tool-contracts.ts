// Input contracts belong to SpineTree. Host and Pi only transport this metadata.
const nonEmptyString = { type: "string", minLength: 1 };
const branch = { ...nonEmptyString, description: "ProjectBranch ID" };

export const toolContracts = {
  read: {
    description: "Read a ProjectBranch, inheritance, children and its active Agent binding from one fixed HEAD. revision is the change token and changes only when that ProjectBranch value changes. Top-level binding is the current non-ended registry entry; binding.agentId identifies a possible send recipient, but does not establish transport reachability. binding may be null. branch.reexecution.binding is the historical allocation snapshot, including its status; use branch.reexecution.state for that operation's progress and top-level binding for current Agent availability.",
    parameters: {
      type: "object",
      properties: { branch },
      required: ["branch"],
      additionalProperties: false,
    },
  },
  change: {
    description: "Atomically apply a non-empty batch of ProjectBranch updates, moves or archives. Each change carries expectedRevision from that branch's read result. Store commits that do not change the branch are retried internally. A different branch value writes nothing and returns applied:false with the current branches. Only goal/constraints/skills/tools are editable; root/live/cyclic moves and archives containing live work are rejected. Archive retains the node, memory and historical Scope mapping; it does not remove canonical context or merge results. Move changes the project parent, not canonical Scope ancestry.",
    parameters: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  type: { const: "update", type: "string" },
                  branch,
                  expectedRevision: { type: "integer", minimum: 0, description: "revision returned by spinetree_read for this branch" },
                  attributes: {
                    type: "object",
                    properties: {
                      goal: nonEmptyString,
                      constraints: { type: "array", items: {} },
                      skills: { type: "array", items: {} },
                      tools: { type: "array", items: {} },
                    },
                    additionalProperties: false,
                  },
                },
                required: ["type", "branch", "expectedRevision", "attributes"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: { const: "move", type: "string" },
                  branch,
                  expectedRevision: { type: "integer", minimum: 0, description: "revision returned by spinetree_read for this branch" },
                  parent: branch,
                },
                required: ["type", "branch", "expectedRevision", "parent"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: { const: "archive", type: "string" },
                  branch,
                  expectedRevision: { type: "integer", minimum: 0, description: "revision returned by spinetree_read for this branch" },
                },
                required: ["type", "branch", "expectedRevision"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["changes"],
      additionalProperties: false,
    },
  },
  send: {
    description: "Enqueue a message to a registered non-ended AgentId and return its receipt immediately after storage. Caller-driven dispatch delivers it later; this tool never waits for the recipient. requestId reuses the same receipt for the same message. Delivery is at least once; queued or delivered does not mean observed.",
    parameters: {
      type: "object",
      properties: {
        to: { ...nonEmptyString, description: "Recipient AgentId, not a branch, scope or session ID" },
        message: nonEmptyString,
        from: { ...nonEmptyString, description: "Optional registered sender AgentId" },
        requestId: { ...nonEmptyString, description: "Optional caller idempotency key for this message" },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  observe: {
    description: "Confirm receipt of a spinetree.message/v1 prompt using receiptId, leaseId and agentId=to from its JSON envelope. Observe during the prompt. A reply to from, if present, requires a supported transport endpoint. agentId must be the non-ended recipient. Repeated observation is idempotent. leaseId is required while leased; queued/failed receipts cannot be observed. Observation does not assert task completion.",
    parameters: {
      type: "object",
      properties: {
        receiptId: nonEmptyString,
        agentId: { ...nonEmptyString, description: "Recipient AgentId (envelope.to)" },
        leaseId: { ...nonEmptyString, description: "Delivery attempt token from the message envelope; required while leased" },
      },
      required: ["receiptId", "agentId"],
      additionalProperties: false,
    },
  },
  rejuvenate: {
    description: "Request a new Agent for a capped ProjectBranch through the caller's provision adapter. parent must be an ancestor and the target must have no active Agent. Returns the new binding and inherited context.",
    parameters: {
      type: "object",
      properties: {
        parent: { ...branch, description: "Ancestor ProjectBranch ID" },
        branch,
        request: { ...nonEmptyString, description: "Optional instructions for the provision adapter" },
      },
      required: ["parent", "branch"],
      additionalProperties: false,
    },
  },
} as const;
