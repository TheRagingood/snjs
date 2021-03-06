import { RootKeyContent } from './../protocol/root_key';
import { EncryptionDelegate } from './encryption_delegate';
import { SyncEvents } from '@Lib/events';
import { CreateItemFromPayload } from '@Models/generator';
import { SNItem } from '@Models/core/item';
import { PurePayload } from '@Payloads/pure_payload';
import { SNItemsKey } from '@Models/app/items_key';
import { SNRootKeyParams, KeyParamsContent } from './../protocol/key_params';
import { SNStorageService } from './storage_service';
import { SNRootKey } from '@Protocol/root_key';
import { SNProtocolOperator } from '@Protocol/operator/operator';
import { SNModelManager } from './model_manager';
import { PureService } from '@Lib/services/pure_service';
import { SNWebCrypto, isWebCryptoAvailable, SNPureCrypto } from 'sncrypto';
import { Uuid } from '@Lib/uuid';
import {
  CreateEncryptionParameters,
  CreateIntentPayloadFromObject,
  CreateSourcedPayloadFromObject,
  CreateMaxPayloadFromAnyObject,
  PayloadSources,
  PayloadFormats,
  PayloadFields
} from '@Payloads/index';
import {
  isWebEnvironment,
  isString,
  isNullOrUndefined,
  isFunction,
  removeFromArray
} from '@Lib/utils';
import {
  isDecryptedIntent,
  intentRequiresEncryption,
  SNProtocolOperator001,
  SNProtocolOperator002,
  SNProtocolOperator003,
  SNProtocolOperator004,
  CreateKeyParams,
  ProtocolVersions,
  compareVersions,
  EncryptionIntents
} from '@Protocol/index';
import { V001Algorithm, V002Algorithm } from '../protocol/operator/algorithms';
import { ContentType } from '@Models/content_types';
import { StorageKey } from '@Lib/storage_keys';
import { StorageValueModes } from '@Lib/services/storage_service';
import { DeviceInterface } from '../device_interface';

export type BackupFile = {
  keyParams?: any
  auth_params?: any
  items: any[]
}

type KeyChangeObserver = () => Promise<void>

export enum KeyMode {
  /** i.e No account and no passcode */
  RootKeyNone = 0,
  /** i.e Account but no passcode */
  RootKeyOnly = 1,
  /** i.e Account plus passcode */
  RootKeyPlusWrapper = 2,
  /** i.e No account, but passcode */
  WrapperOnly = 3
}

/** The last protocol version to not use root-key based items keys */
const LAST_NONROOT_ITEMS_KEY_VERSION = ProtocolVersions.V003;

/**
 * The protocol service is responsible for the encryption and decryption of payloads, and
 * handles delegation of a task to the respective protocol operator. Each version of the protocol
 * (001, 002, 003, 004, etc) uses a respective operator version to perform encryption operations.
 * Operators are located in /protocol/operator.
 * The protocol service depends on the keyManager for determining which key to use for the 
 * encryption and decryption of a particular payload.
 * The protocol service is also responsible for dictating which protocol versions are valid,
 * and which are no longer valid or not supported.

 * The key manager is responsible for managing root key and root key wrapper states.
 * When the key manager is initialized, it initiates itself with a keyMode, which
 * dictates the entire flow of key management. The key manager's responsibilities include:
 * - interacting with the device keychain to save or clear the root key
 * - interacting with storage to save root key params or wrapper params, or the wrapped root key.
 * - exposing methods that allow the application to unwrap the root key (unlock the application)
 *
 * It also exposes two primary methods for determining what key should be used to encrypt
 * or decrypt a particular payload. Some payloads are encrypted directly with the rootKey
 * (such as itemsKeys and encryptedStorage). Others are encrypted with itemsKeys (notes, tags, etc).

 * The items key manager manages the lifecycle of items keys.
 * It is responsible for creating the default items key when conditions call for it
 * (such as after the first sync completes and no key exists).
 * It also exposes public methods that allows consumers to retrieve an items key
 * for a particular payload, and also retrieve all available items keys.
*/
export class SNProtocolService extends PureService implements EncryptionDelegate {

  private modelManager?: SNModelManager
  private storageService?: SNStorageService
  public crypto?: SNPureCrypto
  private operators: Record<string, SNProtocolOperator> = {}
  private keyMode = KeyMode.RootKeyNone
  private keyObservers: KeyChangeObserver[] = []
  private rootKey?: SNRootKey
  private removeMappingObserver: any

  constructor(
    modelManager: SNModelManager,
    deviceInterface: DeviceInterface,
    storageService: SNStorageService,
    crypto: SNPureCrypto
  ) {
    super();
    this.modelManager = modelManager;
    this.deviceInterface = deviceInterface;
    this.storageService = storageService;
    this.crypto = crypto;
    if (
      !this.crypto &&
      isWebEnvironment() &&
      isWebCryptoAvailable()
    ) {
      /** IE and Edge do not support pbkdf2 in WebCrypto. */
      this.crypto = new SNWebCrypto();
    }
    Uuid.SetGenerators(
      this.crypto.generateUUIDSync,
      this.crypto.generateUUID
    );
    /** Hide rootKey enumeration */
    Object.defineProperty(this, 'rootKey', {
      enumerable: false,
      writable: true
    });
    this.removeMappingObserver = this.modelManager.addMappingObserver(
      [ContentType.ItemsKey],
      async () => {
        await this.decryptErroredItems();
      }
    );
  }

