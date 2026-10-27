import type { CompactBarrier, SamplingArchiveRecord, SpawnArrival } from "@spinejit/spine-sdk";

export const PI_ADAPTER_ID = "spine-plugin/pi/v1" as const;
export const PI_ARCHIVE_ENTRY_TYPE = "spine.archive.v1" as const;
export const PI_COMPACT_ENTRY_TYPE = "spine.compact.v1" as const;
/** Custom message type of a spawned child's arrival in its parent session. */
export const PI_ARRIVAL_MESSAGE_TYPE = "spine.arrival" as const;

export interface PiSpineArchiveEntry {
  schema: typeof PI_ADAPTER_ID;
  durabilityId: string;
  record: SamplingArchiveRecord;
}

export interface PiSpineCompactEntry {
  schema: typeof PI_ADAPTER_ID;
  barrier: CompactBarrier;
  replacementMessages: readonly unknown[];
  /** Parallel to replacementMessages. Null until the host entry id is known. */
  replacementEntryIds?: readonly (string | null)[];
}

export interface PiArrivalDetails {
  schema: "spine.pi.arrival/v1";
  arrival: SpawnArrival;
}
