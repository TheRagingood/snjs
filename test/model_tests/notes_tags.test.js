/* eslint-disable no-unused-expressions */
/* eslint-disable no-undef */
import * as Factory from '../lib/factory.js';
chai.use(chaiAsPromised);
const expect = chai.expect;

describe('notes and tags', () => {
  const BASE_ITEM_COUNT = 1; /** Default items key */
  beforeEach(async function () {
    this.expectedItemCount = BASE_ITEM_COUNT;
    this.application = await Factory.createInitAppWithRandNamespace();
  });

  afterEach(async function () {
    await this.application.deinit();
  });

  it('uses proper class for note', async function () {
    const modelManager = this.application.modelManager;
    const payload = Factory.createNotePayload();
    await modelManager.mapPayloadToLocalItem(
      payload,
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    expect(note.constructor === SNNote).to.equal(true);
  });

  it('properly constructs syncing params', async function () {
    const note = await this.application.createTemplateItem(ContentTypes.Note);
    const title = 'Foo';
    const text = 'Bar';
    note.title = title;
    note.text = text;

    const content = note.collapseContent();
    expect(content.title).to.equal(title);
    expect(content.text).to.equal(text);

    const tag = await this.application.createTemplateItem(ContentTypes.Tag);
    tag.title = title;

    expect(tag.collapseContent().title).to.equal(title);

    expect(tag.structureParams().title).to.equal(tag.getContentCopy().title);
  });

  it('properly handles legacy relationships', async function () {
    // legacy relationships are when a note has a reference to a tag
    const modelManager = this.application.modelManager;
    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    const mutatedTag = CreateMaxPayloadFromAnyObject(
      tagPayload,
      null,
      null,
      { content: { references: null } }
    );
    const mutatedNote = CreateMaxPayloadFromAnyObject(
      notePayload,
      null,
      null,
      {
        content: {
          references: [
            {
              uuid: tagPayload.uuid,
              content_type: tagPayload.content_type
            }
          ]
        }
      }
    );

    await modelManager.mapPayloadsToLocalItems(
      [mutatedNote, mutatedTag],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];

    expect(note.tags.length).to.equal(1);
    expect(tag.notes.length).to.equal(1);
  });

  it('creates relationship between note and tag', async function () {
    const modelManager = this.application.modelManager;
    const pair = Factory.createRelatedNoteTagPairPayload({ dirty: false });
    const notePayload = pair[0];
    const tagPayload = pair[1];

    expect(notePayload.content.references.length).to.equal(0);
    expect(tagPayload.content.references.length).to.equal(1);

    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.notes[0];
    const tag = modelManager.tags[0];

    expect(note.dirty).to.not.be.ok;
    expect(tag.dirty).to.not.be.ok;

    expect(note.content.references.length).to.equal(0);
    expect(tag.content.references.length).to.equal(1);

    expect(note.hasRelationshipWithItem(tag)).to.equal(false);
    expect(tag.hasRelationshipWithItem(note)).to.equal(true);

    expect(note.allReferencingItems.length).to.equal(1);
    expect(note.tags.length).to.equal(1);
    expect(tag.notes.length).to.equal(1);

    await modelManager.setItemToBeDeleted(note);
    expect(note.dirty).to.be.true;
    expect(tag.dirty).to.be.true;
    await this.application.syncService.sync();
    expect(tag.content.references.length).to.equal(0);
    expect(note.tags.length).to.equal(0);
    expect(tag.notes.length).to.equal(0);

    expect(note.dirty).to.be.false;
    expect(tag.dirty).to.be.false;
  });

  it('handles remote deletion of relationship', async function () {
    const modelManager = this.application.modelManager;

    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];

    expect(note.content.references.length).to.equal(0);
    expect(tag.content.references.length).to.equal(1);

    await this.application.syncService.sync();

    const mutatedTag = CreateMaxPayloadFromAnyObject(
      tagPayload,
      null,
      null,
      { content: { references: [] } }
    );
    await modelManager.mapPayloadsToLocalItems(
      [mutatedTag],
      PayloadSources.LocalChanged
    );

    expect(tag.content.references.length).to.equal(0);
    expect(note.tags.length).to.equal(0);
    expect(tag.notes.length).to.equal(0);

    // expect to be false
    expect(note.dirty).to.not.be.ok;
    expect(tag.dirty).to.not.be.ok;
  });

  it('resets cached note tags string when tag is deleted from remote source', async function () {
    const modelManager = this.application.modelManager;

    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];

    expect(note.tagsString().length).to.not.equal(0);

    const changedTagPayload = CreateMaxPayloadFromAnyObject(
      tagPayload,
      null,
      null,
      {
        deleted: true
      }
    );
    await modelManager.mapPayloadsToLocalItems(
      [changedTagPayload],
      PayloadSources.LocalChanged
    );

    expect(modelManager.tags.length).to.equal(0);

    // Should be null
    expect(note.savedTagsString).to.not.be.ok;

    expect(note.referencedItemsCount).to.equal(0);
    expect(note.referencingItemsCount).to.equal(0);

    expect(note.tags.length).to.equal(0);
    expect(tag.notes.length).to.equal(0);
  });

  it('resets cached note tags string when tag reference is removed from remote source', async function () {
    const modelManager = this.application.modelManager;

    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];
    expect(tag.title).to.be.ok;

    expect(note.tagsString().length).to.not.equal(0);

    const mutatedTag = CreateMaxPayloadFromAnyObject(
      tagPayload,
      null,
      null,
      { content: { references: [] } }
    );
    await modelManager.mapPayloadsToLocalItems(
      [mutatedTag],
      PayloadSources.LocalChanged
    );

    // should be null
    expect(note.savedTagsString).to.not.be.ok;

    expect(note.tags.length).to.equal(0);
    expect(tag.notes.length).to.equal(0);
  });

  it('creating basic note should have text set', async function () {
    const note = await Factory.createMappedNote(this.application);
    expect(note.title).to.be.ok;
    expect(note.text).to.be.ok;
  });

  it('creating basic tag should have title', async function () {
    const tag = await Factory.createMappedTag(this.application);
    expect(tag.title).to.be.ok;
  });

  it('resets cached note tags string when tag is renamed', async function () {
    const modelManager = this.application.modelManager;

    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];
    expect(note.title).to.be.ok;
    expect(tag.title).to.be.ok;
    expect(note.tagsString()).to.equal(`#${tagPayload.content.title}`);

    const newTitle = `${Math.random()}`;
    // Saving involves modifying local state first, then syncing with omitting content.
    tag.title = newTitle;
    await modelManager.setItemDirty(tag);

    expect(tag.content.title).to.equal(newTitle);

    const changedTagPayload = CreateSourcedPayloadFromObject(
      tagPayload,
      PayloadSources.RemoteSaved
    );

    // simulate a save, which omits `content`
    await modelManager.mapPayloadsToLocalItems(
      [changedTagPayload],
      PayloadSources.LocalChanged
    );

    expect(tag.content.title).to.equal(newTitle);
    expect(note.savedTagsString).to.not.be.ok;
    expect(note.tagsString()).to.equal(`#${newTitle}`);
  });

  it('handles removing relationship between note and tag', async function () {
    const modelManager = this.application.modelManager;

    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];

    expect(note.content.references.length).to.equal(0);
    expect(tag.content.references.length).to.equal(1);

    tag.removeItemAsRelationship(note);

    const newTagPayload = CreateMaxPayloadFromAnyObject(tag);

    await modelManager.mapPayloadsToLocalItems(
      [newTagPayload],
      PayloadSources.LocalChanged
    );

    expect(note.tags.length).to.equal(0);
    expect(tag.notes.length).to.equal(0);
  });

  it('properly handles tag duplication', async function () {
    const modelManager = this.application.modelManager;
    const pair = Factory.createRelatedNoteTagPairPayload();
    await modelManager.mapPayloadsToLocalItems(
      pair,
      PayloadSources.LocalChanged
    );
    const note = modelManager.notes[0];
    const tag = modelManager.tags[0];

    const duplicateTag = await modelManager.duplicateItem(tag, true);

    await this.application.syncService.sync();
    expect(tag.uuid).to.not.equal(duplicateTag.uuid);
    expect(tag.content.references.length).to.equal(1);
    expect(tag.notes.length).to.equal(1);
    expect(duplicateTag.content.references.length).to.equal(1);
    expect(duplicateTag.notes.length).to.equal(1);
    expect(note.tags.length).to.equal(2);

    const noteTag1 = note.tags[0];
    const noteTag2 = note.tags[1];
    expect(noteTag1.uuid).to.not.equal(noteTag2.uuid);

    // expect to be false
    expect(note.dirty).to.not.be.ok;
    expect(tag.dirty).to.not.be.ok;
  });

  it('duplicating a note should maintain its tag references', async function () {
    const modelManager = this.application.modelManager;
    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];
    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const duplicateNote = await modelManager.duplicateItem(note, true);
    expect(note.uuid).to.not.equal(duplicateNote.uuid);
    expect(duplicateNote.tags.length).to.equal(note.tags.length);
  });

  it('deleting a note should update tag references', async function () {
    const modelManager = this.application.modelManager;

    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];

    expect(tag.content.references.length).to.equal(1);
    expect(tag.notes.length).to.equal(1);

    expect(note.content.references.length).to.equal(0);
    expect(note.tags.length).to.equal(1);

    await modelManager.setItemToBeDeleted(tag);
    const newTagPayload = CreateMaxPayloadFromAnyObject(tag);
    await modelManager.mapPayloadsToLocalItems(
      [newTagPayload],
      PayloadSources.LocalChanged
    );
    expect(tag.content.references.length).to.equal(0);
    expect(tag.notes.length).to.equal(0);
  });

  it('modifying item content should not modify payload content', async function () {
    const modelManager = this.application.modelManager;
    const notePayload = Factory.createNotePayload();
    await modelManager.mapPayloadsToLocalItems(
      [notePayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    expect(note.content === notePayload.content).to.equal(false);
    /** Items transfer payload values on update, so these should be equal */
    expect(note.content.references === notePayload.content.references).to.equal(false);
    note.content.title = Math.random();
    expect(note.content.title).to.not.equal(notePayload.content.title);
  });

  it('deleting a tag from a note with bi-directional relationship', async function () {
    // Tags now reference notes, but it used to be that tags referenced notes and notes referenced tags.
    // After the change, there was an issue where removing an old tag relationship from a note would only
    // remove one way, and thus keep it intact on the visual level.

    const modelManager = this.application.modelManager;

    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    const mutatedPayload = CreateMaxPayloadFromAnyObject(
      notePayload,
      null,
      null,
      {
        content: {
          references: [{
            content_type: tagPayload.content_type,
            uuid: tagPayload.uuid
          }]
        }
      }
    );

    await modelManager.mapPayloadsToLocalItems(
      [mutatedPayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];

    expect(tag.notes.length).to.equal(1);
    expect(note.tags.length).to.equal(1);

    tag.removeItemAsRelationship(note);

    expect(tag.notes.length).to.equal(0);
    expect(note.tags.length).to.equal(0);

    expect(note.content.references.length).to.equal(0);
    expect(tag.content.references.length).to.equal(0);
  });

  it('deleting a tag should not dirty notes', async function () {
    // Tags now reference notes, but it used to be that tags referenced notes and notes referenced tags.
    // After the change, there was an issue where removing an old tag relationship from a note would only
    // remove one way, and thus keep it intact on the visual level.

    const modelManager = this.application.modelManager;

    const pair = Factory.createRelatedNoteTagPairPayload();
    const notePayload = pair[0];
    const tagPayload = pair[1];

    await modelManager.mapPayloadsToLocalItems(
      [notePayload, tagPayload],
      PayloadSources.LocalChanged
    );
    const note = modelManager.getItems(['Note'])[0];
    const tag = modelManager.getItems(['Tag'])[0];

    await this.application.syncService.sync();

    await modelManager.setItemToBeDeleted(tag);

    expect(tag.dirty).to.equal(true);
    expect(note.dirty).to.not.be.ok;
  });

  it('setting a note dirty should collapse its properties into content', async function () {
    const modelManager = this.application.modelManager;
    const note = await this.application.createTemplateItem(ContentTypes.Note);
    note.title = 'Foo';
    expect(note.content.title).to.not.be.ok;
    await modelManager.setItemDirty(note);
    expect(note.content.title).to.equal('Foo');
  });
});
