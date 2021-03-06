import { ContentType } from '@Models/content_types';
import {
  PayloadSources,
  PurePayload,
} from '@Payloads/index';
import { EncryptionIntent } from '@Protocol/intents';
import {
  Copy,
  deepMerge,
  isNullOrUndefined,
  isObject,
  deepFreeze,
  pickByCopy,
} from '@Lib/utils';
import { PayloadField } from '@Payloads/fields';

export type ContentReference = {
  uuid: string
  content_type: string
}

export type PayloadContent = {
  [key: string]: any
  references: ContentReference[]
}

export type PayloadOverride = {
  [key in PayloadField]?: any;
} | PurePayload

export type RawPayload = {
  uuid?: string
  content_type?: ContentType
  content?: PayloadContent | string
  deleted?: boolean
  items_key_id?: string
  enc_item_key?: string
  created_at?: Date
  updated_at?: Date
  dirtiedDate?: Date
  dirty?: boolean
  dummy?: boolean
  errorDecrypting?: boolean
  waitingForKey?: boolean
  errorDecryptingValueChanged?: boolean
  lastSyncBegan?: Date
  lastSyncEnd?: Date
  auth_hash?: string
  auth_params?: any
}

/** The MaxItemPayload represents a payload with all possible fields */
const MaxPayloadFields = [
  PayloadField.Uuid,
  PayloadField.ContentType,
  PayloadField.ItemsKeyId,
  PayloadField.EncItemKey,
  PayloadField.Content,
  PayloadField.CreatedAt,
  PayloadField.UpdatedAt,
  PayloadField.Deleted,
  PayloadField.Legacy003AuthHash,
  PayloadField.Legacy003AuthParams,
  PayloadField.Dirty,
  PayloadField.DirtiedDate,
  PayloadField.ErrorDecrypting,
  PayloadField.ErrorDecryptingChanged,
  PayloadField.WaitingForKey,
  PayloadField.Dummy,
  PayloadField.LastSyncBegan,
  PayloadField.LastSyncEnd,
]

const EncryptionParametersFields = [
  PayloadField.Uuid,
  PayloadField.ItemsKeyId,
  PayloadField.EncItemKey,
  PayloadField.Content,
  PayloadField.Legacy003AuthHash,
  PayloadField.ErrorDecrypting,
  PayloadField.ErrorDecryptingChanged,
  PayloadField.WaitingForKey
];

const FilePayloadFields = [
  PayloadField.Uuid,
  PayloadField.ContentType,
  PayloadField.ItemsKeyId,
  PayloadField.EncItemKey,
  PayloadField.Content,
  PayloadField.CreatedAt,
  PayloadField.UpdatedAt,
  PayloadField.Legacy003AuthHash
]

const StoragePayloadFields = [
  PayloadField.Uuid,
  PayloadField.ContentType,
  PayloadField.ItemsKeyId,
  PayloadField.EncItemKey,
  PayloadField.Content,
  PayloadField.CreatedAt,
  PayloadField.UpdatedAt,
  PayloadField.Deleted,
  PayloadField.Legacy003AuthHash,
  PayloadField.Legacy003AuthParams,
  PayloadField.Dirty,
  PayloadField.DirtiedDate,
  PayloadField.ErrorDecrypting,
  PayloadField.WaitingForKey
]

const ServerPayloadFields = [
  PayloadField.Uuid,
  PayloadField.ContentType,
  PayloadField.ItemsKeyId,
  PayloadField.EncItemKey,
  PayloadField.Content,
  PayloadField.CreatedAt,
  PayloadField.UpdatedAt,
  PayloadField.Deleted,
  PayloadField.Legacy003AuthHash
]

const SessionHistoryPayloadFields = [
  PayloadField.Uuid,
  PayloadField.ContentType,
  PayloadField.Content,
  PayloadField.UpdatedAt,
]

/** Represents a payload with permissible fields for when a
 * payload is retrieved from a component for saving */
const ComponentRetrievedPayloadFields = [
  PayloadField.Uuid,
  PayloadField.Content,
  PayloadField.CreatedAt
]

/**
 * The saved server item payload represents the payload we want to map
 * when mapping saved_items from the server. We only want to map the
 * updated_at value the server returns for the item, and basically
 * nothing else.
 */
