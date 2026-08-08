/**
 * One definition of "how big is this tap target", shared by the inventory and
 * the codemod.
 *
 * They started as two implementations of the same idea and immediately
 * disagreed — 147 against 42 — because one understood `padding: '8px 12px'`
 * and clickable <div>s and the other did not. A fix that reports a number the
 * checker does not recognise is how work gets called done while a third of the
 * sites stay broken, so there is now exactly one of these.
 */

export const MIN = 44;

/** Elements whose hit area can be expanded with ::after. */
export const PSEUDO_OK = new Set(['button', 'a', 'label', 'div', 'span', 'li']);

/**
 * Replaced elements. ::before/::after do not render on these at all — verified
 * in a browser, not assumed: with the expansion applied, a tap 7px above an
 * <input> lands on <html>. They need real height instead.
 */
export const REPLACED = new Set(['input', 'select', 'textarea']);

/** A statically-known px number: 8, '8px', '8'. Anything computed returns null. */
export function num(node) {
  if (!node) return null;
  if (node.type === 'NumericLiteral') return node.value;
  if (node.type === 'StringLiteral') {
    const v = node.value.trim();
    const m = /^(-?[\d.]+)px$/.exec(v);
    if (m) return parseFloat(m[1]);
    return /^-?[\d.]+$/.test(v) ? parseFloat(v) : null;
  }
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const v = num(node.argument);
    return v === null ? null : -v;
  }
  return null;
}

/** style={{...}} -> { prop: ObjectProperty }, following a ternary into both arms. */
export function styleProps(attr) {
  const out = {};
  if (!attr || attr.value?.type !== 'JSXExpressionContainer') return out;
  const collect = (obj) => {
    if (obj?.type !== 'ObjectExpression') return;
    for (const p of obj.properties) {
      if (p.type === 'SpreadElement') continue;
      const key = p.key?.name || p.key?.value;
      if (key) out[key] = p;
    }
  };
  const e = attr.value.expression;
  if (e.type === 'ObjectExpression') collect(e);
  else if (e.type === 'ConditionalExpression') { collect(e.consequent); collect(e.alternate); }
  return out;
}

/** Block-axis padding in px, handling every shorthand form the codebase uses. */
export function paddingBlock(props) {
  let block = null;
  const p = props.padding?.value;
  if (p) {
    const n = num(p);
    if (n !== null) block = n;
    else if (p.type === 'StringLiteral') {
      const parts = p.value.trim().split(/\s+/).map(parseFloat);
      if (parts.every(Number.isFinite)) {
        block = parts.length === 1 ? parts[0]
              : parts.length === 2 ? parts[0]
              : (parts[0] + parts[2]) / 2;
      }
    }
  }
  const pv = num(props.paddingBlock?.value) ?? num(props.paddingVertical?.value);
  if (pv !== null) block = pv;
  const pt = num(props.paddingTop?.value), pb = num(props.paddingBottom?.value);
  if (pt !== null || pb !== null) block = ((pt ?? block ?? 0) + (pb ?? block ?? 0)) / 2;
  return block;
}

/**
 * The height a browser would give this element, as far as the source can say.
 * Returns null when it genuinely cannot be known — a height from content, a
 * CSS variable, a computed expression — because guessing there produces a
 * confident number for something nobody measured.
 */
export function measure(props) {
  const h = num(props.height?.value) ?? num(props.minHeight?.value);
  if (h !== null) return { px: h, basis: 'height' };
  const pad = paddingBlock(props);
  if (pad !== null) {
    const fs = num(props.fontSize?.value);
    const line = Math.round((fs ?? 16) * 1.3);
    return { px: pad * 2 + line, basis: `padding ${pad}×2 + line ${line}` };
  }
  return null;
}

/** Is this element something a finger is meant to hit? */
export function isTarget(tag, has) {
  if (REPLACED.has(tag)) {
    const t = has('type');
    const tv = t?.value?.type === 'StringLiteral' ? t.value.value : null;
    return !['hidden', 'checkbox', 'radio'].includes(tv);
  }
  if (tag === 'button') return true;
  // A link or label is a target when it does something; otherwise it is prose.
  if (tag === 'a' || tag === 'label') return !!(has('onClick') || has('href') || has('htmlFor'));
  // Anything else only counts if it has been given a handler.
  return !!(has('onClick') || has('onPointerDown'));
}
