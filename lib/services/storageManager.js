import { EncryptionIntentLocalStorage } from '@Protocol/intents';

const STORAGE_CONTENT_TYPE = 'SN|Storage';

export class SFStorageManager {

  constructor({protocolManager, databaseManager}) {
    this.protocolManager = protocolManager;
    this.databaseManager = databaseManager;
    this.setLocalStoragePolicy({encrypt: true, ephemeral: false});
    this.setLocalDatabaseStoragePolicy({ephemeral: false});
  }

  /**
   * Platforms must override this method to provide their own read from disk solution.
   * For example, web might load from localStorage, and mobile might load from AsyncStorage.
   * Upon completion, consumer must call setPayload.
  */
  async initializeFromDisk() {
    throw 'Must override';
  }

  /**
   * Platforms must override this to persist an arbitrary payload object to disk.
   */
  async persistAsPayloadToDisk(payload) {
    throw 'Must override';
  }

  /**
   * Called by platforms with the value they load from disk, after they handle initializeFromDisk
   */
  async setPayload(payload) {
    if(payload.content_type === STORAGE_CONTENT_TYPE) {
      const item = new SFItem({content: payload, content_type: STORAGE_CONTENT_TYPE});
      await this.protocolManager.decryptItem({item});
      this.localStorageValues = item.content;
    } else {
      this.localStorageValues = payload;
    }
  }

  /**
   * Generates a payload that can be persisted to disk, either as a plain object, or an encrypted item.
  */
  async generatePayload() {
    const rawPayload = Object.assign({}, this.localStorageValues);
    if(this.localStorageEncryptionDisabled === true) {
      return rawPayload;
    } else {
      const item = new SFItem({content: rawPayload, content_type: STORAGE_CONTENT_TYPE});
      await this.protocolManager.encryptItem({item, intent: EncryptionIntentLocalStorage});
      return item;
    }
  }

  async setLocalStoragePolicy({encrypt, ephemeral}) {
    this.localStorageEncryptionDisabled = !encrypt;
    this.localStorageEphemeral = ephemeral;
  }

  setLocalDatabaseStoragePolicy({ephemeral}) {
    this.localDatabaseEphemeral = ephemeral;
  }

  async repersistToDisk() {
    if(this.localStorageEphemeral === true) {
      return;
    }
    const payload = await this.generatePayload();
    this.persistAsPayloadToDisk(payload);
  }

  async setItem(key, value) {
    if(!this.localStorageValues) {
      throw 'Attempting to set local storage item without first loading local storage.';
    }
    this.localStorageValues[key] = value;
    this.repersistToDisk();
  }

  getItemSync(key) {
    if(!this.localStorageValues) {
      throw 'Attempting to access local storage item without first loading local storage.';
    }
    return this.localStorageValues[key];
  }

  async getItem(key) {
    if(!this.localStorageValues) {
      throw 'Attempting to access local storage item without first loading local storage.';
    }
    return this.localStorageValues[key];
  }

  async removeItem(key) {
    if(!this.localStorageValues) {
      throw 'Attempting to access local storage item without first loading local storage.';
    }
    delete this.localStorageValues[key];
    this.repersistToDisk();
  }

  /**
   *  Clears simple key/value items from storage only. Does not affect models.
   */
  async clear() {
    this.localStorageValues = {};
    this.repersistToDisk();
  }

  /**
   * Model Storage
   */

  async getAllModels() {
    return this.databaseManager.getAllModels();
  }

  async saveModel(item) {
    if(this.localDatabaseEphemeral) {
      return;
    }
    return this.saveModels([item]);
  }

  async saveModels(items) {
    if(this.localDatabaseEphemeral) {
      return;
    }
    return this.databaseManager.saveModels(items);
  }

  async deleteModel(item) {
    return this.databaseManager.deleteModel(item);
  }

  async clearAllModels() {
    return this.databaseManager.clearAllModels();
  }

  /**
   * General
   */

  async clearAllData() {
    return Promise.all([
      this.clear(),
      this.clearAllModels()
    ])
  }
}