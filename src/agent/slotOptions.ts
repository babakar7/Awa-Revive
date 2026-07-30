/**
 * Validation for slot_ option ids passed to present_options.
 *
 * Prod 29/07: the model sent options with invented ids (slot_placeholder2/3/4)
 * next to one real slot — a tap on those would resolve to nothing. Slot ids must
 * be choice_ids minted by a fresh check_availability (shape slot_<32 hex>) AND
 * still live in slot_cache. Pure + injected resolver so it is unit-testable.
 */
export const CANONICAL_SLOT_ID = /^slot_[0-9a-f]{32}$/;

/**
 * @param ids      all option ids from the present_options call
 * @param resolve  returns truthy when a slot id is live in the cache
 * @returns the ids that are invented (bad shape) or expired/unknown; empty = ok
 */
export async function invalidSlotOptionIds(
  ids: string[],
  resolve: (id: string) => Promise<unknown>,
): Promise<string[]> {
  const slotIds = ids.filter((id) => id.startsWith("slot_"));
  if (slotIds.length === 0) return [];
  const malformed = slotIds.filter((id) => !CANONICAL_SLOT_ID.test(id));
  if (malformed.length > 0) return malformed; // don't hit the cache on junk shapes
  const resolved = await Promise.all(slotIds.map((id) => resolve(id)));
  return slotIds.filter((_, i) => !resolved[i]);
}