  /** @override */
  public deinit() {
    this.modelManager = undefined;
    this.deviceInterface = undefined;
    this.storageService = undefined;
    this.crypto!.deinit();
    this.crypto = undefined;
    this.operators = {};
    this.keyObservers.length = 0;
    this.removeMappingObserver();
    this.removeMappingObserver = null;
    this.rootKey = undefined;
    super.deinit();
  }

  public async initialize() {
    const wrappedRootKey = await this.getWrappedRootKey();
    const accountKeyParams = await this.getAccountKeyParams();
    const hasWrapper = await this.hasRootKeyWrapper();
    const hasRootKey =
      !isNullOrUndefined(wrappedRootKey) ||
      !isNullOrUndefined(accountKeyParams);
    if (hasWrapper && hasRootKey) {
      this.keyMode = KeyMode.RootKeyPlusWrapper;
    } else if (hasWrapper && !hasRootKey) {
      this.keyMode = KeyMode.WrapperOnly;
    } else if (!hasWrapper && hasRootKey) {
      this.keyMode = KeyMode.RootKeyOnly;
    } else if (!hasWrapper && !hasRootKey) {
      this.keyMode = KeyMode.RootKeyNone;
    } else {
      throw 'Invalid key mode condition';
    }

    if (this.keyMode === KeyMode.RootKeyOnly) {
      this.rootKey = await this.getRootKeyFromKeychain();
      await this.notifyObserversOfKeyChange();
    }
  }

  /**
   * Returns the latest protocol version
   */
  public getLatestVersion() {
    return ProtocolVersions.V004;
  }

  /** 
   * Returns the protocol version associated with the user's account
   */
  public async getUserVersion() {
    const keyParams = await this.getAccountKeyParams();
    return keyParams && keyParams.version;
  }

  /** 
   * Returns true if there is an upgrade available for the account or passcode
   */
  public async upgradeAvailable() {
    const accountUpgradeAvailable = await this.accountUpgradeAvailable();
    const passcodeUpgradeAvailable = await this.passcodeUpgradeAvailable();
    return accountUpgradeAvailable || passcodeUpgradeAvailable;
  }

  /** 
   * Returns true if the user's account protocol version is not equal to the latest version.
   */
  public async accountUpgradeAvailable() {
    const userVersion = await this.getUserVersion();
    if (!userVersion) {
      return false;
    }
    return userVersion !== this.getLatestVersion();
  }

  /** 
   * Returns true if the user's account protocol version is not equal to the latest version.
   */
  public async passcodeUpgradeAvailable() {
    const passcodeParams = await this.getRootKeyWrapperKeyParams();
    if (!passcodeParams) {
      return false;
    }
    return passcodeParams.version !== this.getLatestVersion();
  }

  /**
   * Determines whether the current environment is capable of supporting
   * key derivation.
   */
  public platformSupportsKeyDerivation(keyParams: SNRootKeyParams) {
    /**
     * If the version is 003 or lower, key derivation is supported unless the browser is
     * IE or Edge (or generally, where WebCrypto is not available).
     * 
     * Versions 004 and above are always supported.
     */
    if (compareVersions(keyParams.version, ProtocolVersions.V004) >= 0) {
      /* keyParams.version >= 004 */
      return true;
    } else {
      return !!isWebCryptoAvailable();
    }
  }

  /**
   * @returns The versions that this library supports.
   */
  public supportedVersions() {
    return [
      ProtocolVersions.V001,
      ProtocolVersions.V002,
      ProtocolVersions.V003,
      ProtocolVersions.V004,
    ];
  }

  /**
   * Determines whether the input version is greater than the latest supported library version.
   */
  public isVersionNewerThanLibraryVersion(version: ProtocolVersions) {
    const libraryVersion = this.getLatestVersion();
    return compareVersions(version, libraryVersion) === 1;
  }

  /**
   * Determines whether the input version is expired
   */
  public isProtocolVersionOutdated(version: ProtocolVersions) {
    const expirationDates: Partial<Record<ProtocolVersions, number>> = {
      [ProtocolVersions.V001]: Date.parse('2018-01-01'),
      [ProtocolVersions.V002]: Date.parse('2020-01-01')
    };
    const date = expirationDates[version];
    if (!date) {
      /* No expiration date, is active version */
      return false;
    }
    const expired = new Date().getTime() > date;
    return expired;
  }

  /**
   * Versions 001 and 002 of the protocol supported dynamic costs, as reported by the server.
   * This function returns the client-enforced minimum cost, to prevent the server from
   * overwhelmingly under-reporting the cost.
   */
  public costMinimumForVersion(version: ProtocolVersions) {
    if (compareVersions(version, ProtocolVersions.V003) >= 0) {
      throw 'Cost minimums only apply to versions <= 002';
    }
    if (version === ProtocolVersions.V001) {
      return V001Algorithm.PbkdfMinCost;
    } else if (version === ProtocolVersions.V002) {
      return V002Algorithm.PbkdfMinCost;
    } else {
      throw `Invalid version for cost minimum: ${version}`;
    }
  }

  private createOperatorForLatestVersion() {
    return this.createOperatorForVersion(this.getLatestVersion());
  }

