import { FamilyMemberStatus, FamilyRole } from "../types/family.types";

/**
 * The dashboard is for caregivers. Someone who is only ever a care recipient
 * (in every family they belong to) is refused; anyone who also holds a
 * caregiving role somewhere, or has no family yet, may sign in.
 */
export function isCareRecipientOnly(
  userId: string,
  members: Array<{ userId: string; role: FamilyRole | string; status: FamilyMemberStatus | string }>,
): boolean {
  const roles = members
    .filter(
      (m) =>
        m.userId === userId &&
        m.status !== FamilyMemberStatus.REMOVED &&
        m.status !== FamilyMemberStatus.REJECTED,
    )
    .map((m) => m.role);
  return roles.length > 0 && roles.every((role) => role === FamilyRole.CARE_RECIPIENT);
}
