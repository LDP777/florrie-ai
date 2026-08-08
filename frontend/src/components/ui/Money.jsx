/**
 * Money — the one way a money figure is set.
 *
 * Plus Jakarta Sans 700 with tabular figures. It was Playfair, on the argument
 * that editorial numerals are the brand — and Levi overruled that looking at a
 * real screen: "I still want all the numbers on the app everywhere to be in
 * this font regardless of what colour it is or what page, just easier to read."
 * He is right. Playfair's digits are lighter and narrower, and legibility on a
 * phone in a salon beats the typographic argument. Every number in the app now
 * reads the same whatever page it is on and whatever colour it happens to be.
 *
 * Tabular figures are not decoration here: MoneyTracker animates its headline
 * with a count-up, and proportional digits change width as they tick, so the
 * number jitters horizontally on every frame.
 *
 *   <Money pence={122530} size={44} />        £1,225.30
 *   <Money amount={38.2} />                   £38.20
 *   <Money pence={8500} round />              £85
 *   <Money pence={-1250} signed />            −£12.50
 */

const NBSP_MINUS = '−'; // a real minus, not a hyphen

export function formatMoney(value, { round = false, signed = false, currency = '£' } = {}) {
  const n = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(n);
  // "round" means drop pence when there are none to show, which is what makes
  // £85 read as a number rather than a receipt line.
  const showPence = !round || Math.round(abs * 100) % 100 !== 0;
  const body = abs.toLocaleString('en-GB', {
    minimumFractionDigits: showPence ? 2 : 0,
    maximumFractionDigits: showPence ? 2 : 0,
  });
  const sign = n < 0 ? NBSP_MINUS : (signed && n > 0 ? '+' : '');
  return `${sign}${currency}${body}`;
}

export default function Money({
  pence,
  amount,
  // No default size. Money is used two ways: as a headline, where the caller
  // sets the size, and inline inside a span that already has one — a week-view
  // cell at 11px, a detail row at 13px. Defaulting to 20 made every one of the
  // 74 inline sites jump to 20px and ignore its container, which is a worse
  // regression than the inconsistency this component exists to fix.
  size,
  weight = 700,
  round = false,
  signed = false,
  currency = '£',
  as: Tag = 'span',
  style,
  className,
  ...rest
}) {
  const value = typeof pence === 'number' ? pence / 100 : (amount ?? 0);

  return (
    <Tag
      className={className}
      style={{ fontFamily: '"Plus Jakarta Sans", -apple-system, sans-serif',
        fontWeight: weight,
        ...(size ? { fontSize: size } : null),
        // Digits keep a fixed advance width, so a ticking figure does not shuffle
        // and a column of figures lines up on the decimal.
        fontVariantNumeric: 'tabular-nums',
        fontFeatureSettings: '"tnum" 1, "lnum" 1',
        letterSpacing: size >= 32 ? '-0.03em' : '-0.01em',
        // Inherit rather than force, so a figure inside a 13px detail row stays
        // 13px and only the typeface and the tabular figures change.
        lineHeight: 1.05,
        ...style,
      }}
      {...rest}
    >
      {formatMoney(value, { round, signed, currency })}
    </Tag>
  );
}