  private createOperatorForVersion(version: ProtocolVersions): SNProtocolOperator {
    if (version === ProtocolVersions.V001) {
      return new SNProtocolOperator001(this.crypto!);
    } else if (version === ProtocolVersions.V002) {
      return new SNProtocolOperator002(this.crypto!);
    } else if (version === ProtocolVersions.V003) {
      return new SNProtocolOperator003(this.crypto!);
    } else if (version === ProtocolVersions.V004) {
      return new SNProtocolOperator004(this.crypto!);
    } else if (version === ProtocolVersions.V000Base64Decrypted) {
      return this.createOperatorForLatestVersion();
    } else {
      throw `Unable to find operator for version ${version}`;
    }
  }

  private operatorForVersion(version: ProtocolVersions) {
    const operatorKey = version;
    let operator = this.operators[operatorKey];
    if (!operator) {
      operator = this.createOperatorForVersion(version);
      this.operators[operatorKey] = operator;
    }
    return operator;
  }

  /**
   * Returns the operator corresponding to the latest protocol version
   */
  private defaultOperator() {
    return this.operatorForVersion(this.getLatestVersion());
  }

  /**
   * Computes a root key given a password and key params.
   * Delegates computation to respective protocol operator.
   */
  public async computeRootKey(password: string, keyParams: SNRootKeyParams) {
    const version = keyParams.version;
    const operator = this.operatorForVersion(version);
    return operator.computeRootKey(password, keyParams);
  }

  /**
   * Creates a root key using the latest protocol version
  */
  public async createRootKey(identifier: string, password: string) {
    const operator = this.defaultOperator();
    return operator.createRootKey(identifier, password);
  }

  /**
   * Given a key and intent, returns the proper PayloadFormat,
   * or throws an exception if unsupported configuration of parameters.
   */
  private payloadContentFormatForIntent(
    intent: EncryptionIntents,
    key?: SNRootKey | SNItemsKey,
  ) {
    if (!key) {
      /** Decrypted */
      if ((
        intent === EncryptionIntents.LocalStorageDecrypted ||
        intent === EncryptionIntents.LocalStoragePreferEncrypted ||
        intent === EncryptionIntents.FileDecrypted ||
        intent === EncryptionIntents.FilePreferEncrypted
      )) {
        return PayloadFormats.DecryptedBareObject;
      } else if ((
        intent === EncryptionIntents.SyncDecrypted
      )) {
        return PayloadFormats.DecryptedBase64String;
      } else {
        throw 'Unhandled decrypted case in protocolService.payloadContentFormatForIntent.';
      }
    } else {
      /** Encrypted */
      if ((
        intent === EncryptionIntents.Sync ||
        intent === EncryptionIntents.FileEncrypted ||
        intent === EncryptionIntents.FilePreferEncrypted ||
        intent === EncryptionIntents.LocalStorageEncrypted ||
        intent === EncryptionIntents.LocalStoragePreferEncrypted
      )) {
        return PayloadFormats.EncryptedString;
      } else {
        throw 'Unhandled encrypted case in protocolService.payloadContentFormatForIntent.';
      }
    }
  }

  /**
   * Generates parameters for a payload that are typically encrypted, and used for syncing
   * or saving locally. Parameters are non-typed objects that can later by converted to objects.
   * If the input payload is not properly decrypted in the first place, it will be returned
   * as-is.
   * @param payload - The payload to encrypt
   * @param key The key to use to encrypt the payload. 
   *   Will be looked up if not supplied.
   * @param intent - The target of the encryption
   * @returns The encrypted payload
   */
  public async payloadByEncryptingPayload(
    payload: PurePayload,
    intent: EncryptionIntents,
    key?: SNRootKey | SNItemsKey,
  ) : Promise<PurePayload> {
    if (payload.errorDecrypting) {
      return payload;
    }
    if (isNullOrUndefined(intent)) {
      throw 'Attempting to encrypt payload with null intent';
    }
    if (!key && !isDecryptedIntent(intent)) {
      key = await this.keyToUseForEncryptionOfPayload(payload, intent);
    }
    if (!key && intentRequiresEncryption(intent)) {
      throw 'Attempting to generate encrypted payload with no key.';
    }
    if (payload.format !== PayloadFormats.DecryptedBareObject) {
      throw 'Attempting to encrypt already encrypted payload.';
    }
    if (!payload.content) {
      throw 'Attempting to encrypt payload with no content.';
    }
    if (!payload.uuid) {
      throw 'Attempting to encrypt payload with no uuid.';
    }
    const version = key ? key.version : this.getLatestVersion();
    const format = this.payloadContentFormatForIntent(intent, key);
    const operator = this.operatorForVersion(version);
    const encryptionParameters = await operator.generateEncryptedParameters(
      payload,
      format,
      key,
    );
    if (!encryptionParameters) {
      throw 'Unable to generate encryption parameters';
    }
    return CreateIntentPayloadFromObject(
      payload,
      intent,
      encryptionParameters,
    );
  }

  /**
   * Similar to `payloadByEncryptingPayload`, but operates on an array of payloads.
   * `intent` can also be a function of the current iteration payload.
   */
  public async payloadsByEncryptingPayloads(
    payloads: PurePayload[],
    intent: EncryptionIntents | ((payload: PurePayload) => EncryptionIntents)
  ) {
    const results = [];
    for (const payload of payloads) {
      const useIntent = isFunction(intent) ? (intent as any)(payload) : intent;
      const encryptedPayload = await this.payloadByEncryptingPayload(
        payload,
        useIntent
      );
      results.push(encryptedPayload);
    }
    return results;
  }

