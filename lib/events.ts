import { SyncEvent } from '@Services/sync/events';
export { SyncEvent as SyncEvents };

export enum ApplicationEvents {
  SignedIn = 2,
  SignedOut = 3,
  CompletedSync = 5,
  FailedSync = 6,
  HighLatencySync = 7,
  EnteredOutOfSync = 8,
  ExitedOutOfSync = 9,

  /** 
   * The application has finished it `prepareForLaunch` state and is now ready for unlock 
   * Called when the application has initialized and is ready for launch, but before
   * the application has been unlocked, if applicable. Use this to do pre-launch
   * configuration, but do not attempt to access user data like notes or tags.
   */
  Started = 10,

  /** 
   * The applicaiton is fully unlocked and ready for i/o 
   * Called when the application has been fully decrypted and unlocked. Use this to
   * to begin streaming data like notes and tags.
   */
  Launched = 11,

  LocalDataLoaded = 12,

  /**
   * When the root key or root key wrapper changes. Includes events like account state
   * changes (registering, signing in, changing pw, logging out) and passcode state
   * changes (adding, removing, changing).
   */
  KeyStatusChanged = 13,
  MajorDataChange = 14,
  CompletedRestart = 15,
  LocalDataIncrementalLoad = 16,
  SyncStatusChanged = 17,
  WillSync = 18,
  InvalidSyncSession = 19,
  LocalDatabaseReadError = 20,
  LocalDatabaseWriteError = 21
};

export function applicationEventForSyncEvent(syncEvent: SyncEvent) {
  return ({
    [SyncEvent.FullSyncCompleted]: ApplicationEvents.CompletedSync,
    [SyncEvent.SyncError]: ApplicationEvents.FailedSync,
    [SyncEvent.SyncTakingTooLong]: ApplicationEvents.HighLatencySync,
    [SyncEvent.EnterOutOfSync]: ApplicationEvents.EnteredOutOfSync,
    [SyncEvent.ExitOutOfSync]: ApplicationEvents.ExitedOutOfSync,
    [SyncEvent.LocalDataLoaded]: ApplicationEvents.LocalDataLoaded,
    [SyncEvent.MajorDataChange]: ApplicationEvents.MajorDataChange,
    [SyncEvent.LocalDataIncrementalLoad]: ApplicationEvents.LocalDataIncrementalLoad,
    [SyncEvent.StatusChanged]: ApplicationEvents.SyncStatusChanged,
    [SyncEvent.SyncWillBegin]: ApplicationEvents.WillSync,
    [SyncEvent.InvalidSession]: ApplicationEvents.InvalidSyncSession,
    [SyncEvent.DatabaseReadError]: ApplicationEvents.LocalDatabaseReadError,
    [SyncEvent.DatabaseWriteError]: ApplicationEvents.LocalDatabaseWriteError
  } as any)[syncEvent];
}