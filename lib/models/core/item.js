import find from 'lodash/find';
import remove from 'lodash/remove';
import isArray from 'lodash/isArray';
import mergeWith from 'lodash/mergeWith';
import { SFPredicate } from '@Models/core/predicate'

let dateFormatter;

export class SFItem {

  /**
   * Dynamically feed both a syncronous and asyncronous implementation of a UUID generator function.
   * Feeding it this way allows platforms to implement their own uuid generation schemes, without
   * this class having to import any global functions.
   * @param syncImpl  A syncronous function that returns a UUID.
   * @param asyncImpl  An asyncronous function that returns a UUID.
   */
  static SetUuidGenerators({syncImpl, asyncImpl}) {
    this.syncUuidFunc = syncImpl;
    this.asyncUuidFunc = asyncImpl;
  }

  /**
   * A default async implementation of uuid generation.
   */
  static async GenerateUuid() {
    if(this.syncUuidFunc) {
      return this.syncUuidFunc();
    } else {
      return this.asyncUuidFunc();
    }
  }

  /**
   * A default sync implementation of uuid generation.
   */
  static GenerateUuidSynchronously() {
    return this.syncUuidFunc();
  }

  constructor(json_obj = {}) {
    this.content = {};
    this.referencingObjects = [];
    this.updateFromJSON(json_obj);

    if(!this.uuid) {
      if(SFItem.syncUuidFunc) {
        this.uuid = SFItem.syncUuidFunc();
      }
    }

    if(typeof this.content === 'object' && !this.content.references) {
      this.content.references = [];
    }
  }

  /**
   * Consumers who create items without a syncronous UUID generation function must manually call
   * this function when creating an item. The consumer must have previously called SFItem.SetUuidGenerators
   */
  async initUUID() {
    if(!this.uuid) {
      this.uuid = await SFItem.asyncUuidFunc();
    }
  }

  get contentObject() {

    if(this.errorDecrypting) {
      return this.content;
    }

    if(!this.content) {
      this.content = {};
      return this.content;
    }

    if(this.content !== null && typeof this.content === 'object') {
      // this is the case when mapping localStorage content, in which case the content is already parsed
      return this.content;
    }

    try {
      let content = JSON.parse(this.content);
      this.content = content;
      return this.content;
    } catch (e) {
      console.log("Error parsing json", e, this);
      this.content = {};
      return this.content;
    }
  }

  static deepMerge(a, b) {
    // By default merge will not merge a full array with an empty one.
    // We want to replace arrays wholesale
    function mergeCopyArrays(objValue, srcValue) {
      if (isArray(objValue)) {
        return srcValue;
      }
    }
    mergeWith(a, b, mergeCopyArrays);
    return a;
  }

  updateFromJSON(json) {
    // Don't expect this to ever be the case but we're having a crash with Android and this is the only suspect.
    if(!json) {
      return;
    }

    this.deleted = json.deleted;
    this.uuid = json.uuid;
    this.enc_item_key = json.enc_item_key;
    this.auth_hash = json.auth_hash;

    /**
      Legacy behavior. Only 003 and 002 supported this.
     */
    this.auth_params = json.auth_params;

    // When updating from server response (as opposed to local json response), these keys will be missing.
    // So we only want to update these values if they are explicitly present.
    let clientKeys = ["errorDecrypting", "dirty", "dirtyCount", "dirtiedDate", "dummy"];
    for(var key of clientKeys) {
      if(json[key] !== undefined) {
        this[key] = json[key];
      }
    }

    if(this.dirtiedDate && typeof this.dirtiedDate === 'string') {
      this.dirtiedDate = new Date(this.dirtiedDate);
    }

    // Check if object has getter for content_type, and if so, skip
    if(!this.content_type) {
      this.content_type = json.content_type;
    }

    // this.content = json.content will copy it by reference rather than value. So we need to do a deep merge after.
    // json.content can still be a string here. We copy it to this.content, then do a deep merge to transfer over all values.

    if(json.errorDecrypting) {
      this.content = json.content;
    } else {
      try {
        let parsedContent = typeof json.content === 'string' ? JSON.parse(json.content) : json.content;
        SFItem.deepMerge(this.contentObject, parsedContent);
      } catch (e) {
        console.log("Error while updating item from json", e);
      }
    }

    // Manually merge top level data instead of wholesale merge
    if(json.created_at) {
      this.created_at = json.created_at;
    }
    // Could be null if we're mapping from an extension bridge, where we remove this as its a private property.
    if(json.updated_at) {
      this.updated_at = json.updated_at;
    }

    if(this.created_at) { this.created_at = new Date(this.created_at);}
    else { this.created_at = new Date();}

    if(this.updated_at) { this.updated_at = new Date(this.updated_at);}
    else { this.updated_at = new Date(0);} // Epoch

    // Allows the getter to be re-invoked
    this._client_updated_at = null;

    if(json.content) {
      this.mapContentToLocalProperties(this.contentObject);
    } else if(json.deleted == true) {
      this.handleDeletedContent();
    }
  }