  /**
   * Generates a new payload by decrypting the input payload.
   * If the input payload is already decrypted, it will be returned as-is.
   * @param payload - The payload to decrypt.
   * @param key The key to use to decrypt the payload. 
   * If none is supplied, it will be automatically looked up.
   */
  public async payloadByDecryptingPayload(
    payload: PurePayload,
    key?: SNRootKey | SNItemsKey
  ): Promise<PurePayload> {
    if (!payload.content) {
      throw 'Attempting to decrypt payload that has no content.';
    }
    const format = payload.format;
    if (format === PayloadFormats.DecryptedBareObject) {
      return payload;
    }
    if (!key && format === PayloadFormats.EncryptedString) {
      key = await this.keyToUseForDecryptionOfPayload(payload);
      if (!key) {
        return CreateMaxPayloadFromAnyObject(
          payload,
          undefined,
          undefined,
          {
            waitingForKey: true,
            errorDecrypting: true
          }
        );
      }
    }
    const version = payload.version;
    const operator = this.operatorForVersion(version);
    const encryptionParameters = CreateEncryptionParameters(payload);
    const decryptedParameters = await operator.generateDecryptedParameters(
      encryptionParameters,
      key
    );
    return CreateMaxPayloadFromAnyObject(
      payload,
      undefined,
      undefined,
      decryptedParameters
    );
  }

  /**
   * Similar to `payloadByDecryptingPayload`, but operates on an array of payloads.
   */
  public async payloadsByDecryptingPayloads(payloads: PurePayload[], key?: SNRootKey | SNItemsKey) {
    const decryptedPayloads = [];
    for (const encryptedPayload of payloads) {
      if (!encryptedPayload) {
        /** Keep in-counts similar to out-counts */
        decryptedPayloads.push(encryptedPayload);
        continue;
      }
      /**
       * We still want to decrypt deleted payloads if they have content in case
       * they were marked as dirty but not yet synced.
       */
      if (encryptedPayload.deleted === true && isNullOrUndefined(encryptedPayload.content)) {
        decryptedPayloads.push(encryptedPayload);
        continue;
      }
      const isDecryptable = isString(encryptedPayload.content);
      if (!isDecryptable) {
        decryptedPayloads.push(encryptedPayload);
        continue;
      }
      try {
        const decryptedPayload = await this.payloadByDecryptingPayload(
          encryptedPayload,
          key
        );
        decryptedPayloads.push(decryptedPayload);
      } catch (e) {
        decryptedPayloads.push(CreateMaxPayloadFromAnyObject(
          encryptedPayload,
          undefined,
          undefined,
          {
            errorDecrypting: true,
            errorDecryptingValueChanged: !encryptedPayload.errorDecrypting
          }
        ));
        console.error('Error decrypting payload', encryptedPayload, e);
      }
    }
    return decryptedPayloads;
  }

  /**
   * If an item was attempting to decrypt, but failed, either because the keys
   * for that item had not downloaded yet, or any other reason, it will be deferred
   * item.errorDecrypting = true and possibly item.waitingForKey = true.
   * Here we find such items, and attempt to decrypt them again.
   */
  public async decryptErroredItems() {
    const items = this.modelManager!.allItems.filter((item) => {
      return item.waitingForKey || item.errorDecrypting;
    });
    if (items.length === 0) {
      return;
    }
    const payloads = items.map((item) => {
      return item.payloadRepresentation();
    });
    const decrypted = await this.payloadsByDecryptingPayloads(payloads);
    await this.modelManager!.mapPayloadsToLocalItems(
      decrypted,
      PayloadSources.LocalChanged
    );
  }

  /**
   * Decrypts a backup file using user-inputted password
   * @param password - The raw user password associated with this backup file
   */
  public async payloadsByDecryptingBackupFile(
    data: BackupFile,
    password?: string
  ) {
    const keyParams = data.keyParams || data.auth_params;
    const rawItems = data.items;
    const encryptedPayloads = rawItems.map((rawItem) => {
      return CreateSourcedPayloadFromObject(
        rawItem,
        PayloadSources.FileImport,
      );
    });
    let decryptedPayloads;
    if (keyParams) {
      const key = await this.computeRootKey(
        password!,
        keyParams
      );
      decryptedPayloads = await this.payloadsByDecryptingPayloads(
        encryptedPayloads,
        key
      );
    } else {
      decryptedPayloads = encryptedPayloads;
    }
    return decryptedPayloads;
  }

  /**
   * Creates a key params object from a raw object
   * @param keyParams - The raw key params object to create a KeyParams object from
   */
  public createKeyParams(keyParams: KeyParamsContent) {
    /* 002 doesn't have version automatically, newer versions do. */
    if (!keyParams.version) {
      keyParams.version = ProtocolVersions.V002;
    }
    return CreateKeyParams(keyParams);
  }

  /**
   * Creates a JSON string representing the backup format of all items, or just subitems
   * if supplied.
   * @param subItems An optional array of items to create backup of. 
   * If not supplied, all items are backed up. 
   * @param returnIfEmpty Returns null if there are no items to make backup of.
   * @returns JSON stringified representation of data, including keyParams.
   */
  public async createBackupFile(
    subItems?: SNItem[],
    intent = EncryptionIntents.FilePreferEncrypted,
    returnIfEmpty = false
  ) {
    const items = subItems || this.modelManager!.allItems;
    if (returnIfEmpty && items.length === 0) {
      return null;
    }
    const payloads = items.map((item) => {
      return CreateMaxPayloadFromAnyObject(item);
    });
    const encryptedPayloads = await this.payloadsByEncryptingPayloads(
      payloads,
      intent
    );
    const data: BackupFile = {
      items: encryptedPayloads
    };
    const keyParams = await this.getRootKeyParams();
    if (keyParams && intent !== EncryptionIntents.FileDecrypted) {
      data.keyParams = keyParams.getPortableValue();
    }
    const prettyPrint = 2;
    return JSON.stringify(data, null, prettyPrint);
  }

