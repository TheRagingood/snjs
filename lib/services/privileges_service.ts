import { SNSessionManager } from './api/session_manager';
import { SNStorageService } from '@Services/storage_service';
import { SNProtocolService } from './protocol_service';
import { SNSingletonManager } from './singleton_manager';
import { SNSyncService } from './sync/sync_service';
import { SNModelManager } from './model_manager';
import { PureService } from '@Lib/services/pure_service';
import { SNPredicate } from '@Models/core/predicate';
import { StorageKeys } from '@Lib/storage_keys';
import { CreateMaxPayloadFromAnyObject } from '@Payloads/generator';
import { ContentTypes } from '@Root/lib/models';
import { ProtectedActions, PrivilegeCredentials, SNPrivileges } from '@Models/app/privileges';

export enum PrivilegeSessionLength {
  None = 0,
  FiveMinutes = 300,
  OneHour = 3600,
  OneWeek = 604800,
}

type CredentialAuthMapping = Partial<Record<PrivilegeCredentials, string>>

const CredentialsMetadata = {
  [PrivilegeCredentials.AccountPassword] : {
    label: 'Account Password',
    prompt: 'Please enter your account password.'
  },
  [PrivilegeCredentials.LocalPasscode] : {
    label: 'Local Passcode',
    prompt: 'Please enter your local passcode.'
  }
};

const ActionsMetadata = {
  [ProtectedActions.ManageExtensions]: {
    label: 'Manage Extensions'
  },
  [ProtectedActions.ManageBackups]: {
    label: 'Download/Import Backups'
  },
  [ProtectedActions.ViewProtectedNotes]: {
    label: 'View Protected Notes'
  },
  [ProtectedActions.ManagePrivileges]: {
    label: 'Manage Privileges'
  },
  [ProtectedActions.ManagePasscode]: {
    label: 'Manage Passcode'
  },
  [ProtectedActions.DeleteNote]: {
    label: 'Delete Notes'
  },
};

/** 
 * Privileges allows certain actions within the application to require extra authentication.
 * For example, the privileges service exposes functions that allow the action of deleting
 * a note or viewing a note to require extra authentication.
 * Privileges are a superficial-level locking feature; they do not deal at all with underlying
 * data state. For example, viewing a protected note may require extra authentication,
 * but the underlying note data may already be decrypted in application memory, whether or not
 * the user has yet authenticated this action.
 */
export class SNPrivilegesService extends PureService {
  private modelManager?: SNModelManager
  private syncService?: SNSyncService
  private singletonManager?: SNSingletonManager
  private protocolService?: SNProtocolService
  private storageService?: SNStorageService
  private sessionManager?: SNSessionManager

  private availableActions: ProtectedActions[] = []
  private availableCredentials: PrivilegeCredentials[] = []
  private sessionLengths: PrivilegeSessionLength[] = []

  constructor(
    modelManager: SNModelManager,
    syncService: SNSyncService,
    singletonManager: SNSingletonManager,
    protocolService: SNProtocolService,
    storageService: SNStorageService,
    sessionManager: SNSessionManager
  ) {
    super();
    this.modelManager = modelManager;
    this.syncService = syncService;
    this.singletonManager = singletonManager;
    this.protocolService = protocolService;
    this.storageService = storageService;
    this.sessionManager = sessionManager;
    this.loadDefaults();
  }

  public deinit() {
    this.modelManager = undefined;
    this.syncService = undefined;
    this.singletonManager = undefined;
    this.protocolService = undefined;
    this.storageService = undefined;
    this.sessionManager = undefined;
    super.deinit();
  }

  private loadDefaults() {
    this.availableActions = Object.keys(ProtectedActions).map((key) => {
      return (ProtectedActions as any)[key] as ProtectedActions;
    });

    this.availableCredentials = [
      PrivilegeCredentials.AccountPassword,
      PrivilegeCredentials.LocalPasscode
    ];

    this.sessionLengths = [
      PrivilegeSessionLength.None,
      PrivilegeSessionLength.FiveMinutes,
      PrivilegeSessionLength.OneHour,
      PrivilegeSessionLength.OneWeek
    ];
  }

  getAvailableActions() {
    return this.availableActions;
  }

  getAvailableCredentials() {
    return this.availableCredentials;
  }

