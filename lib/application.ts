import { SyncEvents } from '@Lib/events';
import { StorageEncryptionPolicies } from './services/storage_service';
import { Uuid } from '@Lib/uuid';
import { BackupFile } from './services/protocol_service';
import { EncryptionIntent } from '@Protocol/intents';
import { SyncOptions } from './services/sync/sync_service';
import { SNSmartTag } from './models/app/smartTag';
import { SNItem } from '@Models/core/item';
import { SNPredicate } from '@Models/core/predicate';
import { PurePayload } from '@Payloads/pure_payload';
import { ChallengeResponse } from './challenges';
import { ChallengeOrchestrator, OrchestratorFill } from './services/challenge_service';
import { PureService } from '@Lib/services/pure_service';
import { SNPureCrypto } from 'sncrypto';
import { Environment, Platform } from './platforms';
import { removeFromArray, isNullOrUndefined } from '@Lib/utils';
import { ContentType } from '@Models/content_types';
import { CopyPayload, PayloadContent, CreateMaxPayloadFromAnyObject } from '@Payloads/generator';
import { PayloadSource } from '@Payloads/sources';
import { CreateItemFromPayload } from '@Models/generator';
import {
  ApplicationEvents,
  ApplicationStages,
  applicationEventForSyncEvent,
  ChallengeType,
  ChallengeReason,
  Challenge
} from '@Lib/index';
import { StoragePersistencePolicies, StorageValueModes } from '@Services/storage_service';
import {
  SNMigrationService,
  SNActionsService,
  SNApiService,
  SNModelManager,
  SNProtocolService,
  SNPrivilegesService,
  SNHistoryManager,
  SNAlertService,
  SNSessionManager,
  SNComponentManager,
  SNHttpService,
  SNSingletonManager,
  SNStorageService,
  SNSyncService,
  ChallengeService,
  SyncModes,
  SyncQueueStrategy
} from './services';
import { DeviceInterface } from './device_interface';

/** How often to automatically sync, in milliseconds */
const DEFAULT_AUTO_SYNC_INTERVAL = 30000;

type LaunchCallback = {
  receiveChallenge: (
    challenge: Challenge,
    orchestor: ChallengeOrchestrator
  ) => void
}
type ApplicationEventCallback = (
  event: ApplicationEvents,
  data?: any
) => Promise<void>;
type ApplicationObserver = {
  singleEvent?: ApplicationEvents
  callback: ApplicationEventCallback
}
type ItemStream = (
  items: SNItem[],
  contentTypes: ContentType[],
  source?: PayloadSource,
  sourceKey?: string
) => void
type ObserverRemover = () => void

/** The main entrypoint of an application. */
export class SNApplication {

  public environment: Environment
  public platform: Platform
  public namespace: string
  private swapClasses?: any[]
  private skipClasses?: any[]

  private crypto?: SNPureCrypto
  public deviceInterface?: DeviceInterface

  private migrationService?: SNMigrationService
  private alertService?: SNAlertService
  private httpService?: SNHttpService
  private modelManager?: SNModelManager
  private protocolService?: SNProtocolService
  private storageService?: SNStorageService
  private apiService?: SNApiService
  private sessionManager?: SNSessionManager
  private syncService?: SNSyncService
  private challengeService?: ChallengeService
  private singletonManager?: SNSingletonManager
  private componentManager?: SNComponentManager
  private privilegesService?: SNPrivilegesService
  private actionsManager?: SNActionsService
  private historyManager?: SNHistoryManager

  private eventHandlers: ApplicationObserver[] = [];
  private services: PureService[] = [];
  private streamRemovers: ObserverRemover[] = [];
  private serviceObservers: ObserverRemover[] = [];
  private managedSubscribers: ObserverRemover[] = [];
  private autoSyncInterval: any

  /** True if the result of deviceInterface.openDatabase yields a new database being created */
  private createdNewDatabase = false
  /** True if the application has started (but not necessarily launched) */
  private started = false
  /** True if the application has launched */
  private launched = false
  /** Whether the application has been destroyed via .deinit() */
  private dealloced = false

