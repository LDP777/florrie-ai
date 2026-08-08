/**
 * Button — the one button.
 *
 * There were 847 hand-styled <button>s across 91 files and exactly one import
 * of this component. That ratio is the entire drift story: rolling your own was
 * always less effort than importing. This rewrite exists to invert that.
 *
 * What the old version got wrong, all of it found by inventorying the real
 * call sites rather than by taste:
 *
 *  - `&:hover`, `&:active` and `&:focus` were keys in an inline style object.
 *    React drops them. Every interaction state on the app's shared button has
 *    been dead since it was written. They are CSS classes now, in index.css.
 *  - `minHeight: 44` was unconditional, but 69 chips and 58 icon buttons in the
 *    app run at 11-13px with 4-8px padding. Codemodding those onto it would
 *    have visibly inflated every filter row. There is now an `xs` size, and the
 *    tap floor is met with an invisible ::after rather than by growing the
 *    control.
 *  - No `type`, so any button inside a <form> defaulted to submit. Defaults to
 *    "button" now; pass type="submit" deliberately.
 *  - No `as`/`href`, so links that look like buttons had to be hand-styled.
 *
 * Variants map to the clusters that actually exist in the codebase:
 *   primary 242 · secondary 225 · tonal 116 · quiet 86 · chip 69 · danger 33
 *
 *   <Button onClick={save}>Save</Button>
 *   <Button variant="secondary" size="sm">Edit</Button>
 *   <Button variant="chip" size="xs" aria-pressed={active}>Needs you</Button>
 *   <Button variant="quiet" icon size="icon" aria-label="Close"><Icon name="x" /></Button>
 *   <Button as="a" href={url}>Open</Button>
 */

const cx = (...parts) => parts.filter(Boolean).join(' ');

export default function Button({
  variant = 'primary',
  size = 'md',
  icon = false,
  pill = false,
  fullWidth = false,
  loading = false,
  disabled = false,
  as: Tag = 'button',
  className,
  style,
  children,
  ...props
}) {
  const isButton = Tag === 'button';
  return (
    <Tag
      className={cx(
        'fl-btn',
        `fl-btn--${variant}`,
        icon ? 'fl-btn--icon' : `fl-btn--${size}`,
        pill && 'fl-btn--pill',
        fullWidth && 'fl-btn--full',
        className,
      )}
      // Without this, a button inside a form submits it. That is a real bug
      // waiting in every one of the app's forms, not a style preference.
      {...(isButton ? { type: props.type || 'button' } : {})}
      {...(isButton ? { disabled: disabled || loading } : { 'aria-disabled': disabled || undefined })}
      style={style}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </Tag>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        width: 14, height: 14, flexShrink: 0,
        border: '2px solid currentColor',
        borderRightColor: 'transparent',
        borderRadius: '50%',
        animation: 'spin 0.6s linear infinite',
      }}
    />
  );
}
