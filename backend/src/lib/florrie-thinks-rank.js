/**
 * Ranking and expiry for the "Florrie thinks" cards, kept pure so it can be
 * unit tested without a database. The feed's contract is deliberately small:
 *
 *   - Florrie thinks, she does not nag: at most MAX_CARDS surface per fetch.
 *   - Money first: cards are ordered by estimated pounds at stake, because a
 *     £45 uncollected balance matters more than a quiet-diary nudge.
 *   - Urgency breaks ties: two cards worth the same pounds are ordered by how
 *     soon the moment passes (a gap today beats a lapsed regular).
 *   - Nothing stale ever renders: every card carries its own expires_at and
 *     anything past that stamp is dropped server side at fetch time. This is
 *     the rule that killed the old cards' "book a June date in August" bug.
 *
 * Timestamps come in two frames because the product does:
 *   - 'wall'  stamps are SALON WALL TIME in the UTC slot (the appointments
 *     convention: an 11:00 booking is stored as ...T11:00:00Z). They must be
 *     compared against a wall-frame "now" (nowInSalonWall), never real UTC,
 *     or every comparison drifts an hour in BST.
 *   - 'utc'   stamps are genuine instants (messages.created_at). They compare
 *     against Date.now().
 */

export const MAX_CARDS = 3;

/** Parse an ISO stamp to epoch ms, or null when unparseable. */
function stampMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Drop every card whose moment has passed. A card with no expires_at is
 * dropped too: rule 2 says every card carries one, so a card without it is a
 * bug and the safe direction is to hide it, not show something unanchored.
 */
export function dropExpired(cards, { nowUtcMs, nowWallMs }) {
  return (cards || []).filter((card) => {
    const t = stampMs(card && card.expires_at);
    if (t === null) return false;
    const now = card.expires_frame === 'wall' ? nowWallMs : nowUtcMs;
    if (!Number.isFinite(now)) return false;
    return t > now;
  });
}

/**
 * Order by estimated money at stake (desc), then urgency (desc), and cap the
 * feed. Missing figures count as zero so a card can never win a slot by
 * omitting its numbers. Input is not mutated.
 */
export function rankCards(cards, { max = MAX_CARDS } = {}) {
  return [...(cards || [])]
    .sort((a, b) => {
      const money = (Number(b?.impact_pence) || 0) - (Number(a?.impact_pence) || 0);
      if (money !== 0) return money;
      return (Number(b?.urgency) || 0) - (Number(a?.urgency) || 0);
    })
    .slice(0, max);
}