  mapContentToLocalProperties(contentObj) {

  }

  /*
  See note in createContentJSONFromProperties. When setting an item dirty, we want to immediately merge any
  custom properties (like note.title and note.text) into .content, so that any .content operations we apply have
  the latest values.
  */

  collapseCustomPropertiesIntoContent() {
    this.createContentJSONFromProperties();
  }

  createContentJSONFromProperties() {
    /*
    NOTE: This function does have side effects and WILL modify our content.

    Subclasses will override structureParams, and add their own custom content and properties to the object returned from structureParams
    These are properties that this superclass will not be aware of, like 'title' or 'text'

    When we call createContentJSONFromProperties, we want to update our own inherit 'content' field with the values returned from structureParams,
    so that our content field is up to date.

    Each subclass will call super.structureParams and merge it with its own custom result object.
    Since our own structureParams gets a real-time copy of our content, it should be safe to merge the aggregate value back into our own content field.
    */
    let content = this.structureParams();

    SFItem.deepMerge(this.contentObject, content);

    // Return the content item copy and not our actual value, as we don't want it to be mutated outside our control.
    return content;
  }

  structureParams() {
    return this.getContentCopy();
  }

  /* Allows the item to handle the case where the item is deleted and the content is null */
  handleDeletedContent() {
    // Subclasses can override
  }

  setDirty(dirty, updateClientDate) {
    this.dirty = dirty;

    // Allows the syncManager to check if an item has been marked dirty after a sync has been started
    // This prevents it from clearing it as a dirty item after sync completion, if someone else has marked it dirty
    // again after an ongoing sync.
    if(!this.dirtyCount) { this.dirtyCount = 0; }
    if(dirty) {
      this.dirtyCount++;
    } else {
      this.dirtyCount = 0;
    }

    // Used internally by syncManager to determine if a dirted item needs to be saved offline.
    // You want to set this in both cases, when dirty is true and false. If it's false, we still need
    // to save it to disk as an update.
    this.dirtiedDate = new Date();

    if(dirty && updateClientDate) {
      // Set the client modified date to now if marking the item as dirty
      this.client_updated_at = new Date();
    } else if(!this.hasRawClientUpdatedAtValue()) {
      // if we don't have an explcit raw value, we initialize client_updated_at.
      this.client_updated_at = new Date(this.updated_at);
    }

    this.collapseCustomPropertiesIntoContent();
  }

  updateLocalRelationships() {
    // optional override
  }

  addItemAsRelationship(item) {
    item.setIsBeingReferencedBy(this);

    if(this.hasRelationshipWithItem(item)) {
      return;
    }

    var references = this.content.references || [];
    references.push({
      uuid: item.uuid,
      content_type: item.content_type
    })
    this.content.references = references;
  }

  removeItemAsRelationship(item) {
    item.setIsNoLongerBeingReferencedBy(this);
    this.removeReferenceWithUuid(item.uuid);
  }

  // When another object has a relationship with us, we push that object into memory here.
  // We use this so that when `this` is deleted, we're able to update the references of those other objects.
  setIsBeingReferencedBy(item) {
    if(!find(this.referencingObjects, {uuid: item.uuid})) {
      this.referencingObjects.push(item);
    }
  }

  setIsNoLongerBeingReferencedBy(item) {
    remove(this.referencingObjects, {uuid: item.uuid});
    // Legacy two-way relationships should be handled here
    if(this.hasRelationshipWithItem(item)) {
      this.removeReferenceWithUuid(item.uuid);
      // We really shouldn't have the authority to set this item as dirty, but it's the only way to save this change.
      this.setDirty(true);
    }
  }

  removeReferenceWithUuid(uuid) {
    var references = this.content.references || [];
    references = references.filter((r) => {return r.uuid != uuid});
    this.content.references = references;
  }

  hasRelationshipWithItem(item) {
    let target = this.content.references.find((r) => {
      return r.uuid == item.uuid;
    });
    return target != null;
  }

  isBeingRemovedLocally() {

  }

  didFinishSyncing() {

  }

  informReferencesOfUUIDChange(oldUUID, newUUID) {
    // optional override
  }

  potentialItemOfInterestHasChangedItsUUID(newItem, oldUUID, newUUID) {
    if(this.errorDecrypting) {
      return;
    }
    for(let reference of this.content.references) {
      if(reference.uuid == oldUUID) {
        reference.uuid = newUUID;
        this.setDirty(true);
      }
    }
  }

  doNotEncrypt() {
    return false;
  }

  /*
  App Data
  */

  setDomainDataItem(key, value, domain) {
    if(!domain) {
      console.error("SFItem.AppDomain needs to be set.");
      return;
    }

    if(this.errorDecrypting) {
      return;
    }

    if(!this.content.appData) {
      this.content.appData = {};
    }

    var data = this.content.appData[domain];
    if(!data) {
      data = {}
    }
    data[key] = value;
    this.content.appData[domain] = data;
  }

