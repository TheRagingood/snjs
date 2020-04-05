import { ItemsKeyMutator } from './../models/app/items_key';
import { SNTag } from '@Models/app/tag';
import { SNNote, NoteMutator } from './../models/app/note';
import { SNItemsKey } from '@Models/index';
import { SNActionsExtension, ActionsExtensionMutator } from './../models/app/extension';
import { SNSmartTag } from './../models/app/smartTag';
import { SNPredicate } from './../models/core/predicate';
import { Uuid } from './../uuid';
import { PayloadsByDuplicating } from '@Payloads/functions';
import { UuidString } from './../types';
import { MutableCollection } from './../protocol/payloads/mutable_collection';
import { CreateItemFromPayload, BuildItemContent } from '@Models/generator';
import { PureService } from '@Lib/services/pure_service';
import { ComponentTransformer } from './../models/app/component';
import { SNComponent } from '@Models/app/component';
import { isString, removeFromArray, searchArray } from '@Lib/utils';
import { CreateMaxPayloadFromAnyObject } from '@Payloads/generator';
import { PayloadOverride, PayloadContent } from './../protocol/payloads/generator';
import { SNItem, ItemMutator, MutationType } from './../models/core/item';
import { PayloadSource } from './../protocol/payloads/sources';
import { PurePayload } from './../protocol/payloads/pure_payload';
import { PayloadManager } from './model_manager';
import { ContentType } from '../models/content_types';

type ObserverCallback = (
  items: SNItem[],
  source?: PayloadSource,
  sourceKey?: string,
  type?: ObservationType,
) => Promise<void>

type Observer = {
  contentType: ContentType | ContentType[]
  callback: ObserverCallback
}
export enum ObservationType {
  /** The items have been newly inserted */
  Inserted = 1,
  /** The items are pre-existing but have been changed */
  Changed = 2
}

/**
 * The item manager is backed by the Payload Manager. Think of the item manager as a 
 * more user-friendly or item-specific interface to creating and updating data. 
 * The item manager listens for change events from the global payload manager, and 
 * converts any payloads to SNItems, then propagates those items to listeners on the 
 * item  manager. When the item manager makes a change to an item, it will modify items 
 * using a  mutator, then emit those payloads to the payload manager. The payload manager 
 * will then notify  its observers (which is us), we'll convert the payloads to items, 
 * and then  we'll propagate them to our listeners.
 */
export class ItemManager extends PureService {

  private modelManager?: PayloadManager
  private unsubInsertionObserver: any
  private unsubChangeObserver: any
  private observers: Observer[] = []
  private collection: MutableCollection<SNItem>
  private systemSmartTags: SNSmartTag[]

  /** Maintains an index for each item id where the value is an array of item ids that the 
   * item references. This is essentially equivalent to item.content.references, 
   * but keeps state even when the item is deleted. So if tag A references Note B, 
   * referenceMap[A.uuid] == [B.uuid]. */
  private referenceMap: Partial<Record<UuidString, UuidString[]>> = {}
  /** Maintains an index for each item id where the value is an array of item ids where 
   * the items reference the key item. So if tag A references Note B, 
   * inverseReferenceMap[B.uuid] == [A.uuid]. This allows callers to determine for a given item,
   * who references it? It would be prohibitive to look this up on demand */
  private inverseReferenceMap: Partial<Record<UuidString, UuidString[]>> = {}

  constructor(modelManager: PayloadManager) {
    super();
    this.modelManager = modelManager;
    this.collection = new MutableCollection();
    this.unsubChangeObserver = this.modelManager
      .addChangeObserver(ContentType.Any, this.onPayloadChange.bind(this));
    this.unsubInsertionObserver = this.modelManager
      .addInsertionObserver(this.onPayloadInsertion.bind(this));
    this.systemSmartTags = SNSmartTag.systemSmartTags();
  }

  public deinit() {
    this.unsubChangeObserver();
    this.unsubChangeObserver = undefined;
    this.unsubInsertionObserver();
    this.unsubInsertionObserver = undefined;
    this.modelManager = undefined;
    this.resetState();
  }

  private resetState() {
    this.collection = new MutableCollection();
    this.referenceMap = {};
    this.inverseReferenceMap = {};
  }

  /**
   * Returns an item for a given id
   */
  findItem(uuid: UuidString) {
    return this.collection.find(uuid) as SNItem | undefined;
  }

  /**
   * Returns all items matching given ids
   * @param includeBlanks If true and an item is not found, an `undefined` element
   * will be inserted into the array.
   */
  findItems(uuids: UuidString[], includeBlanks = false) {
    return this.collection.findAll(uuids, includeBlanks);
  }