  /**
   * Register a callback to be notified when root key status changes.
   * @param callback  A function that takes in a content type to call back when root
   *                  key or wrapper status has changed.
   */
  public onKeyStatusChange(callback: KeyChangeObserver) {
    this.keyObservers.push(callback);
    return () => {
      removeFromArray(this.keyObservers, callback);
    };
  }

  private async notifyObserversOfKeyChange() {
    for (const observer of this.keyObservers) {
      await observer();
    }
  }

  private async getRootKeyFromKeychain() {
    const rawKey = await this.deviceInterface!.getKeychainValue();
    if (isNullOrUndefined(rawKey)) {
      return undefined;
    }
    const rootKey = await SNRootKey.Create(
      rawKey
    );
    return rootKey;
  }

  private async saveRootKeyToKeychain() {
    if (isNullOrUndefined(this.rootKey)) {
      throw 'Attempting to non-existent root key to the keychain.';
    }
    if (this.keyMode !== KeyMode.RootKeyOnly) {
      throw 'Should not be persisting wrapped key to keychain.';
    }
    const rawKey = this.rootKey!.getPersistableValue();
    await this.deviceInterface!.setKeychainValue(rawKey);
  }

  /**
   * @returns True if a root key wrapper (passcode) is configured.
   */
  public async hasRootKeyWrapper() {
    const wrapper = await this.getRootKeyWrapperKeyParams();
    return !isNullOrUndefined(wrapper);
  }

  /**
   * A non-async alternative to `hasRootKeyWrapper` which uses pre-loaded state
   * to determine if a passcode is configured.
   */
  public hasPasscode() {
    return (
      this.keyMode === KeyMode.WrapperOnly ||
      this.keyMode === KeyMode.RootKeyPlusWrapper
    );
  }

  /**
   * @returns True if the root key has not yet been unwrapped (passcode locked).
   */
  public async rootKeyNeedsUnwrapping() {
    return await this.hasRootKeyWrapper() && isNullOrUndefined(this.rootKey);
  }

  /**
   * @returns Key params object containing root key wrapper key params
   */
  public async getRootKeyWrapperKeyParams() {
    const rawKeyParams = await this.storageService!.getValue(
      StorageKey.RootKeyWrapperKeyParams,
      StorageValueModes.Nonwrapped
    );
    if (!rawKeyParams) {
      return undefined;
    }
    return this.createKeyParams(rawKeyParams);
  }

  /**
   * @returns Object containing persisted wrapped (encrypted) root key
   */
  private async getWrappedRootKey() {
    return this.storageService!.getValue(
      StorageKey.WrappedRootKey,
      StorageValueModes.Nonwrapped
    );
  }

  /**
   * Returns rootKeyParams by reading from storage.
   */
  public async getRootKeyParams() {
    if (this.keyMode === KeyMode.WrapperOnly) {
      return this.getRootKeyWrapperKeyParams();
    } else if ((
      this.keyMode === KeyMode.RootKeyOnly ||
      this.keyMode === KeyMode.RootKeyPlusWrapper
    )) {
      return this.getAccountKeyParams();
    } else {
      throw `Unhandled key mode for getRootKeyParams ${this.keyMode}`;
    }
  }

  /**
   * @returns getRootKeyParams may return different params based on different
   *           keyMode. This function however strictly returns only account params.
   */
  public async getAccountKeyParams() {
    const rawKeyParams = await this.storageService!.getValue(
      StorageKey.RootKeyParams,
      StorageValueModes.Nonwrapped
    );
    if (!rawKeyParams) {
      return undefined;
    }
    return this.createKeyParams(rawKeyParams);
  }

  /**
   * We know a wrappingKey is correct if it correctly decrypts
   * wrapped root key.
   */
  public async validateWrappingKey(wrappingKey: SNRootKey) {
    const wrappedRootKey = await this.getWrappedRootKey();
    /** If wrapper only, storage is encrypted directly with wrappingKey */
    if (this.keyMode === KeyMode.WrapperOnly) {
      return this.storageService!.canDecryptWithKey(wrappingKey);
    } else if ((
      this.keyMode === KeyMode.RootKeyOnly ||
      this.keyMode === KeyMode.RootKeyPlusWrapper
    )) {
      /**
      * In these modes, storage is encrypted with account keys, and
      * account keys are encrypted with wrappingKey. Here we validate
      * by attempting to decrypt account keys.
      */
      const wrappedKeyPayload = CreateMaxPayloadFromAnyObject(
        wrappedRootKey
      );
      const decrypted = await this.payloadByDecryptingPayload(
        wrappedKeyPayload,
        wrappingKey
      );
      return !decrypted.errorDecrypting;
    } else {
      throw 'Unhandled case in validateWrappingKey';
    }
  }

  /**
   * Computes the root key wrapping key given a passcode.
   * Wrapping key params are read from disk.
   */
  public async computeWrappingKey(passcode: string) {
    const keyParams = await this.getRootKeyWrapperKeyParams();
    const key = await this.computeRootKey(
      passcode,
      keyParams!
    );
    return key;
  }