  getDomainDataItem(key, domain) {
    if(!domain) {
      console.error("SFItem.AppDomain needs to be set.");
      return;
    }

    if(this.errorDecrypting) {
      return;
    }

    if(!this.content.appData) {
      this.content.appData = {};
    }

    var data = this.content.appData[domain];
    if(data) {
      return data[key];
    } else {
      return null;
    }
  }

  setAppDataItem(key, value) {
    this.setDomainDataItem(key, value, SFItem.AppDomain);
  }

  getAppDataItem(key) {
    return this.getDomainDataItem(key, SFItem.AppDomain);
  }

  get pinned() {
    return this.getAppDataItem("pinned");
  }

  get archived() {
    return this.getAppDataItem("archived");
  }

  get locked() {
    return this.getAppDataItem("locked");
  }

  // May be used by clients to display the human readable type for this item. Should be overriden by subclasses.
  get displayName() {
    return "Item";
  }

  hasRawClientUpdatedAtValue() {
    return this.getAppDataItem("client_updated_at") != null;
  }

  get client_updated_at() {
    if(!this._client_updated_at) {
      var saved = this.getAppDataItem("client_updated_at");
      if(saved) {
        this._client_updated_at = new Date(saved);
      } else {
        this._client_updated_at = new Date(this.updated_at);
      }
    }
    return this._client_updated_at;
  }

  set client_updated_at(date) {
    this._client_updated_at = date;

    this.setAppDataItem("client_updated_at", date);
  }

  /*
    During sync conflicts, when determing whether to create a duplicate for an item, we can omit keys that have no
    meaningful weight and can be ignored. For example, if one component has active = true and another component has active = false,
    it would be silly to duplicate them, so instead we ignore this.
   */
  keysToIgnoreWhenCheckingContentEquality() {
    return [];
  }

  // Same as above, but keys inside appData[Item.AppDomain]
  appDataKeysToIgnoreWhenCheckingContentEquality() {
    return ["client_updated_at"];
  }

  getContentCopy() {
    let contentCopy = JSON.parse(JSON.stringify(this.content));
    return contentCopy;
  }

  isItemContentEqualWith(otherItem) {
    return SFItem.AreItemContentsEqual({
      leftContent: this.content,
      rightContent: otherItem.content,
      keysToIgnore: this.keysToIgnoreWhenCheckingContentEquality(),
      appDataKeysToIgnore: this.appDataKeysToIgnoreWhenCheckingContentEquality()
    })
  }

  isContentEqualWithNonItemContent(otherContent) {
    return SFItem.AreItemContentsEqual({
      leftContent: this.content,
      rightContent: otherContent,
      keysToIgnore: this.keysToIgnoreWhenCheckingContentEquality(),
      appDataKeysToIgnore: this.appDataKeysToIgnoreWhenCheckingContentEquality()
    })
  }

  static AreItemContentsEqual({leftContent, rightContent, keysToIgnore, appDataKeysToIgnore}) {
    const omit = (obj, keys) => {
      if(!obj) { return obj; }
      for(let key of keys) {
        delete obj[key];
      }
      return obj;
    }

    // Create copies of objects before running omit as not to modify source values directly.
    leftContent = JSON.parse(JSON.stringify(leftContent));
    if(leftContent.appData) {
      omit(leftContent.appData[SFItem.AppDomain], appDataKeysToIgnore);
    }
    leftContent = omit(leftContent, keysToIgnore);

    rightContent = JSON.parse(JSON.stringify(rightContent));
    if(rightContent.appData) {
      omit(rightContent.appData[SFItem.AppDomain], appDataKeysToIgnore);
    }
    rightContent = omit(rightContent, keysToIgnore);

    return JSON.stringify(leftContent) === JSON.stringify(rightContent);
  }

  satisfiesPredicate(predicate) {
    /*
    Predicate is an SFPredicate having properties:
    {
      keypath: String,
      operator: String,
      value: object
    }
     */
    return SFPredicate.ItemSatisfiesPredicate(this, predicate);
  }

  /*
  Dates
  */

  createdAtString() {
    return this.dateToLocalizedString(this.created_at);
  }

  updatedAtString() {
    return this.dateToLocalizedString(this.client_updated_at);
  }

  updatedAtTimestamp() {
    return this.updated_at.getTime();
  }

  dateToLocalizedString(date) {
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      if (!dateFormatter) {
        var locale = (navigator.languages && navigator.languages.length) ? navigator.languages[0] : navigator.language;
        dateFormatter = new Intl.DateTimeFormat(locale, {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
      return dateFormatter.format(date);
    } else {
      // IE < 11, Safari <= 9.0.
      // In English, this generates the string most similar to
      // the toLocaleDateString() result above.
      return date.toDateString() + ' ' + date.toLocaleTimeString();
    }
  }

}