  /**
   * @param environment The Environment that identifies your application.
   * @param platform The Platform that identifies your application.
   * @param namespace A unique identifier to namespace storage and
   *  other persistent properties. Defaults to empty string.
   * @param crypto The platform-dependent instance of SNCrypto to use. 
   * Web uses SNWebCrypto, mobile uses SNReactNativeCrypto.
   * @param swapClasses Gives consumers the ability to provide their own custom 
   * subclass for a service. swapClasses should be an array  of key/value pairs 
   * consisting of keys 'swap' and 'with'.  'swap' is the base class you wish to replace, 
   * and 'with'  is the custom subclass to use.
   * @param skipClasses An array of classes to skip making services for.
   */
  constructor(
    environment: Environment,
    platform: Platform,
    deviceInterface: DeviceInterface,
    namespace?: string,
    crypto?: SNPureCrypto,
    swapClasses?: any[],
    skipClasses?: any[],
  ) {
    if (!deviceInterface) {
      throw 'Device Interface must be supplied.';
    }
    if (!environment) {
      throw 'Environment must be supplied when creating an application.';
    }
    if (!platform) {
      throw 'Platform must be supplied when creating an application.';
    }
    this.environment = environment;
    this.platform = platform;
    this.namespace = namespace || '';
    this.deviceInterface = deviceInterface;
    this.crypto = crypto;
    this.swapClasses = swapClasses;
    this.skipClasses = skipClasses;
    this.constructServices();
  }

  /**
   * The first thing consumers should call when starting their app.
   * This function will load all services in their correct order.
   */
  async prepareForLaunch(callback: LaunchCallback) {
    this.setLaunchCallback(callback);
    const databaseResult = await this.deviceInterface!.openDatabase()
      .catch((error) => {
        this.notifyEvent(ApplicationEvents.LocalDatabaseReadError, error);
        return undefined;
      });
    this.createdNewDatabase = databaseResult?.isNewDatabase || false;
    await this.migrationService!.initialize();
    await this.handleStage(ApplicationStages.PreparingForLaunch_0);
    await this.storageService!.initializeFromDisk();
    await this.protocolService!.initialize();
    await this.handleStage(ApplicationStages.ReadyForLaunch_05);
    this.started = true;
    await this.notifyEvent(ApplicationEvents.Started);
  }

  private setLaunchCallback(callback: LaunchCallback) {
    this.challengeService!.challengeHandler = callback.receiveChallenge;
  }

  /**
   * Runs migrations, handles device authentication, unlocks application, and
   * issues a callback if a device activation requires user input
   * (i.e local passcode or fingerprint).
   * @param awaitDatabaseLoad  
   * Option to await database load before marking the app as ready. 
   */
  public async launch(awaitDatabaseLoad = false) {
    this.launched = false;
    const launchChallenge = await this.challengeService!.getLaunchChallenge();
    if (launchChallenge) {
      const response = await this.challengeService!.promptForChallengeResponse(launchChallenge);
      await this.handleLaunchChallengeResponse(response);
    }

    if (this.storageService!.isStorageWrapped()) {
      await this.storageService!.decryptStorage();
    }
    await this.handleStage(ApplicationStages.StorageDecrypted_09);
    await this.apiService!.loadHost();
    await this.sessionManager!.initializeFromDisk();
    this.historyManager!.initializeFromDisk();

    this.launched = true;
    await this.notifyEvent(ApplicationEvents.Launched);
    await this.handleStage(ApplicationStages.Launched_10);

    const databasePayloads = await this.syncService!.getDatabasePayloads();
    await this.handleStage(ApplicationStages.LoadingDatabase_11);

    if (this.createdNewDatabase) {
      await this.syncService!.onNewDatabaseCreated();
    }
    /**
    * We don't want to await this, as we want to begin allowing the app to function
    * before local data has been loaded fully. We await only initial
    * `getDatabasePayloads` to lock in on database state.
    */
    const loadPromise = this.syncService!.loadDatabasePayloads(databasePayloads)
      .then(async () => {
        if (this.dealloced) {
          throw 'Application has been destroyed.';
        }
        await this.handleStage(ApplicationStages.LoadedDatabase_12);
        this.beginAutoSyncTimer();
        return this.syncService!.sync({
          mode: SyncModes.DownloadFirst
        });
      });
    if (awaitDatabaseLoad) {
      await loadPromise;
    }
  }

