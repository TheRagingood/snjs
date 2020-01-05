import '../../node_modules/regenerator-runtime/runtime.js';
import '../../dist/snjs.js';
import '../../node_modules/chai/chai.js';
import './../vendor/chai-as-promised-built.js';
import Factory from '../lib/factory.js';
chai.use(chaiAsPromised);
const expect = chai.expect;

describe("notes + tags syncing", async function() {
  const sharedApplication = Factory.createApplication();
  before(async function() {
    await Factory.initializeApplication(sharedApplication);
  });

  let totalItemCount = 0;

  beforeEach(async function() {
    this.application = await Factory.createInitAppWithRandNamespace();
    const email = SFItem.GenerateUuidSynchronously();
    const password = SFItem.GenerateUuidSynchronously();
    await Factory.registerUserToApplication({application: this.application, email, password});
  })

  it('syncing an item then downloading it should include items_key_id', async function() {
    const note = await Factory.createMappedNote(this.application.modelManager);
    note.setDirty(true);
    await this.application.syncManager.sync();
    await this.application.modelManager.handleSignOut();
    await this.application.syncManager.clearSyncPositionTokens();
    await this.application.syncManager.sync();
    const downloadedNote = this.application.modelManager.notes[0];
    expect(downloadedNote.items_key_id).to.be.ok;
  });

  it('syncing a note many times does not cause duplication', async function() {
    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    this.application.modelManager.mapPayloadsToLocalItems({payloads: [notePayload, tagPayload]});
    const note = this.application.modelManager.allItemsMatchingTypes(["Note"])[0];
    const tag = this.application.modelManager.allItemsMatchingTypes(["Tag"])[0];
    expect(this.application.modelManager.notes.length).to.equal(1);
    expect(this.application.modelManager.tags.length).to.equal(1);

    for(let i = 0; i < 9; i++) {
      note.setDirty(true);
      tag.setDirty(true);
      await this.application.syncManager.sync();
      this.application.syncManager.clearSyncPositionTokens();
      expect(tag.content.references.length).to.equal(1);
      expect(note.tags.length).to.equal(1);
      expect(tag.notes.length).to.equal(1);
      expect(this.application.modelManager.notes.length).to.equal(1);
      expect(this.application.modelManager.tags.length).to.equal(1);
      console.log("Waiting 0.1s...");
      await Factory.sleep(0.1);
    }
  }).timeout(20000);

  it("handles signing in and merging data", async function() {
    let pair = Factory.createRelatedNoteTagPairPayload();
    let notePayload = pair[0];
    let tagPayload = pair[1];

    this.application.modelManager.mapPayloadsToLocalItems({payloads: [notePayload, tagPayload]});
    let originalNote = this.application.modelManager.allItemsMatchingTypes(["Note"])[0];
    let originalTag = this.application.modelManager.allItemsMatchingTypes(["Tag"])[0];
    originalNote.setDirty(true);
    originalTag.setDirty(true);

    await this.application.syncManager.sync();

    expect(originalTag.content.references.length).to.equal(1);
    expect(originalTag.notes.length).to.equal(1);
    expect(originalNote.tags.length).to.equal(1);

    // when signing in, all local items are cleared from storage (but kept in memory; to clear desktop logs),
    // then resaved with alternated uuids.
    await this.application.storageManager.clearAllPayloads();
    await this.application.syncManager.markAllItemsDirtyAndSaveOffline(true)

    let note = this.application.modelManager.allItemsMatchingTypes(["Note"])[0];
    let tag = this.application.modelManager.allItemsMatchingTypes(["Tag"])[0];

    expect(this.application.modelManager.notes.length).to.equal(1);
    expect(this.application.modelManager.tags.length).to.equal(1);

    expect(note.uuid).to.not.equal(originalNote.uuid);
    expect(tag.uuid).to.not.equal(originalTag.uuid);

    expect(tag.content.references.length).to.equal(1);
    expect(note.content.references.length).to.equal(0);

    expect(note.referencingItemsCount).to.equal(1);
    expect(tag.notes.length).to.equal(1);
    expect(note.tags.length).to.equal(1);
  })

  it('duplicating a tag should maintian its relationships', async function() {
    await this.application.syncManager.loadDataFromDatabase();
    let pair = Factory.createRelatedNoteTagPairPayload();
    let notePayload = pair[0];
    let tagPayload = pair[1];

    this.application.modelManager.mapPayloadsToLocalItems({payloads: [notePayload, tagPayload]});
    let note = this.application.modelManager.allItemsMatchingTypes(["Note"])[0];
    let tag = this.application.modelManager.allItemsMatchingTypes(["Tag"])[0];

    note.setDirty(true);
    tag.setDirty(true);

    await this.application.syncManager.sync();
    await this.application.syncManager.clearSyncPositionTokens();

    expect(this.application.modelManager.notes.length).to.equal(1);
    expect(this.application.modelManager.tags.length).to.equal(1);

    tag.title = `${Math.random()}`
    tag.updated_at = Factory.yesterday();
    tag.setDirty(true);

    expect(note.referencingItemsCount).to.equal(1);

    // wait about 1s, which is the value the dev server will ignore conflicting changes
    await Factory.sleep(1.1);
    await this.application.syncManager.sync();

    // tag should now be conflicted and a copy created
    expect(this.application.modelManager.notes.length).to.equal(1);
    expect(this.application.modelManager.tags.length).to.equal(2);
    var tags = this.application.modelManager.allItemsMatchingTypes(["Tag"]);
    var tag1 = tags[0];
    var tag2 = tags[1];

    expect(tag1.uuid).to.not.equal(tag2.uuid);

    expect(tag1.uuid).to.equal(tag.uuid);
    expect(tag2.content.conflict_of).to.equal(tag1.uuid);
    expect(tag1.notes.length).to.equal(tag2.notes.length);
    expect(tag1.referencingItemsCount).to.equal(0);
    expect(tag2.referencingItemsCount).to.equal(0);

    // Two tags now link to this note
    expect(note.referencingItemsCount).to.equal(2);
    expect(note.allReferencingItems[0]).to.not.equal(note.allReferencingItems[1]);
  }).timeout(10000);
})