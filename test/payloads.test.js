/* eslint-disable no-unused-expressions */
/* eslint-disable no-undef */
import * as Factory from './lib/factory.js';
chai.use(chaiAsPromised);
const expect = chai.expect;

describe('payload generation', () => {
  it('generates payload', async () => {
    const payload = CreateMaxPayloadFromAnyObject(
      {
        uuid: 'foo',
        content: {
          title: 'All notes',
          isSystemTag: true,
          isAllTag: true,
          predicate: SNPredicate.FromArray(['content_type', '=', ContentTypes.Note])
        }
      }
    );
    expect(payload).to.be.ok;
  });
});

describe('payloads', () => {
  const sharedApplication = Factory.createApplication();

  before(async () => {
    localStorage.clear();
    await Factory.initializeApplication(sharedApplication);
    await Factory.registerUserToApplication({application: sharedApplication});
  });

  after(async () => {
    sharedApplication.deinit();
    localStorage.clear();
  });

  it('creating payload from item should create copy not by reference', async () => {
    const item = await Factory.createMappedNote(sharedApplication);
    const payload = CreateMaxPayloadFromAnyObject(item);
    expect(item.content === payload.content).to.equal(false);
    expect(item.content.references === payload.content.references).to.equal(false);
  });

  it('creating payload from item should preserve appData', async () => {
    const item = await Factory.createMappedNote(sharedApplication);
    const payload = CreateMaxPayloadFromAnyObject(item);
    expect(item.content.appData).to.be.ok;
    expect(JSON.stringify(item.content)).to.equal(JSON.stringify(payload.content));
  });

  it('server payloads should not contain client values', async function() {
    const rawPayload = Factory.createNotePayload();
    const notePayload = CreateMaxPayloadFromAnyObject(
      rawPayload,
      null,
      null,
      {
        dirty: true,
        lastSyncBegan: new Date(),
        waitingForKey: false,
        dummy: true,
        errorDecrypting: false
      }
    );

    const encryptedPayload = await sharedApplication.protocolService.payloadByEncryptingPayload(
      notePayload,
      EncryptionIntents.Sync
    );

    expect(encryptedPayload.dirty).to.not.be.ok;
    expect(encryptedPayload.errorDecrypting).to.not.be.ok;
    expect(encryptedPayload.errorDecryptingValueChanged).to.not.be.ok;
    expect(encryptedPayload.waitingForKey).to.not.be.ok;
    expect(encryptedPayload.lastSyncBegan).to.not.be.ok;
    expect(encryptedPayload.dummy).to.not.be.ok;
  });

  it('creating payload with override properties', async () => {
    const payload = Factory.createNotePayload();
    const uuid = payload.uuid;
    const changedUuid = 'foo';
    const changedPayload = CreateMaxPayloadFromAnyObject(
      payload,
      null,
      null,
      {
        uuid: changedUuid
      }
    );

    expect(payload.uuid).to.equal(uuid);
    expect(changedPayload.uuid).to.equal(changedUuid);
  });

  it('creating payload with deep override properties', async () => {
    const payload = Factory.createNotePayload();
    const text = payload.content.text;
    const changedText = `${Math.random()}`;
    const changedPayload = CreateMaxPayloadFromAnyObject(
      payload,
      null,
      null,
      {
        content: {
          text: changedText
        }
      }
    );

    expect(payload.content === changedPayload.content).to.equal(false);
    expect(payload.content.text).to.equal(text);
    expect(changedPayload.content.text).to.equal(changedText);
  });

  it('copying payload with override should override selected fields only', async () => {
    const item = await Factory.createMappedNote(sharedApplication);
    const payload = CreateMaxPayloadFromAnyObject(item);
    const mutated = CreateMaxPayloadFromAnyObject(
      payload,
      null,
      null,
      {
        content: {
          foo: 'bar'
        }
      }
    );
    expect(mutated.content.text).to.equal(payload.content.text);
  });

  it('copying payload with override should copy empty arrays', async () => {
    const pair = await Factory.createRelatedNoteTagPairPayload(sharedApplication.modelManager);
    const tagPayload = pair[1];
    expect(tagPayload.content.references.length).to.equal(1);

    const mutated = CreateMaxPayloadFromAnyObject(
      tagPayload,
      null,
      null,
      {
        content: {
          references: []
        }
      }
    );
    expect(mutated.content.references.length).to.equal(0);
  });

  it('creating payload with omit fields', async () => {
    const payload = Factory.createNotePayload();
    const uuid = payload.uuid;
    const changedPayload = CreateMaxPayloadFromAnyObject(
      payload,
      null,
      null,
      {uuid: null}
    );

    expect(payload.uuid).to.equal(uuid);
    expect(changedPayload.uuid).to.not.be.ok;
  });

  it('returns valid encrypted params for syncing', async () => {
    const payload = Factory.createNotePayload();
    const encryptedPayload = await sharedApplication.protocolService
    .payloadByEncryptingPayload(
      payload,
      EncryptionIntents.Sync
    );
    expect(encryptedPayload.enc_item_key).to.not.be.null;
    expect(encryptedPayload.uuid).to.not.be.null;
    expect(encryptedPayload.auth_hash).to.not.be.ok;
    expect(encryptedPayload.content_type).to.not.be.null;
    expect(encryptedPayload.created_at).to.not.be.null;
    expect(encryptedPayload.content).to.satisfy((string) => {
      return string.startsWith(sharedApplication.protocolService.getLatestVersion());
    });
  }).timeout(5000);

  it('returns unencrypted params with no keys', async () => {
    const payload = Factory.createNotePayload();
    const encodedPayload = await sharedApplication.protocolService
    .payloadByEncryptingPayload(
      payload,
      EncryptionIntents.FileDecrypted
    );

    expect(encodedPayload.enc_item_key).to.not.be.ok;
    expect(encodedPayload.auth_hash).to.not.be.ok;
    expect(encodedPayload.uuid).to.not.be.null;
    expect(encodedPayload.content_type).to.not.be.null;
    expect(encodedPayload.created_at).to.not.be.null;
    /** File decrypted will result in bare object */
    expect(encodedPayload.content.title).to.equal(payload.content.title);
  });

  it('returns additional fields for local storage', async () => {
    const payload = Factory.createNotePayload();

    const encryptedPayload = await sharedApplication.protocolService
    .payloadByEncryptingPayload(
      payload,
      EncryptionIntents.LocalStorageEncrypted
    );

    expect(encryptedPayload.enc_item_key).to.not.be.null;
    expect(encryptedPayload.auth_hash).to.not.be.ok;
    expect(encryptedPayload.uuid).to.not.be.null;
    expect(encryptedPayload.content_type).to.not.be.null;
    expect(encryptedPayload.created_at).to.not.be.null;
    expect(encryptedPayload.updated_at).to.not.be.null;
    expect(encryptedPayload.deleted).to.not.be.null;
    expect(encryptedPayload.errorDecrypting).to.not.be.null;
    expect(encryptedPayload.content).to.satisfy((string) => {
      return string.startsWith(sharedApplication.protocolService.getLatestVersion());
    });
  });

  it('omits deleted for export file', async () => {
    const payload = Factory.createNotePayload();
    const encryptedPayload = await sharedApplication.protocolService
    .payloadByEncryptingPayload(
      payload,
      EncryptionIntents.FileEncrypted
    );
    expect(encryptedPayload.enc_item_key).to.not.be.null;
    expect(encryptedPayload.uuid).to.not.be.null;
    expect(encryptedPayload.content_type).to.not.be.null;
    expect(encryptedPayload.created_at).to.not.be.null;
    expect(encryptedPayload.deleted).to.not.be.ok;
    expect(encryptedPayload.content).to.satisfy((string) => {
      return string.startsWith(sharedApplication.protocolService.getLatestVersion());
    });
  });

  it('items with error decrypting should remain as is', async () => {
    const payload = Factory.createNotePayload();
    const mutatedPayload = CreateMaxPayloadFromAnyObject(
      payload,
      null,
      null,
      {
        errorDecrypting: true
      }
    );
    const encryptedPayload = await sharedApplication.protocolService
    .payloadByEncryptingPayload(
      mutatedPayload,
      EncryptionIntents.Sync
    );
    expect(encryptedPayload.content).to.eql(payload.content);
    expect(encryptedPayload.enc_item_key).to.not.be.null;
    expect(encryptedPayload.uuid).to.not.be.null;
    expect(encryptedPayload.content_type).to.not.be.null;
    expect(encryptedPayload.created_at).to.not.be.null;
  });
});