  private async handleLaunchChallengeResponse(response: ChallengeResponse) {
    if (response.challenge.types.includes(ChallengeType.LocalPasscode)) {
      let wrappingKey = response.artifacts!.wrappingKey;
      if (!wrappingKey) {
        const value = response.getValueForType(ChallengeType.LocalPasscode);
        wrappingKey = await this.protocolService!.computeWrappingKey(value.value as string);
      }
      await this.protocolService!.unwrapRootKey(wrappingKey);
    }
  }

  private beginAutoSyncTimer() {
    this.autoSyncInterval = this.deviceInterface!.interval(() => {
      this.syncService!.log('Syncing from autosync');
      this.sync();
    }, DEFAULT_AUTO_SYNC_INTERVAL);
  }

  /** 
   * The migrations service is initialized with this function, so that it can retrieve
   * raw challenge values as necessary.
   */
  private getMigrationChallengeResponder() {
    return async (
      challenge: Challenge,
      validate: boolean,
      orchestratorFill: OrchestratorFill
    ) => {
      return this.challengeService!.promptForChallengeResponse(
        challenge,
        validate,
        orchestratorFill
      );
    };
  }

  private async handleStage(stage: ApplicationStages) {
    for (const service of this.services) {
      await service.handleApplicationStage(stage);
    }
  }

  /** 
   * @param singleEvent Whether to only listen for a particular event.
   */
  public addEventObserver(
    callback: ApplicationEventCallback,
    singleEvent?: ApplicationEvents
  ) {
    const observer = { callback, singleEvent };
    this.eventHandlers.push(observer);
    return () => {
      removeFromArray(this.eventHandlers, observer);
    };
  }

  public addSingleEventObserver(
    event: ApplicationEvents,
    callback: ApplicationEventCallback
  ) {
    const filteredCallback = async (firedEvent: ApplicationEvents) => {
      if (firedEvent === event) {
        callback(event);
      }
    };
    return this.addEventObserver(filteredCallback, event);
  }

  private async notifyEvent(event: ApplicationEvents, data?: any) {
    for (const observer of this.eventHandlers.slice()) {
      if (observer.singleEvent && observer.singleEvent === event) {
        await observer.callback(event, data || {});
      } else if (!observer.singleEvent) {
        await observer.callback(event, data || {});
      }
    }
    this.migrationService!.handleApplicationEvent(event);
  }

  /** 
   * Whether the local database has completed loading local items.
   */
  public isDatabaseLoaded() {
    return this.syncService!.isDatabaseLoaded();
  }

  public async savePayload(payload: PurePayload) {
    const dirtied = CopyPayload(
      payload,
      {
        dirty: true
      }
    );
    await this.modelManager!.mapPayloadToLocalItem(
      dirtied,
      PayloadSource.LocalChanged
    );
    await this.syncService!.sync();
  }

  /** 
   * Finds an item by UUID.
   */
  public findItem(uuid: string) {
    return this.modelManager!.findItem(uuid);
  }

  /** 
   * Finds an item by predicate.
  */
  public findItems(predicate: SNPredicate) {
    return this.modelManager!.itemsMatchingPredicate(predicate);
  }

  /**
   * Takes the values of the input item and emits it onto global state.
   */
  public async mergeItem(item: SNItem, source: PayloadSource) {
    return this.modelManager!.mapItem(item, source);
  }

  /** 
   * Creates a managed item.
   * @param needsSync  Whether to mark the item as needing sync. `add` must also be true.
   */
  public async createManagedItem(
    contentType: ContentType,
    content: PayloadContent,
    needsSync = false,
    override?: PurePayload
  ) {
    const item = await this.modelManager!.createItem(
      contentType,
      content,
      true,
      needsSync,
      override
    );
    return item;
  }

  /** 
   * Creates an unmanaged item that can be added later.
   * @param needsSync  Whether to mark the item as needing sync. `add` must also be true.
   */
  public async createTemplateItem(
    contentType: ContentType,
    content?: PayloadContent
  ) {
    const item = await this.modelManager!.createItem(
      contentType,
      content,
    );
    return item;
  }

  /** 
   * Creates an unmanaged item from a payload.
   */
  public createItemFromPayload(payload: PurePayload) {
    return CreateItemFromPayload(payload);
  }

  /** 
   * Creates an unmanaged payload from any object, where the raw object
   * represents the same data a payload would.
   */
  public createPayloadFromObject(object: any) {
    return CreateMaxPayloadFromAnyObject(object);
  }