  get itemsKeys() {
    return this.collection.all(ContentType.ItemsKey) as SNItemsKey[];
  }

  get notes() {
    return this.collection.all(ContentType.Note) as SNNote[];
  }

  get tags() {
    return this.collection.all(ContentType.Tag) as SNTag[];
  }

  get components() {
    return this.collection.all(ContentType.Component) as SNComponent[];
  }

  public addObserver(
    contentType: ContentType | ContentType[],
    callback: ObserverCallback,
  ) {
    const observer: Observer = {
      contentType,
      callback
    }
    this.observers.push(observer);
    return () => {
      removeFromArray(this.observers, observer);
    }
  }

  /**
   * Returns the items that reference the given item, or an empty array if no results.
   */
  private itemsThatReferenceItem(uuid: UuidString) {
    const uuids = this.uuidsThatReferenceUuid(uuid);
    return this.findItems(uuids);
  }

  private uuidsThatReferenceUuid(uuid: UuidString) {
    return this.inverseReferenceMap[uuid] || [];
  }

  private establishReferenceIndex(item: SNItem) {
    const references = item.references;
    for (const reference of references) {
      /** Direct index */
      this.referenceMap[item.uuid] = item.references.map((r) => r.uuid);

      /** Inverse index */
      const index = this.inverseReferenceMap[reference.uuid] || [];
      index.push(item.uuid);
      this.inverseReferenceMap[reference.uuid] = index;
    }
  }

  private deestablishReferenceIndexForDeletedItem(uuid: UuidString) {
    /** Items that we reference */
    const directReferences = this.referenceMap[uuid] || []
    for (const directReference of directReferences) {
      removeFromArray(
        this.inverseReferenceMap[directReference] || [],
        uuid
      );
    }
    delete this.referenceMap[uuid];

    /** Items that are referencing us */
    const inverseReferences = this.inverseReferenceMap[uuid] || []
    for (const inverseReference of inverseReferences) {
      removeFromArray(
        this.referenceMap[inverseReference] || [],
        uuid
      );
    }
    delete this.inverseReferenceMap[uuid];
  }

  private async onPayloadChange(
    allChangedPayloads: PurePayload[],
    nondeletedPayloads?: PurePayload[],
    deletedPayloads?: PurePayload[],
    source?: PayloadSource,
    sourceKey?: string
  ) {
    const items = await this.setPayloads(
      allChangedPayloads,
      ObservationType.Changed,
      source,
      sourceKey
    );
    const deleted = items.filter((item) => item.payload.discardable);
    this.collection.delete(deleted);
  }

  private async onPayloadInsertion(
    payloads: PurePayload[],
    source?: PayloadSource,
    sourceKey?: string
  ) {
    this.setPayloads(
      payloads,
      ObservationType.Inserted,
      source,
      sourceKey
    );
  }

  private async setPayloads(
    payloads: PurePayload[],
    type: ObservationType,
    source?: PayloadSource,
    sourceKey?: string,
  ) {
    const items = payloads.map((payload) => {
      return CreateItemFromPayload(payload);
    });
    for (const item of items) {
      if (item.deleted) {
        this.deestablishReferenceIndexForDeletedItem(item.uuid);
      } else {
        this.establishReferenceIndex(item);
      }
    }
    this.collection.set(items)
    await this.notifyObservers(items, type, source, sourceKey);
    return items;
  }

  private async notifyObservers(
    items: SNItem[],
    type: ObservationType,
    source?: PayloadSource,
    sourceKey?: string
  ) {
    for (const observer of this.observers) {
      const relevantItems = items.filter((item) => {
        return (
          observer.contentType === ContentType.Any ||
          observer.contentType === item.content_type!
        )
      });
      await observer.callback(relevantItems, source, sourceKey, type);
    }
  }

