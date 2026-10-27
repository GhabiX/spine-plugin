import type { CompactBarrier, SpineRuntimeClient } from "@spinejit/spine-sdk";

import {
  createHostAdapter,
  type HostContextEnvelope,
  type HostOwnershipClaim,
  type PublishedContext,
  type SpineCompactMetadata,
  type SpineHostAdapter,
} from "../index.js";

export * from "./messages.js";
export * from "./lifecycle.js";
export * from "./protocol.js";
export * from "./recovery.js";
import {
  PI_ADAPTER_ID,
  PI_ARCHIVE_ENTRY_TYPE,
  PI_COMPACT_ENTRY_TYPE,
  type PiSpineArchiveEntry,
  type PiSpineCompactEntry,
} from "./protocol.js";

export interface PiSpinePort<TMessage> {
  claimOwnership(claim: HostOwnershipClaim): Promise<void>;
  appendCustomEntry(type: typeof PI_ARCHIVE_ENTRY_TYPE, entry: PiSpineArchiveEntry): Promise<void>;
  appendCustomEntry(
    type: typeof PI_COMPACT_ENTRY_TYPE,
    entry: PiSpineCompactEntry,
  ): Promise<void>;
  materializeContext(context: PublishedContext): Promise<readonly TMessage[]>;
  replaceContext(context: HostContextEnvelope<TMessage>): Promise<void>;
}

export interface PiSpineAdapterOptions<TMessage> {
  enabled: boolean;
  runtime: SpineRuntimeClient;
  host: PiSpinePort<TMessage>;
}

export async function createPiSpineAdapter<TMessage>(
  options: PiSpineAdapterOptions<TMessage>,
): Promise<SpineHostAdapter | null> {
  if (!options.enabled) {
    return null;
  }

  return createHostAdapter({
    runtime: options.runtime,
    host: {
      claimOwnership: (claim) => options.host.claimOwnership(claim),
      persistArchive: (entry) =>
        options.host.appendCustomEntry(PI_ARCHIVE_ENTRY_TYPE, {
          schema: PI_ADAPTER_ID,
          durabilityId: entry.durabilityId,
          record: entry.record,
        }),
      persistCompact: (barrier, metadata) => {
        const persisted = compactPersistence(metadata);
        return options.host.appendCustomEntry(PI_COMPACT_ENTRY_TYPE, {
          schema: PI_ADAPTER_ID,
          barrier,
          replacementMessages: persisted.messages,
          ...(persisted.entryIds === undefined ? {} : { replacementEntryIds: persisted.entryIds }),
        });
      },
      context: {
        materialize: (context) => options.host.materializeContext(context),
        publishAtomic: (context) => options.host.replaceContext(context),
      },
    },
  });
}

function compactPersistence(metadata: SpineCompactMetadata | undefined): {
  messages: readonly unknown[];
  entryIds?: readonly (string | null)[];
} {
  if (metadata !== undefined && "messages" in metadata) {
    if (metadata.messages.length === 0) {
      throw new Error("Pi compact persistence requires replacement metadata");
    }
    if (metadata.entryIds.length !== metadata.messages.length) {
      throw new Error("Pi compact replacement entry ids do not match replacement messages");
    }
    return { messages: metadata.messages, entryIds: metadata.entryIds };
  }
  if (metadata === undefined || metadata.length === 0) {
    throw new Error("Pi compact persistence requires replacement metadata");
  }
  return { messages: metadata };
}