  /**
   * @returns The date of last sync
   */
  public getLastSyncDate() {
    return this.syncService!.getLastSyncDate();
  }

  public getSyncStatus() {
    return this.syncService!.getStatus();
  }

  public async saveItem(item: SNItem) {
    await this.modelManager!.setItemDirty(item, true);
    await this.syncService!.sync();
  }

  public async saveItems(items: SNItem[]) {
    await this.modelManager!.setItemsDirty(items);
    await this.syncService!.sync();
  }

  /** 
   * @param updateUserModifiedDate  Whether to change the modified date the user 
   * sees of the item.
   */
  public async setItemNeedsSync(item: SNItem, updateUserModifiedDate = false) {
    return this.modelManager!.setItemDirty(item, true, updateUserModifiedDate);
  }

  public async setItemsNeedsSync(items: SNItem[]) {
    return this.modelManager!.setItemsDirty(items);
  }

  public async deleteItem(item: SNItem) {
    await this.modelManager!.setItemToBeDeleted(item);
    return this.sync();
  }

  public async deleteItemLocally(item: SNItem) {
    this.modelManager!.removeItemLocally(item);
  }

  public async emptyTrash() {
    await this.modelManager!.emptyTrash();
    return this.sync();
  }

  public getTrashedItems() {
    return this.modelManager!.trashedItems();
  }

  public getItems(contentType: ContentType | ContentType[]) {
    return this.modelManager!.getItems(contentType);
  }

  public getDisplayableItems(contentType: ContentType) {
    return this.modelManager!.validItemsForContentType(contentType);
  }

  public getNotesMatchingSmartTag(smartTag: SNSmartTag) {
    return this.modelManager!.notesMatchingSmartTag(smartTag);
  }

  public findTag(title: string) {
    return this.modelManager!.findTagByTitle(title);
  }

  public async findOrCreateTag(title: string) {
    return this.modelManager!.findOrCreateTagByTitle(title);
  }

  public getSmartTags() {
    return this.modelManager!.getSmartTags();
  }

  public getNoteCount() {
    return this.modelManager!.noteCount();
  }


  /** 
   * Begin streaming items to display in the UI.
   */
  public streamItems(
    contentType: ContentType | ContentType[],
    stream: ItemStream
  ) {
    const observer = this.modelManager!.addMappingObserver(
      contentType,
      async (allItems, _, __, source, sourceKey) => {
        const includedContentTypes = allItems.map((item) => item.content_type);
        stream(
          allItems,
          includedContentTypes,
          source,
          sourceKey
        );
      }
    );
    this.streamRemovers.push(observer);
    return () => {
      observer();
      removeFromArray(this.streamRemovers, observer);
    };
  }

  /** 
   * Set the server's URL
   */
  public async setHost(host: string) {
    return this.apiService!.setHost(host);
  }

  public async getHost() {
    return this.apiService!.getHost();
  }

  public getUser() {
    if (!this.launched) {
      throw 'Attempting to access user before application unlocked';
    }
    return this.sessionManager!.getUser();
  }

  public async getUserVersion() {
    return this.protocolService!.getUserVersion();
  }

  /**
   * Returns true if there is an upgrade available for the account or passcode
   */
  public async protocolUpgradeAvailable() {
    return this.protocolService!.upgradeAvailable();
  }

  /**
   * Returns true if there is an encryption source available
   */
  public async isEncryptionAvailable() {
    return !isNullOrUndefined(this.getUser()) || this.hasPasscode();
  }

  /** 
   * @returns An array of errors, if any.
   */
  public async upgradeProtocolVersion() {
    const hasPasscode = this.hasPasscode();
    const hasAccount = !this.noAccount();
    const types = [];
    if (hasPasscode) {
      types.push(ChallengeType.LocalPasscode);
    }
    if (hasAccount) {
      types.push(ChallengeType.AccountPassword);
    }
    const challenge = new Challenge(types, ChallengeReason.ProtocolUpgrade);
    const response = await this.challengeService!.promptForChallengeResponse(challenge);
    if (!response) {
      return;
    }
    const errors = [];
    let passcode: string;
    if (hasPasscode) {
      /* Upgrade passcode version */
      const value = response.getValueForType(ChallengeType.LocalPasscode);
      passcode = value.value as string;
      await this.changePasscode(passcode);
    }
    if (hasAccount) {
      /* Upgrade account version */
      const value = response.getValueForType(ChallengeType.AccountPassword);
      const password = value.value as string;
      const changeResponse = await this.changePassword(
        password,
        password,
        passcode!
      );
      if (changeResponse?.error) {
        errors.push(changeResponse.error);
      }
    }
    return errors;
  }