  /**
   * Unwraps the persisted root key value using the supplied wrappingKey.
   * Application interfaces must check to see if the root key requires unwrapping on load.
   * If so, they must generate the unwrapping key by getting our saved wrapping key keyParams.
   * After unwrapping, the root key is automatically loaded.
   */
  public async unwrapRootKey(wrappingKey: SNRootKey) {
    if (this.keyMode === KeyMode.WrapperOnly) {
      this.rootKey = wrappingKey;
      return;
    }
    if (this.keyMode !== KeyMode.RootKeyPlusWrapper) {
      throw 'Invalid key mode condition for unwrapping.';
    }
    const wrappedKey = await this.getWrappedRootKey();
    const payload = CreateMaxPayloadFromAnyObject(wrappedKey);
    const decrypted = await this.payloadByDecryptingPayload(
      payload,
      wrappingKey
    );
    if (decrypted.errorDecrypting) {
      throw Error('Unable to decrypt root key with provided wrapping key.');
    } else {
      this.rootKey = await SNRootKey.Create(
        decrypted.contentObject as any,
        decrypted.uuid
      );
      await this.notifyObserversOfKeyChange();
    }
  }

  /**
   * Encrypts rootKey and saves it in storage instead of keychain, and then
   * clears keychain. This is because we don't want to store large encrypted
   * payloads in the keychain. If the root key is not wrapped, it is stored
   * in plain form in the user's secure keychain.
  */
  public async setNewRootKeyWrapper(wrappingKey: SNRootKey, keyParams: SNRootKeyParams) {
    if (this.keyMode === KeyMode.RootKeyNone) {
      this.keyMode = KeyMode.WrapperOnly;
    } else if (this.keyMode === KeyMode.RootKeyOnly) {
      this.keyMode = KeyMode.RootKeyPlusWrapper;
    } else {
      throw 'Attempting to set wrapper on already wrapped key.';
    }
    await this.deviceInterface!.clearKeychainValue();
    if ((
      this.keyMode === KeyMode.WrapperOnly ||
      this.keyMode === KeyMode.RootKeyPlusWrapper
    )) {
      if (this.keyMode === KeyMode.WrapperOnly) {
        this.rootKey = wrappingKey;
        await this.reencryptItemsKeys();
      } else {
        await this.wrapAndPersistRootKey(
          wrappingKey
        );
      }
      await this.storageService!.setValue(
        StorageKey.RootKeyWrapperKeyParams,
        keyParams.getPortableValue(),
        StorageValueModes.Nonwrapped
      );
      await this.notifyObserversOfKeyChange();
    } else {
      throw 'Invalid keyMode on setNewRootKeyWrapper';
    }
  }

  /** 
   * Wraps the current in-memory root key value using the wrappingKey,
   * then persists the wrapped value to disk.
   */
  private async wrapAndPersistRootKey(wrappingKey: SNRootKey) {
    const payload = CreateMaxPayloadFromAnyObject(
      this.rootKey!,
      undefined,
      undefined,
      {
        content: this.rootKey!.getPersistableValue()
      }
    );
    const wrappedKey = await this.payloadByEncryptingPayload(
      payload,
      EncryptionIntents.LocalStorageEncrypted,
      wrappingKey,
    );
    await this.storageService!.setValue(
      StorageKey.WrappedRootKey,
      wrappedKey,
      StorageValueModes.Nonwrapped
    );
  }

  /**
   * Removes root key wrapper from local storage and stores root key bare in secure keychain.
   */
  public async removeRootKeyWrapper() {
    if ((
      this.keyMode !== KeyMode.WrapperOnly &&
      this.keyMode !== KeyMode.RootKeyPlusWrapper
    )) {
      throw 'Attempting to remove root key wrapper on unwrapped key.';
    }
    if (this.keyMode === KeyMode.WrapperOnly) {
      this.keyMode = KeyMode.RootKeyNone;
      this.rootKey = undefined;
    } else if (this.keyMode === KeyMode.RootKeyPlusWrapper) {
      this.keyMode = KeyMode.RootKeyOnly;
    }
    await this.storageService!.removeValue(
      StorageKey.WrappedRootKey,
      StorageValueModes.Nonwrapped
    );
    await this.storageService!.removeValue(
      StorageKey.RootKeyWrapperKeyParams,
      StorageValueModes.Nonwrapped
    );
    if (this.keyMode === KeyMode.RootKeyOnly) {
      await this.saveRootKeyToKeychain();
    }
    await this.notifyObserversOfKeyChange();
  }

