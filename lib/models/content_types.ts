export enum ContentTypes {
  Any = '*',
  Item = 'SF|Item',
  RootKey = 'SN|RootKey|NoSync',
  ItemsKey = 'SN|ItemsKey',
  EncryptedStorage = 'SN|EncryptedStorage',
  Note = 'Note',
  Tag = 'Tag',
  SmartTag = 'SN|SmartTag',
  Component = 'SN|Component',
  Editor = 'SN|Editor',
  ActionsExtension = 'Extension',
  UserPrefs = 'SN|UserPreferences',
  Privileges = 'SN|Privileges',
  HistorySession = 'SN|HistorySession',
  Theme = 'SN|Theme',
  Mfa = 'SF|MFA',
  ServerExtension = 'SF|Extension',
  FilesafeCredentials = 'SN|FileSafe|Credentials',
  FilesafeFileMetadata = 'SN|FileSafe|FileMetadata',
  FilesafeIntegration = 'SN|FileSafe|Integration',
  ExtensionRepo = 'SN|ExtensionRepo'
};

export function displayStringForContentType(contentType: ContentTypes) {
  const map: Record<any, string> = {
    [ContentTypes.Note] : 'note',
    [ContentTypes.Tag] : 'tag',
    [ContentTypes.SmartTag] : 'smart tag',
    [ContentTypes.ActionsExtension] : 'action-based extension',
    [ContentTypes.Component] : 'component',
    [ContentTypes.Editor] : 'editor',
    [ContentTypes.Theme] : 'theme',
    [ContentTypes.ServerExtension] : 'server extension',
    [ContentTypes.Mfa] : 'two-factor authentication setting',
    [ContentTypes.FilesafeCredentials]: 'FileSafe credential',
    [ContentTypes.FilesafeFileMetadata]: 'FileSafe file',
    [ContentTypes.FilesafeIntegration]: 'FileSafe integration'
  };
  return map[contentType];
}