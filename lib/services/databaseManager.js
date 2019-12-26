export class SNDatabaseManager {

  async getAllModels() {
    throw 'Must override';
  }

  async saveModel(item) {
    return this.saveModels([item]);
  }

  async saveModels(items) {
    throw 'Must override';
  }

  async deleteModel(item) {
    throw 'Must override';
  }

  async clearAllModels() {
    throw 'Must override';
  }
}