  /**
   * Consumers wanting to modify an item should run it through this block,
   * so that data is properly mapped through our function, and latest state
   * is properly reconciled.
   * @param itemOrUuid If an item is passed, the values of that item will be directly used,
   * and the mutation will be applied on that item and propagated. This means that if you pass
   * an old item reference and mutate that, the new value will be outdated. In this case, always
   * pass the uuid of the item if you want to mutate the latest version of the item.
   */
  async changeItem(
    itemOrUuid: UuidString | SNItem,
    mutate: (mutator: ItemMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const results = await this.changeItems(
      [itemOrUuid] as UuidString[] | SNItem[],
      mutate,
      mutationType,
      payloadSource,
      payloadSourceKey
    );
    return results[0];
  }

  /**
   * @param itemsOrUuids If an item is passed, the values of that item will be directly used,
   * and the mutation will be applied on that item and propagated. This means that if you pass
   * an old item reference and mutate that, the new value will be outdated. In this case, always
   * pass the uuid of the item if you want to mutate the latest version of the item.
   */
  async changeItems(
    itemsOrUuids: UuidString[] | SNItem[],
    mutate: (mutator: ItemMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const items = isString(itemsOrUuids[0])
      ? this.findItems(itemsOrUuids as UuidString[], true)
      : itemsOrUuids as SNItem[];
    const payloads = [];
    for (const item of items) {
      if (!item) {
        throw Error('Attempting to change non-existant item');
      }
      const mutator = new ItemMutator(item, mutationType);
      mutate(mutator);
      const payload = mutator.getResult();
      payloads.push(payload);
    }
    await this.modelManager!.emitPayloads(
      payloads,
      payloadSource || PayloadSource.LocalChanged,
      payloadSourceKey
    );
    const results = this.findItems(payloads.map((p) => p.uuid!));
    return results;
  }

  async changeNote(
    itemOrUuid: UuidString | SNNote,
    mutate: (mutator: NoteMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const note = isString(itemOrUuid)
      ? this.findItem(itemOrUuid as UuidString)
      : itemOrUuid as SNNote;
    if (!note) {
      throw Error('Attempting to change non-existant note');
    }
    const mutator = new NoteMutator(note, mutationType);
    return this.applyTransform(
      mutator,
      mutate,
      payloadSource,
      payloadSourceKey
    )
  }

  async changeComponent(
    itemOrUuid: UuidString | SNComponent,
    mutate: (mutator: ComponentTransformer) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const component = isString(itemOrUuid)
      ? this.findItem(itemOrUuid as UuidString)
      : itemOrUuid as SNComponent;
    if (!component) {
      throw Error('Attempting to change non-existant component');
    }
    const mutator = new ComponentTransformer(component, mutationType);
    return this.applyTransform(
      mutator,
      mutate,
      payloadSource,
      payloadSourceKey
    )
  }

  async changeActionsExtension(
    itemOrUuid: UuidString | SNActionsExtension,
    mutate: (mutator: ActionsExtensionMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const extension = isString(itemOrUuid)
      ? this.findItem(itemOrUuid as UuidString)
      : itemOrUuid as SNActionsExtension;
    if (!extension) {
      throw Error('Attempting to change non-existant extension');
    }
    const mutator = new ActionsExtensionMutator(extension, mutationType);
    return this.applyTransform(
      mutator,
      mutate,
      payloadSource,
      payloadSourceKey
    )
  }

  async changeItemsKey(
    itemOrUuid: UuidString | SNItemsKey,
    mutate: (mutator: ItemsKeyMutator) => void,
    mutationType: MutationType = MutationType.UserInteraction,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    const itemsKey = isString(itemOrUuid)
      ? this.findItem(itemOrUuid as UuidString)
      : itemOrUuid as SNItemsKey;
    if (!itemsKey) {
      throw Error('Attempting to change non-existant itemsKey');
    }
    const mutator = new ItemsKeyMutator(itemsKey, mutationType);
    return this.applyTransform(
      mutator,
      mutate,
      payloadSource,
      payloadSourceKey
    )
  }

  private async applyTransform<T extends ItemMutator>(
    mutator: T,
    mutate: (mutator: T) => void,
    payloadSource?: PayloadSource,
    payloadSourceKey?: string
  ) {
    mutate(mutator);
    const payload = mutator.getResult();
    return this.modelManager!.emitPayload(
      payload,
      payloadSource || PayloadSource.LocalChanged,
      payloadSourceKey
    );
  }

  /**
    * Sets the item as needing sync. The item is then run through the mapping function,
    * and propagated to mapping observers.
    * @param updateClientDate - Whether to update the item's "user modified date"
    */
  public async setItemDirty(
    uuid: UuidString,
    dirty = true,
    isUserModified = false,
    source?: PayloadSource,
    sourceKey?: string
  ) {
    return this.setItemsDirty(
      [uuid],
      dirty,
      isUserModified,
      source,
      sourceKey
    );
  }

  /**
   * Similar to `setItemDirty`, but acts on an array of items as the first param.
   */
  public async setItemsDirty(
    uuids: UuidString[],
    dirty = true,
    isUserModified = false,
    source?: PayloadSource,
    sourceKey?: string
  ) {
    return this.changeItems(
      uuids,
      () => { },
      isUserModified ? MutationType.UserInteraction : MutationType.Internal,
      source,
      sourceKey
    );
  }

  /**
   * Returns an array of items that need to be synced.
   */
  public getDirtyItems() {
    return this.items.filter((item) => {
      /* An item that has an error decrypting can be synced only if it is being deleted.
        Otherwise, we don't want to send corrupt content up to the server. */
      return item.dirty && !item.dummy && (!item.errorDecrypting || item.deleted);
    });
  }


  /**
   * Duplicates an item and maps it, thus propagating the item to observers.
   * @param isConflict - Whether to mark the duplicate as a conflict of the original.
   */
  public async duplicateItem(item: SNItem, isConflict = false) {
    const payload = CreateMaxPayloadFromAnyObject(item);
    const resultingPayloads = await PayloadsByDuplicating(
      payload,
      this.modelManager!.getMasterCollection(),
      isConflict,
    );
    await this.modelManager!.emitPayloads(
      resultingPayloads,
      PayloadSource.LocalChanged
    );
    const duplicate = this.findItem(resultingPayloads[0].uuid!);
    return duplicate!;
  }

  /**
   * Creates an item and conditionally maps it and marks it as dirty.
   * @param needsSync - Whether to mark the item as needing sync
   */
  public async createItem(
    contentType: ContentType,
    content?: PayloadContent,
    needsSync = false,
    override?: PayloadOverride
  ) {
    if (!contentType) {
      throw 'Attempting to create item with no contentType';
    }
    const payload = CreateMaxPayloadFromAnyObject(
      {
        uuid: await Uuid.GenerateUuid(),
        content_type: contentType,
        content: BuildItemContent(content),
        dirty: needsSync
      },
      undefined,
      undefined,
      override
    );
    await this.modelManager!.emitPayload(payload, PayloadSource.Constructor);
    return this.findItem(payload.uuid!)!;
  }

  public async createTemplateItem(
    contentType: ContentType,
    content?: PayloadContent,
  ) {
    const payload = CreateMaxPayloadFromAnyObject(
      {
        uuid: await Uuid.GenerateUuid(),
        content_type: contentType,
        content: BuildItemContent(content)
      }
    );
    return CreateItemFromPayload(payload);
  }

  public async emitItemFromPayload(
    payload: PurePayload,
    source = PayloadSource.Constructor
  ) {
    await this.modelManager!.emitPayload(payload, source);
    return this.findItem(payload.uuid!);
  }

  /**
   * Marks the item as deleted and needing sync.
   * Removes the item from respective content arrays (this.notes, this.tags, etc.)
   */
  public async setItemToBeDeleted(uuid: UuidString) {
    await this.changeItem(uuid, (mutator) => {
      mutator.setDeleted();
    });

    /* Direct relationships are cleared by clearing content above */
    /* Handle indirect relationships */
    const referencingIds = this.uuidsThatReferenceUuid(uuid);
    for (const referencingId of referencingIds) {
      const referencingItem = this.findItem(referencingId);
      if (referencingItem) {
        await this.changeItem(referencingId, (mutator) => {
          mutator.removeItemAsRelationship(referencingItem);
        });
      }
    }
    this.deestablishReferenceIndexForDeletedItem(uuid);
  }

  /**
   * Like `setItemToBeDeleted`, but acts on an array of items.
   */
  public async setItemsToBeDeleted(uuids: UuidString[]) {
    for (const uuid of uuids) {
      await this.setItemToBeDeleted(uuid);
    }
  }

  /** 
   * Returns a detached array of all items
   */
  public get items() {
    return this.collection.all();
  }

  /**
   * Returns a detached array of all items which are not dummys
   */
  public get allNondummyItems() {
    return this.items.filter((item) => {
      return !item.dummy;
    });
  }

  /**
   * Returns a detached array of all items which are not deleted
   */
  public get nonDeletedItems() {
    return this.items.filter((item) => {
      return !item.dummy && !item.deleted;
    });
  }

  /**
   * Returns all items of a certain type
   * @param contentType - A string or array of strings representing
   *    content types.
   */
  public getItems(contentType: ContentType | ContentType[]): SNItem[] {
    if (Array.isArray(contentType)) {
      return this.items.filter((item) => {
        return !item.dummy && contentType.includes(item.content_type!);
      });
    }
    const managed = this.managedItemsForContentType(contentType);
    return managed || this.getItems([contentType]);
  }

  private managedItemsForContentType(contentType: ContentType): SNItem[] | null {
    if (contentType === ContentType.Note) {
      return this.notes.slice();
    } else if (contentType === ContentType.Component) {
      return this.components.slice();
    } else if (contentType === ContentType.Tag) {
      return this.tags.slice();
    }
    return null;
  }

  /** 
   * Returns all items that have not been able to decrypt.
   */
  public invalidItems() {
    return this.items.filter((item) => {
      return item.errorDecrypting;
    });
  }

  /**
   * Returns all items which are properly decrypted
   */
  validItemsForContentType(contentType: ContentType) {
    const managed = this.managedItemsForContentType(contentType);
    const items = managed || this.items;
    return items.filter((item) => {
      return !item.errorDecrypting && (
        Array.isArray(contentType)
          ? contentType.includes(item.content_type)
          : item.content_type === contentType
      );
    });
  }

  /**
   * Returns all items matching a given predicate
   */
  public itemsMatchingPredicate(predicate: SNPredicate) {
    return this.itemsMatchingPredicates([predicate]);
  }

  /**
  * Returns all items matching an array of predicates
  */
  public itemsMatchingPredicates(predicates: SNPredicate[]) {
    return this.filterItemsWithPredicates(this.items, predicates);
  }

  /**
   * Performs actual predicate filtering for public methods above.
   * Does not return deleted items.
   */
  private filterItemsWithPredicates(items: SNItem[], predicates: SNPredicate[]) {
    const results = items.filter((item) => {
      if (item.deleted) {
        return false;
      }
      for (const predicate of predicates) {
        if (!item.satisfiesPredicate(predicate)) {
          return false;
        }
      }
      return true;
    });
    return results;
  }

  /**
   * Finds the first tag matching a given title
   */
  public findTagByTitle(title: string) {
    return searchArray(this.tags, { title: title });
  }

  /**
  * Finds or creates a tag with a given title
  */
  public async findOrCreateTagByTitle(title: string) {
    const tag = this.findTagByTitle(title);
    return tag || await this.createItem(
      ContentType.Tag,
      BuildItemContent({ title }),
      true
    ) as SNTag;
  }

  /**
   * Returns all notes matching the smart tag
   */
  public notesMatchingSmartTag(smartTag: SNSmartTag) {
    const contentTypePredicate = new SNPredicate('content_type', '=', ContentType.Note);
    const predicates = [contentTypePredicate, smartTag.predicate];
    if (!smartTag.isTrashTag) {
      const notTrashedPredicate = new SNPredicate('content.trashed', '=', false);
      predicates.push(notTrashedPredicate);
    }
    const results = this.itemsMatchingPredicates(predicates);
    return results;
  }

  /**
   * Returns the smart tag corresponding to the "Trash" tag.
   */
  public get trashSmartTag() {
    return this.systemSmartTags.find((tag) => tag.isTrashTag)!;
  }

  /**
   * Returns all items currently in the trash
   */
  public get trashedItems() {
    return this.notesMatchingSmartTag(this.trashSmartTag);
  }

  /**
   * Permanently deletes any items currently in the trash. Consumer must manually call sync.
   */
  public async emptyTrash() {
    const notes = this.trashedItems;
    return this.setItemsToBeDeleted(this.uuidsForItems(notes));
  }

  public uuidsForItems(items: SNItem[]) {
    return items.map((i) => i.uuid!);
  }

  /**
   * Returns all smart tags, sorted by title.
   */
  public getSmartTags() {
    const userTags = this.validItemsForContentType(ContentType.SmartTag) as SNSmartTag[];
    const sortedUserTags = userTags.sort((a, b) => {
      return a.title < b.title ? -1 : 1;
    }) as SNSmartTag[];
    return this.systemSmartTags.concat(sortedUserTags);
  }

  /**
   * The number of notes currently managed
   */
  public get noteCount() {
    return this.notes.filter((n) => !n.dummy).length;
  }

  /**
   * Immediately removes all items from mapping state and notifies observers
   * Used primarily when signing into an account and wanting to discard any current
   * local data.
   */
  public async removeAllItemsFromMemory() {
    const uuids = this.uuidsForItems(this.items);
    await this.changeItems(uuids, (mutator) => {
      mutator.setDeleted();
    });
    this.resetState();
    this.modelManager!.resetState();
  }

  public removeItemLocally(item: SNItem) {
    this.collection.delete(item);
    this.modelManager!.removePayloadLocally(item.payload);
  }
}