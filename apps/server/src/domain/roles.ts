/**
 * Role predicates. Kept in one place so HTTP routes, WebSocket handlers and tests
 * cannot disagree about who is allowed to do what.
 */

export const Roles = {
  canManageConversation: (role: string | null): boolean => role === 'owner' || role === 'admin',
  canManageMembers: (role: string | null): boolean => role === 'owner' || role === 'admin',
  canAssignRoles: (role: string | null): boolean => role === 'owner' || role === 'admin',
  canDeleteAnyMessage: (role: string | null): boolean =>
    role === 'owner' || role === 'admin' || role === 'moderator',
  canPostInChannel: (role: string | null): boolean =>
    role === 'owner' || role === 'admin' || role === 'moderator',
  canModerateChannel: (role: string | null): boolean => role === 'owner' || role === 'admin',
  isStaff: (role: string | null): boolean => role === 'admin' || role === 'moderator',
} as const;
