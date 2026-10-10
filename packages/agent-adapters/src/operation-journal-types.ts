/** Public, data-only journal contract. A journal grants no execution or recovery authority. */
export interface OperationIdentity { owner: string; provider: string; operation: string }
export type JournalAction = "lease_acquire" | "lease_release" | "namespace_create" | "namespace_start" | "namespace_remove" | "namespace_exec" | "volume_create" | "volume_remove" | "public_install" | "public_manifest_publish" | "public_checkpoint_publish";
export type ResourceRole = "runtime" | "init" | "tools" | "auth";
export interface JournalIntent { intent_id: string; action: JournalAction; role?: ResourceRole; resource_id?: string }
export interface JournalReceipt { intent_id: string; outcome: "verified" | "rejected_before_dispatch"; lease_id?: string; resource_id?: string }
export interface JournalCapture { intent_id: string; resource_id: string }
export type JournalDurability = "process_crash" | "file_and_directory_synced";
export interface OperationJournalSnapshot {
  identity: Readonly<OperationIdentity>;
  lease_id?: string;
  namespace_ids: readonly string[];
  captures: readonly JournalCapture[];
  pending: readonly JournalIntent[];
  last_sequence: number;
  last_hash: string;
  terminal: boolean;
  durability: JournalDurability;
}
export interface OperationJournal {
  readonly identity: Readonly<OperationIdentity>;
  appendIntent(intent: JournalIntent): Promise<void>;
  appendReceipt(receipt: JournalReceipt): Promise<void>;
  appendCapture(capture: JournalCapture): Promise<void>;
  complete(): Promise<void>;
  snapshot(): OperationJournalSnapshot;
}
export type JournalReadReason = "operation_journal_missing" | "operation_journal_invalid" | "operation_journal_overflow" | "operation_journal_io_failed";
export interface OperationJournalReadResult { status: "available" | "unavailable" | "blocked"; reason?: JournalReadReason; operations: OperationJournalSnapshot[] }
