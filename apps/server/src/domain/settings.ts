/** Shapes of the JSONB settings columns on `users` (kept in one place, validated by API). */

export interface PrivacySettings {
  whoCanMessage: 'everyone' | 'contacts' | 'nobody';
  whoCanSeeProfile: 'everyone' | 'followers' | 'nobody';
  readReceipts: boolean;
  showOnlineStatus: boolean;
}

export interface NotificationSettings {
  conversationNotifications: 'all' | 'mentions' | 'none';
  pushEnabled: boolean;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  whoCanMessage: 'everyone',
  whoCanSeeProfile: 'everyone',
  readReceipts: true,
  showOnlineStatus: true,
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  conversationNotifications: 'all',
  pushEnabled: false,
};
