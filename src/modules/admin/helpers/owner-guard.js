// The last-owner guard.
//
// Locking every owner out of the admin panel is unrecoverable without direct
// database access, so deleting, deactivating or demoting the final active
// owner is refused. Pure so the rule is unit-testable.

export const ADMIN_ROLES = ['owner', 'manager', 'staff'];

/** Count the active owners in a list of admin_users rows. */
export function countActiveOwners(users) {
  return (users ?? []).filter((u) => u.role === 'owner' && isActive(u)).length;
}

function isActive(user) {
  // mysql2 returns BOOLEAN as 1/0; accept both shapes.
  return user?.is_active === true || user?.is_active === 1;
}

/**
 * May this change to `target` proceed?
 *
 * @param {object} target            the admin_users row being changed
 * @param {object} change            { action:'delete' } or { is_active?, role? }
 * @param {number} activeOwnerCount  active owners INCLUDING target
 * @returns {{allowed:boolean, reason:string|null}}
 */
export function canModifyAdmin(target, change = {}, activeOwnerCount = 0) {
  const targetIsActiveOwner = target?.role === 'owner' && isActive(target);

  // Only changes to the last remaining active owner are ever blocked.
  if (!targetIsActiveOwner || activeOwnerCount > 1) {
    return { allowed: true, reason: null };
  }

  const removesOwner =
    change.action === 'delete' ||
    change.is_active === false ||
    change.is_active === 0 ||
    (change.role != null && change.role !== 'owner');

  if (!removesOwner) return { allowed: true, reason: null };

  const verb =
    change.action === 'delete'
      ? 'delete'
      : change.role != null && change.role !== 'owner'
        ? 'change the role of'
        : 'deactivate';

  return {
    allowed: false,
    reason: `Cannot ${verb} the last active owner. Promote another admin to owner first.`,
  };
}
