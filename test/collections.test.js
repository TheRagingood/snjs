/* eslint-disable no-unused-expressions */
/* eslint-disable no-undef */
import * as Factory from './lib/factory.js';
chai.use(chaiAsPromised);
const expect = chai.expect;

describe('payload collections', () => {
  const sharedApplication = Factory.createApplication();

  before(async () => {
    localStorage.clear();
    await Factory.initializeApplication(sharedApplication);
  });

  after(async () => {
    localStorage.clear();
    sharedApplication.deinit();
  });

  it('find', async () => {
    const payload = Factory.createNotePayload();
    const collection = new PayloadCollection(
      [payload]
    );
    expect(collection.findPayload(payload.uuid)).to.be.ok;
  });

  it('references', async () => {
    const payloads = Factory.createRelatedNoteTagPairPayload();
    const notePayload = payloads[0];
    const tagPayload = payloads[1];
    const collection = new PayloadCollection(
      [notePayload, tagPayload]
    );
    const referencing = collection.payloadsThatReferencePayload(notePayload);
    expect(referencing.length).to.equal(1);
  });

  it('master collection', async () => {
    const note = await Factory.createMappedNote(sharedApplication);
    const masterCollection = sharedApplication.modelManager.getMasterCollection();
    const result = masterCollection.findPayload(note.uuid);
    expect(result.uuid).to.equal(note.uuid);
  });
});
