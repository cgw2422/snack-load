/**
 * Who queued a mutation, and whose cached reads these are.
 *
 * Organization as well as user: the same person can belong to two distributors,
 * and a sale queued under one must never replay under the other.
 */
export function ownerKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`
}