const ServerSavedPayloadFields = [
  PayloadField.Uuid,
  PayloadField.ContentType,
  PayloadField.UpdatedAt,
  PayloadField.Deleted,
  PayloadField.Dirty,
  PayloadField.LastSyncEnd
]

export function CreateMaxPayloadFromAnyObject(
  object: object,
  source?: PayloadSources,
  intent?: EncryptionIntent,
  override?: PayloadOverride
) {
  if (!isNullOrUndefined(source as any)) {
    throw 'Use CreateSourcedPayloadFromObject if creating payload with source.';
  }
  if (!isNullOrUndefined(intent as any)) {
    throw 'Use CreateIntentPayloadFromObject if creating payload with intent.';
  }
  return CreatePayload(
    object,
    MaxPayloadFields.slice(),
    override
  );
}

export function CreateIntentPayloadFromObject(
  object: any,
  intent: EncryptionIntent,
  override?: PayloadOverride
) {
  const payloadFields = payloadFieldsForIntent(intent);
  return CreatePayload(
    object,
    payloadFields,
    override
  );
}

export function CreateSourcedPayloadFromObject(
  object: object,
  source: PayloadSources,
  override?: PayloadOverride
) {
  const payloadFields = payloadFieldsForSource(source);
  return CreatePayload(
    object,
    payloadFields,
    override
  );
}

function CreatePayload(
  object: object,
  fields: PayloadField[],
  override?: PayloadOverride
): PurePayload {
  const rawPayload = pickByCopy(object, fields);
  if (override) {
    if (!isObject(override)) {
      throw 'Attempting to override payload with non-object';
    }
    deepMerge(rawPayload, Copy(override));
  }
  return new PurePayload(rawPayload, fields.slice());
}

export function CopyPayload(
  payload: PurePayload,
  override?: PayloadOverride
): PurePayload {
  const rawPayload = pickByCopy(payload, payload.fields);
  if (override) {
    deepMerge(rawPayload, Copy(override));
  }
  return new PurePayload(rawPayload, payload.fields.slice());
}

export function CreateEncryptionParameters(raw: RawPayload | PurePayload): PurePayload {
  return CreatePayload(
    raw,
    EncryptionParametersFields.slice(),
  );
}

export function CopyEncryptionParameters(
  raw: RawPayload | PurePayload,
  override?: PayloadOverride
): PurePayload {
  return CreatePayload(
    raw,
    EncryptionParametersFields.slice(),
    override
  );
}

function payloadFieldsForIntent(intent: EncryptionIntent) {
  if ((
    intent === EncryptionIntent.FileEncrypted ||
    intent === EncryptionIntent.FileDecrypted ||
    intent === EncryptionIntent.FilePreferEncrypted
  )) {
    return FilePayloadFields.slice();
  }

  if ((
    intent === EncryptionIntent.LocalStoragePreferEncrypted ||
    intent === EncryptionIntent.LocalStorageDecrypted ||
    intent === EncryptionIntent.LocalStorageEncrypted
  )) {
    return StoragePayloadFields.slice();
  }

  if ((
    intent === EncryptionIntent.Sync ||
    intent === EncryptionIntent.SyncDecrypted
  )) {
    return ServerPayloadFields.slice();
  } else {
    throw `No payload fields found for intent ${intent}`;
  }
}

export function payloadFieldsForSource(source: PayloadSources) {
  if (source === PayloadSources.FileImport) {
    return FilePayloadFields.slice();
  }

  if (source === PayloadSources.SessionHistory) {
    return SessionHistoryPayloadFields.slice();
  }

  if (source === PayloadSources.ComponentRetrieved) {
    return ComponentRetrievedPayloadFields.slice();
  }

  if ((
    source === PayloadSources.LocalRetrieved ||
    source === PayloadSources.LocalDirtied
  )) {
    return StoragePayloadFields.slice();
  }

  if ((
    source === PayloadSources.RemoteRetrieved ||
    source === PayloadSources.ConflictData ||
    source === PayloadSources.ConflictUuid
  )) {
    return ServerPayloadFields.slice();
  }
  if ((
    source === PayloadSources.LocalSaved ||
    source === PayloadSources.RemoteSaved
  )) {
    return ServerSavedPayloadFields.slice();
  } else {
    throw `No payload fields found for source ${source}`;
  }
}