  /**
   * The root key is distinct from regular keys and are only saved locally in the keychain,
   * in non-item form. Applications set root key on sign in, register, or password change.
   * @param key A SNRootKey object.
   * @param wrappingKey If a passcode is configured, the wrapping key
   * must be supplied, so that the new root key can be wrapped with the wrapping key.
   */
  public async setNewRootKey(
    key: SNRootKey,
    keyParams: SNRootKeyParams,
    wrappingKey?: SNRootKey
  ) {
    if (!keyParams) {
      throw 'keyParams must be supplied if setting root key.';
    }
    if (this.rootKey === key) {
      throw 'Attempting to set root key as same current value.';
    }
    if (this.keyMode === KeyMode.WrapperOnly) {
      this.keyMode = KeyMode.RootKeyPlusWrapper;
    } else if (this.keyMode === KeyMode.RootKeyNone) {
      this.keyMode = KeyMode.RootKeyOnly;
    } else if ((
      this.keyMode === KeyMode.RootKeyOnly ||
      this.keyMode === KeyMode.RootKeyPlusWrapper
    )) {
      /** Root key is simply changing, mode stays the same */
      /** this.keyMode = this.keyMode; */
    } else {
      throw `Unhandled key mode for setNewRootKey ${this.keyMode}`;
    }
    this.rootKey = key;
    await this.storageService!.setValue(
      StorageKey.RootKeyParams,
      keyParams.getPortableValue(),
      StorageValueModes.Nonwrapped
    );
    if (this.keyMode === KeyMode.RootKeyOnly) {
      await this.saveRootKeyToKeychain();
    } else if (this.keyMode === KeyMode.RootKeyPlusWrapper) {
      if (!wrappingKey) {
        throw Error('wrappingKey must be supplied');
      }
      await this.wrapAndPersistRootKey(wrappingKey);
    }
    await this.notifyObserversOfKeyChange();
    await this.reencryptItemsKeys();
  }

  /**
   * Returns the in-memory root key value.
   */
  public async getRootKey() {
    return this.rootKey;
  }

  /**
   * Deletes root key and wrapper from keychain. Used when signing out of application.
   */
  public async clearLocalKeyState() {
    await this.deviceInterface!.clearKeychainValue();
    await this.storageService!.removeValue(
      StorageKey.WrappedRootKey,
      StorageValueModes.Nonwrapped
    );
    await this.storageService!.removeValue(
      StorageKey.RootKeyWrapperKeyParams,
      StorageValueModes.Nonwrapped
    );
    await this.storageService!.removeValue(
      StorageKey.RootKeyParams,
      StorageValueModes.Nonwrapped
    );
    this.keyMode = KeyMode.RootKeyNone;
    this.rootKey = undefined;
    await this.notifyObserversOfKeyChange();
  }

  /**
   * @param password  The password string to generate a root key from.
   */
  public async validateAccountPassword(password: string) {
    const keyParams = await this.getRootKeyParams();
    const key = await this.computeRootKey(password, keyParams!);
    const valid = key.compare(this.rootKey!);
    if (valid) {
      return { valid, artifacts: { rootKey: key } };
    } else {
      return { valid: false };
    }
  }

  /**
   * @param passcode  The passcode string to generate a root key from.
   */
  public async validatePasscode(passcode: string) {
    const keyParams = await this.getRootKeyWrapperKeyParams();
    const key = await this.computeRootKey(
      passcode,
      keyParams!
    );
    const valid = await this.validateWrappingKey(key);
    if (valid) {
      return { valid, artifacts: { wrappingKey: key } };
    } else {
      return { valid: false };
    }
  }

  /**
   * Only two types of items should be encrypted with a root key:
   * - An SNItemsKey object
   * - An encrypted storage object (local)
   */
  public contentTypeUsesRootKeyEncryption(contentType: ContentType) {
    return (
      contentType === ContentType.ItemsKey ||
      contentType === ContentType.EncryptedStorage
    );
  }

  /**
   * Determines which key to use for encryption of the payload
   * The key object to use for encrypting the payload.
  */
  private async keyToUseForEncryptionOfPayload(
    payload: PurePayload,
    intent: EncryptionIntents
  ) {
    if (isNullOrUndefined(intent)) {
      throw 'Intent must be supplied when looking up key for encryption of item.';
    }
    if (this.contentTypeUsesRootKeyEncryption(payload.content_type!)) {
      const rootKey = await this.getRootKey();
      if (!rootKey) {
        if (intentRequiresEncryption(intent)) {
          throw 'Root key encryption is required but no root key is available.';
        } else {
          return undefined;
        }
      }
      return rootKey;
    } else {
      return this.getDefaultItemsKey();
    }
  }

  /**
   * Payloads could have been previously encrypted with any arbitrary SNItemsKey object.
   * If the payload is an items key object, it is always encrypted with the root key,
   * and so return that. Otherwise, we check to see if the payload has an
   * items_key_id and return that key. If it doesn't, this means the payload was
   * encrypted with legacy behavior. We return then the key object corresponding
   * to the version of this payload.
   * @returns The key object to use for decrypting this payload.
  */
  private async keyToUseForDecryptionOfPayload(payload: PurePayload) {
    if (this.contentTypeUsesRootKeyEncryption(payload.content_type!)) {
      return this.getRootKey();
    }
    if (payload.items_key_id) {
      const itemsKey = this.itemsKeyForPayload(payload);
      return itemsKey;
    }
    const payloadVersion = payload.version;
    if (payloadVersion === this.getLatestVersion()) {
      throw 'No associated key found for item encrypted with latest protocol version.';
    }
    return this.defaultItemsKeyForItemVersion(payloadVersion);
  }

  public async onSyncEvent(eventName: SyncEvents) {
    if (eventName === SyncEvents.FullSyncCompleted) {
      await this.handleFullSyncCompletion();
    }
    if (eventName === SyncEvents.DownloadFirstSyncCompleted) {
      await this.handleDownloadFirstSyncCompletion();
    }
  }

