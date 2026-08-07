/**
 * Money — the one way a money figure is set.
 *
 * Playfair numerals on cream is the whole editorial argument of the brand, and
 * none of the 111 money sites in the app were using it. The Money hero even
 * opted out into sans weight 800, which is not a loaded weight, so the most
 * important number in the product rendered as a synthetic faux-bold.
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
  size = 20,
  weight = 600,
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
      style={{ fontFamily: "'Playfair Display', Georgia, serif",
        fontWeight: weight,
        fontSize: size,
        // Digits keep a fixed advance width, so a ticking figure does not shuffle
        // and a column of figures lines up on the decimal.
        fontVariantNumeric: 'tabular-nums',
        fontFeatureSettings: '"tnum" 1, "lnum" 1',
        letterSpacing: size >= 32 ? '-0.03em' : '-0.01em',
        lineHeight: 1.05,
        ...style,
      }}
      {...rest}
    >
      {formatMoney(value, { round, signed, currency })}
    </Tag>
  );
}
