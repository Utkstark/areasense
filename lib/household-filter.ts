import type { Society, Household, TenantPreferenceSignal } from '@/types';

/**
 * Decides whether a society's tenant-preference signal is compatible with the
 * user's household type.
 *
 * Permissive on `unknown`: when the source data doesn't carry a clear signal,
 * we don't hide the society. The UI can surface a "preference not confirmed"
 * badge if it wants to be transparent about the gap. See product-spec.md §4.2
 * and data-model.md §3 for the rationale.
 *
 * Pure predicate — does not filter arrays, attach deep-links, or decide UI
 * behavior. The orchestrator iterates; the frontend chooses whether to hide
 * or gray-out failing societies (data-model.md §8, MatchedSociety).
 */
export function passesHouseholdFilter(
  society: Society,
  household: Household,
): boolean {
  const signal: TenantPreferenceSignal = society.tenant_preference_signal;

  switch (signal) {
    case 'accepts_both':
    case 'unknown':
      return true;
    case 'accepts_bachelors':
      return household === 'single';
    case 'accepts_family':
      return household === 'family';
    default: {
      // Exhaustiveness guard — adding a new TenantPreferenceSignal value
      // (e.g., the v1+ bachelor-gender split flagged in product-spec.md §11)
      // will fail to compile here until it's handled above.
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}