  public noAccount() {
    const user = this.getUser();
    return isNullOrUndefined(user);
  }

  /** 

   * @returns
   * .affectedItems: Items that were either created or dirtied by this import
   * .errorCount: The number of items that were not imported due to failure to decrypt.
   */
  public async importData(
    data: BackupFile,
    password?: string,
    awaitSync = false
  ) {
    const decryptedPayloads = await this.protocolService!.payloadsByDecryptingBackupFile(
      data,
      password
    );
    const validPayloads = decryptedPayloads.filter((payload) => {
      return !payload.errorDecrypting;
    });
    const affectedItems = await this.modelManager!.importPayloads(validPayloads);
    const promise = this.sync();
    if (awaitSync) {
      await promise;
    }
    return {
      affectedItems: affectedItems,
      errorCount: decryptedPayloads.length - validPayloads.length
    };
  }

  /**
   * Creates a JSON string representing the backup format of all items, or just subItems
   * if supplied.
   */
  public async createBackupFile(
    subItems: SNItem[],
    intent: EncryptionIntent,
    returnIfEmpty = false
  ) {
    return this.protocolService!.createBackupFile(subItems, intent, returnIfEmpty);
  }

  public isEphemeralSession() {
    return this.storageService!.isEphemeralSession();
  }

  private lockSyncing() {
    this.syncService!.lockSyncing();
  }

  private  unlockSyncing() {
    this.syncService!.unlockSyncing();
  }

  public async sync(options?: SyncOptions) {
    return this.syncService!.sync(options);
  }

  public async resolveOutOfSync() {
    return this.syncService!.resolveOutOfSync();
  }

  public async setValue(key: string, value: any, mode: StorageValueModes) {
    return this.storageService!.setValue(key, value, mode);
  }

  public async getValue(key: string, mode: StorageValueModes) {
    return this.storageService!.getValue(key, mode);
  }

  public async removeValue(key: string, mode: StorageValueModes) {
    return this.storageService!.removeValue(key, mode);
  }

  /** 
   * Deletes all payloads from storage.
   */
  public async clearDatabase() {
    return this.storageService!.clearAllPayloads();
  }

  /** 
   * Allows items keys to be rewritten to local db on local credential status change,
   * such as if passcode is added, changed, or removed.
   * This allows IndexedDB unencrypted logs to be deleted
   * `deletePayloads` will remove data from backing store,
   * but not from working memory See:
   * https://github.com/standardnotes/desktop/issues/131
   */
  private async rewriteItemsKeys() {
    const itemsKeys = this.protocolService!.allItemsKeys;
    const payloads = itemsKeys.map((key) => key.payloadRepresentation());
    await this.storageService!.deletePayloads(payloads);
    await this.syncService!.persistPayloads(payloads);
  }

  /**
   * Destroys the application instance.
   */
  public deinit() {
    clearInterval(this.autoSyncInterval);
    for (const uninstallObserver of this.serviceObservers) {
      uninstallObserver();
    }
    for (const uninstallSubscriber of this.managedSubscribers) {
      uninstallSubscriber();
    }
    for (const service of this.services) {
      service.deinit();
    }
    this.deviceInterface!.deinit();
    this.deviceInterface = undefined;
    this.crypto = undefined;
    this.createdNewDatabase = false;
    this.services.length = 0;
    this.serviceObservers.length = 0;
    this.managedSubscribers.length = 0;
    this.streamRemovers.length = 0;
    this.clearServices();
    this.dealloced = true;
    this.started = false;
  }