  /** 
   * When a download-first sync completes, it means we've completed a (potentially multipage)
   * sync where we only downloaded what the server had before uploading anything. We will be
   * allowed to make local accomadations here before the server begins with the upload
   * part of the sync (automatically runs after download-first sync completes).
   * We use this to see if the server has any default itemsKeys, and if so, allows us to 
   * delete any never-synced items keys we have here locally.
   */
  private async handleDownloadFirstSyncCompletion() {
    /**
    * Find items keys with null or epoch updated_at value, indicating
    * that they haven't been synced yet.
    */
    const allItemsKeys = this.allItemsKeys;
    const neverSynced = allItemsKeys.filter((key) => {
      return key.neverSynced;
    });
    /**
    * Find isDefault items key that have been previously synced.
    * If we find one, this means we can delete any non-synced keys.
    */
    const defaultSyncedKey = allItemsKeys.find((key) => {
      return !key.neverSynced && key.isDefault;
    });
    const hasSyncedItemsKey = !isNullOrUndefined(defaultSyncedKey);
    if (hasSyncedItemsKey) {
      /** Delete all never synced keys */
      await this.modelManager!.setItemsToBeDeleted(neverSynced);
    } else {
      /**
       * No previous synced items key.
       * We can keep the one(s) we have, only if their version is equal to our root key version.
       * If their version is not equal to our root key version, delete them. If we end up with 0
       * items keys, create a new one.  */
      const rootKey = await this.getRootKey();
      if (rootKey) {
        /** If neverSynced.version != rootKey.version, delete. */
        const toDelete = neverSynced.filter((itemsKey) => {
          return itemsKey.version !== rootKey.version;
        });
        if (toDelete.length > 0) {
          await this.modelManager!.setItemsToBeDeleted(toDelete);
        }
        if (allItemsKeys.length === 0) {
          await this.createNewDefaultItemsKey();
        }
      }
    }
  }

  private async handleFullSyncCompletion() {
    /** Always create a new items key after full sync, if no items key is found */
    const currentItemsKey = this.getDefaultItemsKey();
    if (!currentItemsKey) {
      await this.createNewDefaultItemsKey();
      if (this.keyMode === KeyMode.WrapperOnly) {
        return this.repersistAllItems();
      }
    }
  }

  /**
   * If encryption status changes (esp. on mobile, where local storage encryption
   * can be disabled), consumers may call this function to repersist all items to
   * disk using latest encryption status.
   * @access public
   */
  async repersistAllItems() {
    const items = this.modelManager!.allItems;
    const payloads = items.map((item) => CreateMaxPayloadFromAnyObject(item));
    return this.storageService!.savePayloads(payloads)
  }

  /**
   * @access public
   * @returns All SN|ItemsKey objects synced to the account.
   */
  get allItemsKeys() {
    return this.modelManager!.itemsKeys;
  }

  /**
   * @returns The items key used to encrypt the payload
   */
  public itemsKeyForPayload(payload: PurePayload) {
    return this.allItemsKeys.find((key) => key.uuid === payload.items_key_id);
  }

  /**
   * @returns The SNItemsKey object to use to encrypt new or updated items.
   */
  public getDefaultItemsKey() {
    if (this.allItemsKeys.length === 1) {
      return this.allItemsKeys[0];
    }
    return this.allItemsKeys.find((key) => {
      return key.isDefault;
    });
  }

  /**
   * When the root key changes (non-null only), we must re-encrypt all items
   * keys with this new root key (by simply re-syncing).
   */
  public async reencryptItemsKeys() {
    const itemsKeys = this.allItemsKeys;
    if (itemsKeys.length > 0) {
      /** 
       * Do not call sync after marking dirty.
       * Re-encrypting items keys is called by consumers who have specific flows who
       * will sync on their own timing
        */
      await this.modelManager!.setItemsDirty(itemsKeys);
    }
  }

  /**
   * When migrating from non-SNItemsKey architecture, many items will not have a 
   * relationship with any key object. For those items, we can be sure that only 1 key 
   * object will correspond to that protocol version.
   * @returns The SNItemsKey object to decrypt items encrypted
   * with previous protocol version.
   */
  public async defaultItemsKeyForItemVersion(version: ProtocolVersions) {
    return this.allItemsKeys.find((key) => {
      return key.version === version;
    });
  }

  /**
   * Creates a new random SNItemsKey to use for item encryption, and adds it to model management.
   * Consumer must call sync. If the protocol version <= 003, only one items key should be created,
   * and its .itemsKey value should be equal to the root key masterKey value.
   */
  public async createNewDefaultItemsKey() {
    const rootKey = (await this.getRootKey())!;
    const operatorVersion = rootKey
      ? rootKey.version
      : this.getLatestVersion();
    let itemsKey;
    if (compareVersions(operatorVersion, LAST_NONROOT_ITEMS_KEY_VERSION) <= 0) {
      /** Create root key based items key */
      const payload = CreateMaxPayloadFromAnyObject({
        content_type: ContentType.ItemsKey,
        content: {
          itemsKey: rootKey.masterKey,
          dataAuthenticationKey: rootKey.dataAuthenticationKey,
          version: operatorVersion
        }
      });
      itemsKey = CreateItemFromPayload(payload);
      await itemsKey.initUUID();
    } else {
      /** Create independent items key */
      itemsKey = await this.operatorForVersion(operatorVersion).createItemsKey();
    }
    const currentDefault = this.getDefaultItemsKey();
    if (currentDefault) {
      currentDefault.content.isDefault = false;
      await this.modelManager!.setItemDirty(currentDefault);
    }
    itemsKey.content.isDefault = true;
    const payload = itemsKey.payloadRepresentation(
      {
        dirty: true
      }
    );
    await this.modelManager!.mapPayloadToLocalItem(
      payload,
      PayloadSources.LocalChanged
    );
  }
}
