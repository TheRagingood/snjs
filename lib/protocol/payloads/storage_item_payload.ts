import { SNPureItemPayload } from '@Payloads/pure_item_payload';
import { PayloadFields } from '@Payloads/fields';

export class SNStorageItemPayload extends SNPureItemPayload {
  static fields() {
    return [
      PayloadFields.Uuid,
      PayloadFields.ContentType,
      PayloadFields.ItemsKeyId,
      PayloadFields.EncItemKey,
      PayloadFields.Content,
      PayloadFields.CreatedAt,
      PayloadFields.UpdatedAt,
      PayloadFields.Deleted,
      PayloadFields.Legacy003AuthHash,
      PayloadFields.Legacy003AuthParams,
      PayloadFields.Dirty,
      PayloadFields.DirtiedDate,
      PayloadFields.ErrorDecrypting,
      PayloadFields.WaitingForKey
    ];
  }
}