  /**
   * Returns the wrapping key for operations that require resaving the root key
   * (changing the account password, signing in, registering, or upgrading protocol)
   * Returns empty object if no passcode is configured.
   * Otherwise returns {cancled: true} if the operation is canceled, or 
   * {wrappingKey} with the result.
   * @param passcode - If the consumer already has access to the passcode,
   * they can pass it here so that the user is not prompted again. 
   */
  private async getWrappingKeyIfNecessary(passcode?: string) {
    if (!this.hasPasscode()) {
      return {};
    }
    if (!passcode) {
      const challenge = new Challenge([ChallengeType.LocalPasscode], ChallengeReason.ResaveRootKey);
      const response = await this.challengeService!.promptForChallengeResponse(challenge);
      if (!response) {
        return { canceled: true };
      }
      const value = response.getValueForType(ChallengeType.LocalPasscode);
      passcode = value.value as string;
    }
    const wrappingKey = await this.protocolService!.computeWrappingKey(passcode);
    return { wrappingKey };
  }

  /**
   *  @param mergeLocal  Whether to merge existing offline data into account. If false,
   *                     any pre-existing data will be fully deleted upon success.
   */
  public async register(
    email: string,
    password: string,
    ephemeral = false,
    mergeLocal = true
  ) {
    const { wrappingKey, canceled } = await this.getWrappingKeyIfNecessary();
    if (canceled) {
      return;
    }
    this.lockSyncing();
    const result = await this.sessionManager!.register(email, password);
    if (!result.response.error) {
      await this.protocolService!.setNewRootKey(
        result.rootKey,
        result.keyParams,
        wrappingKey
      );
      this.syncService!.resetSyncState();
      await this.storageService!.setPersistencePolicy(
        ephemeral
          ? StoragePersistencePolicies.Ephemeral
          : StoragePersistencePolicies.Default
      );
      if (mergeLocal) {
        await this.syncService!.markAllItemsAsNeedingSync(true);
      } else {
        this.modelManager!.removeAllItemsFromMemory();
        await this.clearDatabase();
      }
      await this.notifyEvent(ApplicationEvents.SignedIn);
      this.unlockSyncing();
      await this.syncService!.sync({
        mode: SyncModes.DownloadFirst,
        queueStrategy: SyncQueueStrategy.ForceSpawnNew
      });
      this.protocolService!.decryptErroredItems();
    } else {
      this.unlockSyncing();
    }
    return result.response;
  }

  /**
   * @param mergeLocal  Whether to merge existing offline data into account. 
   * If false, any pre-existing data will be fully deleted upon success.
   */
  public async signIn(
    email: string,
    password: string,
    strict = false,
    ephemeral = false,
    mfaKeyPath?: string,
    mfaCode?: string,
    mergeLocal = true,
    awaitSync = false
  ) {
    const { wrappingKey, canceled } = await this.getWrappingKeyIfNecessary();
    if (canceled) {
      return;
    }
    /** Prevent a timed sync from occuring while signing in. */
    this.lockSyncing();
    const result = await this.sessionManager!.signIn(
      email, password, strict, mfaKeyPath, mfaCode
    );
    if (!result.response.error) {
      await this.protocolService!.setNewRootKey(
        result.rootKey,
        result.keyParams,
        wrappingKey
      );
      this.syncService!.resetSyncState();
      await this.storageService!.setPersistencePolicy(
        ephemeral
          ? StoragePersistencePolicies.Ephemeral
          : StoragePersistencePolicies.Default
      );
      if (mergeLocal) {
        await this.syncService!.markAllItemsAsNeedingSync(true);
      } else {
        this.modelManager!.removeAllItemsFromMemory();
        await this.clearDatabase();
      }
      await this.notifyEvent(ApplicationEvents.SignedIn);
      this.unlockSyncing();
      const syncPromise = this.syncService!.sync({
        mode: SyncModes.DownloadFirst,
        checkIntegrity: true,
        queueStrategy: SyncQueueStrategy.ForceSpawnNew
      });
      if (awaitSync) {
        await syncPromise;
      }
      this.protocolService!.decryptErroredItems();
    } else {
      this.unlockSyncing();
    }
    return result.response;
  }