  /**
   * The credentials currently required to perform this action.
   */
  async netCredentialsForAction(action: ProtectedActions) {
    const privileges = await this.getPrivileges();
    const credentials = privileges.getCredentialsForAction(action);
    const netCredentials = [];
    for (const credential of credentials) {
      if (credential === PrivilegeCredentials.AccountPassword) {
        const isOnline = await this.sessionManager!.online();
        if (isOnline) {
          netCredentials.push(credential);
        }
      } else if (credential === PrivilegeCredentials.LocalPasscode) {
        const hasPasscode = await this.protocolService!.hasRootKeyWrapper();
        if (hasPasscode) {
          netCredentials.push(credential);
        }
      }
    }
    return netCredentials;
  }

  async getPrivileges() {
    const contentType = ContentTypes.Privileges;
    const predicate = new SNPredicate('content_type', '=', contentType);
    return this.singletonManager!.findOrCreateSingleton(
      predicate,
      CreateMaxPayloadFromAnyObject(
        {
          content_type: contentType,
          content: {}
        }
      )
    ) as Promise<SNPrivileges>;
  }

  async savePrivileges() {
    const privileges = await this.getPrivileges();
    await this.modelManager!.setItemDirty(privileges);
    return this.syncService!.sync();
  }

  async setSessionLength(length: PrivilegeSessionLength) {
    const addSecondsToNow = (seconds: number) => {
      const date = new Date();
      date.setSeconds(date.getSeconds() + seconds);
      return date;
    };
    const expiresAt = addSecondsToNow(length);
    await this.storageService!.setValue(
      StorageKeys.PrivilegesExpirey,
      expiresAt
    );
    await this.storageService!.setValue(
      StorageKeys.PrivilegesSessionLength,
      length
    );
  }

  async clearSession() {
    return this.setSessionLength(PrivilegeSessionLength.None);
  }

  async getSelectedSessionLength() {
    const length = await this.storageService!.getValue(
      StorageKeys.PrivilegesSessionLength
    );
    if (length) {
      return length;
    } else {
      return PrivilegeSessionLength.None;
    }
  }

  async getSessionExpirey() {
    const expiresAt = await this.storageService!.getValue(
      StorageKeys.PrivilegesExpirey
    );
    if (expiresAt) {
      return new Date(expiresAt);
    } else {
      return new Date();
    }
  }

  async actionHasPrivilegesConfigured(action: ProtectedActions) {
    return (await this.netCredentialsForAction(action)).length > 0;
  }

  /**
   * Whether the action requires present authentication.
   */
  async actionRequiresPrivilege(action: ProtectedActions) {
    const expiresAt = await this.getSessionExpirey();
    if (expiresAt > new Date()) {
      return false;
    }
    const netCredentials = await this.netCredentialsForAction(action);
    return netCredentials.length > 0;
  }

  async authenticateAction(
    action: ProtectedActions,
    credentialAuthMapping: CredentialAuthMapping
  ) {
    const requiredCredentials = await this.netCredentialsForAction(action);
    const successfulCredentials = [];
    const failedCredentials = [];
    for (const credential of requiredCredentials) {
      const passesAuth = await this.verifyAuthenticationParameters(
        credential,
        credentialAuthMapping[credential]!
      );
      if (passesAuth) {
        successfulCredentials.push(credential);
      } else {
        failedCredentials.push(credential);
      }
    }
    return {
      success: failedCredentials.length === 0,
      successfulCredentials: successfulCredentials,
      failedCredentials: failedCredentials
    };
  }

  async verifyAuthenticationParameters(
    credential: PrivilegeCredentials,
    value: string
  ) {
    if (credential === PrivilegeCredentials.AccountPassword) {
      const { valid } = await this.protocolService!.validateAccountPassword(value);
      return valid;
    } else if (credential === PrivilegeCredentials.LocalPasscode) {
      const { valid } = await this.protocolService!.validatePasscode(value);
      return valid;
    }
  }

  displayInfoForCredential(credential: PrivilegeCredentials) {
    return CredentialsMetadata[credential];
  }

  displayInfoForAction(action: ProtectedActions) {
    return ActionsMetadata[action];
  }

  getSessionLengthOptions() {
    return [
      {
        value: PrivilegeSessionLength.None,
        label: "Don't Remember"
      },
      {
        value: PrivilegeSessionLength.FiveMinutes,
        label: '5 Minutes'
      },
      {
        value: PrivilegeSessionLength.OneHour,
        label: '1 Hour'
      },
      {
        value: PrivilegeSessionLength.OneWeek,
        label: '1 Week'
      }
    ];
  }
}