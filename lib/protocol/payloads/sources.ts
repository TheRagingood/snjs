export enum PayloadSource {
  RemoteRetrieved = 1,
  RemoteSaved = 2,
  /* The payload returned by offline sync operation */
  LocalSaved = 3,
  LocalRetrieved = 4,
  LocalDirtied = 5,
  /** Payloads retrieved from an external
   extension/component */
  ComponentRetrieved = 6,
  /** When a component is installed by the desktop
   and some of its values change */
  DesktopInstalled = 7,
  /** aciton-based Extensions like note history */
  RemoteActionRetrieved = 8,
  FileImport = 9,
  RemoteConflict = 10,
  ImportConflict = 11,
  /** Payloads that are saved or saving in the
   current sync request */
  SavedOrSaving = 12,
  /** Payloads that have been decrypted for the convenience
   of consumers who can only work with decrypted formats. The
   decrypted payloads exist in transient, ephemeral space, and
   are not used in anyway. */
  DecryptedTransient = 13,
  ConflictUuid = 14,
  ConflictData = 15,
  /* Payload when a client modifies item property then maps it to update UI */
  LocalChanged = 16,
  SessionHistory = 17
};

export function isPayloadSourceRetrieved(source: PayloadSource) {
  return [
    PayloadSource.RemoteRetrieved,
    PayloadSource.ComponentRetrieved,
    PayloadSource.RemoteActionRetrieved
  ].includes(source);
}