  /** 
   * @param passcode - Changing the account password requires the local
   * passcode if configured (to rewrap the account key with passcode). If the passcode
   * is not passed in, the user will be prompted for the passcode. However if the consumer
   * already has referene to the passcode, they can pass it in here so that the user
   * is not prompted again.
   */
  public async changePassword(
    currentPassword: string,
    newPassword: string,
    passcode: string
  ) {
    const { wrappingKey, canceled } = await this.getWrappingKeyIfNecessary(passcode);
    if (canceled) {
      return;
    }
    const currentKeyParams = await this.protocolService!.getRootKeyParams();
    this.lockSyncing();
    const result = await this.sessionManager!.changePassword(
      currentPassword,
      currentKeyParams!,
      newPassword
    );
    if (!result.response.error) {
      await this.protocolService!.setNewRootKey(
        result.rootKey,
        result.keyParams,
        wrappingKey
      );
      await this.protocolService!.createNewDefaultItemsKey();
      this.unlockSyncing();
      await this.syncService!.sync();
    } else {
      this.unlockSyncing();
    }
    return result.response;
  }

  public async signOut() {
    await this.sessionManager!.signOut();
    await this.protocolService!.clearLocalKeyState();
    await this.storageService!.clearAllData();
    await this.notifyEvent(ApplicationEvents.SignedOut);
    this.deinit();
  }

  public async validateAccountPassword(password: string) {
    const { valid } = await this.protocolService!.validateAccountPassword(password);
    return valid;
  }

  public isStarted() {
    return this.started;
  }

  public isLaunched() {
    return this.launched;
  }

  public hasPasscode() {
    return this.protocolService!.hasPasscode();
  }

  async isLocked() {
    if (!this.started) {
      return true;
    }
    return this.challengeService!.isPasscodeLocked();
  }

  public async lock() {
    return this.deinit();
  }

  public async setPasscode(passcode: string) {
    const identifier = await this.generateUuid();
    const { key, keyParams } = await this.protocolService!.createRootKey(
      identifier,
      passcode
    );
    await this.protocolService!.setNewRootKeyWrapper(key, keyParams);
    await this.rewriteItemsKeys();
    await this.syncService!.sync();
  }

  public async removePasscode() {
    await this.protocolService!.removeRootKeyWrapper();
    await this.rewriteItemsKeys();
  }

  public async changePasscode(passcode: string) {
    await this.removePasscode();
    return this.setPasscode(passcode);
  }

  public async setStorageEncryptionPolicy(encryptionPolicy: StorageEncryptionPolicies) {
    await this.storageService!.setEncryptionPolicy(encryptionPolicy);
    return this.protocolService!.repersistAllItems();
  }


  public async generateUuid() {
    return Uuid.GenerateUuid();
  }

  /**
   * Dynamically change the device interface, i.e when Desktop wants to override
   * default web interface.
   */
  public async changeDeviceInterface(deviceInterface: DeviceInterface) {
    this.deviceInterface = deviceInterface;
    for (const service of this.services) {
      if (service.deviceInterface) {
        service.deviceInterface = deviceInterface;
      }
    }
  }

  private constructServices() {
    this.createModelManager();
    this.createStorageManager();
    this.createProtocolService();

    const encryptionDelegate = {
      payloadByEncryptingPayload: this.protocolService!.payloadByEncryptingPayload.bind(this.protocolService),
      payloadByDecryptingPayload: this.protocolService!.payloadByDecryptingPayload.bind(this.protocolService)
    };
    this.storageService!.encryptionDelegate = encryptionDelegate;

    this.createMigrationService();
    this.createAlertManager();
    this.createHttpManager();
    this.createApiService();
    this.createSessionManager();
    this.createSyncManager();
    this.createChallengeService();
    this.createSingletonManager();
    this.createComponentManager();
    this.createPrivilegesService();
    this.createHistoryManager();
    this.createActionsManager();
  }

  private clearServices() {
    this.migrationService = undefined;
    this.alertService = undefined;
    this.httpService = undefined;
    this.modelManager = undefined;
    this.protocolService = undefined;
    this.storageService = undefined;
    this.apiService = undefined;
    this.sessionManager = undefined;
    this.syncService = undefined;
    this.challengeService = undefined;
    this.singletonManager = undefined;
    this.componentManager = undefined;
    this.privilegesService = undefined;
    this.actionsManager = undefined;
    this.historyManager = undefined;

    this.services = [];
  }

  private createMigrationService() {
    this.migrationService = new (this.getClass(SNMigrationService))(
      {
        protocolService: this.protocolService,
        deviceInterface: this.deviceInterface,
        storageService: this.storageService,
        modelManager: this.modelManager,
        environment: this.environment,
        namespace: this.namespace
      },
      this.getMigrationChallengeResponder()
    );
    this.services.push(this.migrationService!);
  }

  private createAlertManager() {
    if (this.shouldSkipClass(SNAlertService)) {
      return;
    }
    this.alertService = new (this.getClass(SNAlertService))(
      this.deviceInterface
    );
    this.services.push(this.alertService!);
  }

  private createApiService() {
    this.apiService = new (this.getClass(SNApiService))(
      this.httpService,
      this.storageService,
    );
    this.services.push(this.apiService!);
  }

  private createComponentManager() {
    if (this.shouldSkipClass(SNComponentManager)) {
      return;
    }
    this.componentManager = new (this.getClass(SNComponentManager))(
      this.modelManager,
      this.syncService,
      this.alertService,
      this.environment,
      this.platform,
      this.deviceInterface!.timeout,
    );
    this.services.push(this.componentManager!);
  }

  private createHttpManager() {
    this.httpService = new (this.getClass(SNHttpService))();
    this.services.push(this.httpService!);
  }

  private createModelManager() {
    this.modelManager = new (this.getClass(SNModelManager))();
    this.services.push(this.modelManager!);
  }

  private createSingletonManager() {
    this.singletonManager = new (this.getClass(SNSingletonManager))(
      this.modelManager,
      this.syncService
    );
    this.services.push(this.singletonManager!);
  }

  private createStorageManager() {
    this.storageService = new (this.getClass(SNStorageService))(
      this.deviceInterface,
      this.namespace,
    );
    this.services.push(this.storageService!);
  }

  private createProtocolService() {
    this.protocolService = new (this.getClass(SNProtocolService))(
      this.modelManager,
      this.deviceInterface,
      this.storageService,
      this.crypto
    );
    this.protocolService!.onKeyStatusChange(async () => {
      await this.notifyEvent(ApplicationEvents.KeyStatusChanged);
    });
    this.services.push(this.protocolService!);
  }

  private createSessionManager() {
    this.sessionManager = new (this.getClass(SNSessionManager))(
      this.storageService,
      this.apiService,
      this.alertService,
      this.protocolService
    );
    this.services.push(this.sessionManager!);
  }

  private createSyncManager() {
    this.syncService = new (this.getClass(SNSyncService))(
      this.sessionManager,
      this.protocolService,
      this.storageService,
      this.modelManager,
      this.apiService,
      this.deviceInterface!.interval
    );
    const syncEventCallback = async (eventName: string) => {
      const appEvent = applicationEventForSyncEvent(eventName as SyncEvents);
      if (appEvent) {
        await this.notifyEvent(appEvent);
      }
      await this.protocolService!.onSyncEvent(eventName as SyncEvents);
    };
    const uninstall = this.syncService!.addEventObserver(syncEventCallback);
    this.serviceObservers.push(uninstall);
    this.services.push(this.syncService!);
  }

  private createChallengeService() {
    this.challengeService = new (this.getClass(ChallengeService))(
      this.storageService,
      this.protocolService
    );
    this.services.push(this.challengeService!);
  }

  private createPrivilegesService() {
    this.privilegesService = new (this.getClass(SNPrivilegesService))(
      this.modelManager,
      this.syncService,
      this.singletonManager,
      this.protocolService,
      this.storageService,
      this.sessionManager,
    );
    this.services.push(this.privilegesService!);
  }

  private createHistoryManager() {
    this.historyManager = new (this.getClass(SNHistoryManager))(
      this.modelManager,
      this.storageService,
      [ContentType.Note],
      this.deviceInterface!.timeout
    );
    this.services.push(this.historyManager!);
  }

  private createActionsManager() {
    this.actionsManager = new (this.getClass(SNActionsService))(
      this.alertService,
      this.deviceInterface,
      this.httpService,
      this.modelManager,
      this.protocolService,
      this.syncService,
    );
    this.services.push(this.actionsManager!);
  }

  private shouldSkipClass(classCandidate: any) {
    return this.skipClasses && this.skipClasses.includes(classCandidate);
  }

  private getClass(base: any) {
    const swapClass = this.swapClasses && this.swapClasses.find((candidate) => candidate.swap === base);
    if (swapClass) {
      return swapClass.with;
    } else {
      return base;
    }
  }
}
