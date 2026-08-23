/**
 * BusinessProfile - Business info, branding, social links.
 *
 * Sections:
 *   Info       - tagline (identity: name & contact edited in Settings)
 *   Branding   - brand colour, booking page accent, logo upload placeholder
 *   Social     - Instagram, TikTok, Facebook, website links
 *   Booking    - booking page URL preview, share button
 *
 * Beautician profile data from Supabase.
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, updateRow, supabase } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import { bookingUrl as publicBookingUrl } from '../lib/booking.js';
import Icon, { iconName } from '../components/ui/Icon';
import { onBrand } from '../lib/brand-colour.js';
import PageHeader from '../components/ui/PageHeader.jsx';
const BRAND_COLOURS = [
  'var(--accent, #92405e)', '#E8A0BF', '#C4A882', '#8B7355',
  '#7B9E89', '#5B8F6F', '#6B8EC4', '#4A6FA5',
  '#9B8EC4', '#7B68AE', 'var(--text-primary, #241B17)', '#5A5550',
];

const SOCIAL_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', icon: 'camera', placeholder: '@ellindigo' },
  { key: 'tiktok', label: 'TikTok', icon: 'mic', placeholder: '@ellindigo' },
  { key: 'facebook', label: 'Facebook', icon: 'users', placeholder: 'Ellindigo Brows & Beauty' },
  { key: 'website', label: 'Website', icon: 'link', placeholder: 'www.ellindigo.co.uk' },
];

export default function BusinessProfile() {
  const { dark } = useTheme();
  const navigate = useNavigate();
  const { beautician, loading: bLoading, refresh } = useBeautician();
  const [tab, setTab] = useState('info');

  // Business name is read-only context here (identity is edited in Settings).
  const [businessName, setBusinessName] = useState('');
  const [tagline, setTagline] = useState('');

  // Branding
  const [brandColor, setBrandColor] = useState('#C4A882');
  const [logoPreview, setLogoPreview] = useState(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState(null);
  const [emailSignOff, setEmailSignOff] = useState('');
  const logoInputRef = useRef(null);

  // Socials
  const [socials, setSocials] = useState({ instagram: '', tiktok: '', facebook: '', website: '' });

  // Booking
  const [linkCopied, setLinkCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate from Supabase when beautician loads
  useEffect(() => {
    if (!beautician) return;
    setBusinessName(beautician.business_name || '');
    setTagline(beautician.tagline || '');
    setBrandColor(beautician.brand_color || '#C4A882');
    setLogoPreview(beautician.logo_url || null);
    setEmailSignOff(beautician.client_reminder_prefs?.email_sign_off || '');
    const sp = beautician.social_links || {};
    setSocials({ instagram: sp.instagram || '', tiktok: sp.tiktok || '', facebook: sp.facebook || '', website: sp.website || '' });
  }, [beautician]);

  const bookingUrl = publicBookingUrl(beautician?.booking_slug || 'your-slug');

  function handleCopy() {
    navigator.clipboard?.writeText(bookingUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  const shareMessage = `Book in with ${businessName || 'me'} here: ${bookingUrl}`;

  function shareWhatsApp() {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareMessage)}`, '_blank', 'noopener');
  }

  function shareFacebook() {
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(bookingUrl)}`, '_blank', 'noopener');
  }

  function shareInstagram() {
    // Instagram has no web share intent, so copy the link for pasting into bio or DMs
    navigator.clipboard?.writeText(bookingUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
    alert('Link copied. Paste it into your Instagram bio, story link, or a DM.');
  }

  async function handleLogoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setLogoError('Image must be under 2MB'); return; }
    setLogoUploading(true);
    setLogoError(null);
    try {
      const ext = file.name.split('.').pop();
      const path = `${beautician.id}/logo.${ext}`;
      const { error: upErr } = await supabase.storage.from('logos').upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = supabase.storage.from('logos').getPublicUrl(path);
      // Bust cache by appending timestamp
      const url = `${publicUrl}?t=${Date.now()}`;
      setLogoPreview(url);
      await updateRow('beauticians', beautician.id, { logo_url: url });
      await refresh();
    } catch (err) {
      logger.error('Logo upload error:', err);
      setLogoError('Upload failed, please try again');
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleSave() {
    if (!beautician) return;
    setSaving(true);
    try {
      await updateRow('beauticians', beautician.id, {
        tagline,
        brand_color: brandColor,
        logo_url: logoPreview,
        social_links: socials,
        client_reminder_prefs: { ...(beautician.client_reminder_prefs || {}), email_sign_off: emailSignOff.trim() || null },
      });
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      logger.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }

  if (bLoading) return <p style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted, #6B5D54)' }}>Loading...</p>;

  const tabs = [
    { key: 'info', label: 'Info' },
    { key: 'branding', label: 'Branding' },
    { key: 'social', label: 'Social' },
    { key: 'booking', label: 'Booking' },
  ];

  return (
    <div style={s.page}>
      <PageHeader
        title="Business Profile"
        subtitle="Your public info, branding & social links"
      />

      {/* Hero card */}
      <div style={{ ...s.heroCard, background: `linear-gradient(135deg, ${brandColor}, ${brandColor}CC)`, color: onBrand(brandColor) }}>
        <div style={s.heroLogo}>
          {logoPreview ? (
            <img src={logoPreview} alt="Logo" style={{ width: 48, height: 48, borderRadius: 22, objectFit: 'cover' }} />
          ) : (
            <span style={s.heroInitial}>{businessName[0] || 'F'}</span>
          )}
        </div>
        <span style={s.heroName}>{businessName || 'Your Business'}</span>
        {tagline && <span style={s.heroTagline}>{tagline}</span>}
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{ ...s.tab,
              color: tab === t.key ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)',
              borderBottom: tab === t.key ? '2px solid var(--accent, #92405e)' : '2px solid transparent',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Info tab */}
      {tab === 'info' && (
        <div style={s.section}>
          {/* Business name & contact live in Settings - shown here read-only for context */}
          <div style={s.fieldGroup}>
            <span style={s.fieldLabel}>Business name</span>
            <div style={s.readOnlyRow}>
              <span style={s.readOnlyValue}>{businessName || 'Not set yet'}</span>
              <button type="button" onClick={() => navigate('/settings?section=profile')} style={s.editLink}>
                Edit name &amp; contact in Settings ›
              </button>
            </div>
          </div>
          <Field label="Tagline" value={tagline} onChange={setTagline} placeholder="A short description clients see" />
        </div>
      )}

      {/* Branding tab */}
      {tab === 'branding' && (
        <div style={s.section}>
          <div style={s.card}>
            <span style={s.cardLabel}>Brand colour</span>
            <span style={s.cardDesc}>Used on your booking page and client messages</span>
            <div style={s.colourGrid}>
              {BRAND_COLOURS.map(c => (
                <button
                  key={c}
                  onClick={() => setBrandColor(c)}
                  style={{ ...s.colourDot,
                    background: c,
                    border: brandColor === c ? '3px solid var(--text-primary, #241B17)' : '3px solid transparent',
                    boxShadow: brandColor === c ? '0 0 0 2px #fff' : 'none',
                  }}
                  aria-label={c}
                />
              ))}
            </div>
            <div style={s.customColour}>
              <span style={s.customLabel}>Custom:</span>
              <input
                type="color"
                value={brandColor}
                onChange={e => setBrandColor(e.target.value)}
                style={s.colourInput}
              />
              <span style={s.colourHex}>{brandColor}</span>
            </div>
          </div>

          <div style={s.card}>
            <span style={s.cardLabel}>Logo</span>
            <span style={s.cardDesc}>Shown on your booking page and at the top of client emails</span>
            <div style={s.logoUpload}>
              <div style={s.logoPlaceholder}>
                {logoPreview ? (
                  <img src={logoPreview} alt="Logo" style={{ width: 64, height: 64, borderRadius: 10, objectFit: 'cover' }} />
                ) : (
                  <span style={s.logoIcon}><Icon name="camera" size={15} /></span>
                )}
              </div>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={handleLogoUpload}
              />
              <button
                style={{ ...s.uploadBtn, opacity: logoUploading ? 0.6 : 1, cursor: logoUploading ? 'not-allowed' : 'pointer' }}
                onClick={() => logoInputRef.current?.click()}
                disabled={logoUploading}
              >
                {logoUploading ? 'Uploading…' : 'Upload logo'}
              </button>
              {logoError && <span style={{ fontSize: 11, color: '#E57373' }}>{logoError}</span>}
              <span style={s.uploadHint}>PNG or JPG, 512×512 recommended</span>
            </div>
          </div>

          <div style={s.card}>
            <span style={s.cardLabel}>Email sign-off</span>
            <span style={s.cardDesc}>The closing line on confirmations and reminders. Leave blank to skip.</span>
            <input
              type="text"
              value={emailSignOff}
              onChange={e => setEmailSignOff(e.target.value)}
              placeholder="With love, Ellie x"
              maxLength={120}
              style={s.signOffInput}
            />
          </div>

          {/* Live preview */}
          <div style={s.card}>
            <span style={s.cardLabel}>Email preview</span>
            <div style={s.brandPreview}>
              <div style={{ ...s.previewBar, background: brandColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {logoPreview
                  ? <img src={logoPreview} alt="" style={{ width: 28, height: 28, borderRadius: 10, objectFit: 'cover' }} />
                  : <span style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>{businessName || 'Your Business'}</span>}
              </div>
              <div style={s.previewContent}>
                <span style={{ ...s.previewName, color: brandColor }}>{businessName}</span>
                {emailSignOff && <span style={{ fontSize: 12, color: 'var(--text-muted, #6B5D54)', fontStyle: 'italic' }}>{emailSignOff}</span>}
                <div style={{ ...s.previewButton, background: brandColor }}>Book Now</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Social tab */}
      {tab === 'social' && (
        <div style={s.section}>
          {SOCIAL_PLATFORMS.map(p => (
            <div key={p.key} style={s.socialRow}>
              <span style={s.socialIcon}><Icon name={iconName(p.icon)} inline /></span>
              <div style={{ flex: 1 }}>
                <span style={s.socialLabel}>{p.label}</span>
                <input
                  type="text"
                  value={socials[p.key]}
                  onChange={e => setSocials(prev => ({ ...prev, [p.key]: e.target.value }))}
                  placeholder={p.placeholder}
                  style={s.socialInput}
                />
              </div>
            </div>
          ))}
          <p style={s.socialNote}>
            These links appear on your booking page and in automated messages to clients.
          </p>
        </div>
      )}

      {/* Booking tab */}
      {tab === 'booking' && (
        <div style={s.section}>
          <div style={s.card}>
            <span style={s.cardLabel}>Your booking link</span>
            <div style={s.urlRow}>
              <span style={s.urlText}>{bookingUrl.replace('https://', '')}</span>
              <button onClick={handleCopy} style={s.copyBtn}>
                {linkCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div style={s.card}>
            <span style={s.cardLabel}>Share your booking page</span>
            <div style={s.shareGrid}>
              <button style={s.shareBtn} onClick={shareWhatsApp}><Icon name="phone" size={14} inline /> WhatsApp</button>
              <button style={s.shareBtn} onClick={shareInstagram}><Icon name="camera" size={14} inline /> Instagram</button>
              <button style={s.shareBtn} onClick={shareFacebook}>{<Icon name="users" inline />} Facebook</button>
              <button style={s.shareBtn} onClick={handleCopy}>{linkCopied ? 'Copied' : 'Copy link'}</button>
            </div>
          </div>

          {/* Mini booking page preview */}
          <div style={s.card}>
            <span style={s.cardLabel}>Booking page preview</span>
            <div style={s.bookingPreview}>
              <div style={{ ...s.bpHeader, background: `linear-gradient(135deg, ${brandColor}, ${brandColor}CC)`, color: onBrand(brandColor) }}>
                <span style={s.bpName}>{businessName}</span>
                {tagline && <span style={s.bpTagline}>{tagline}</span>}
              </div>
              <div style={s.bpBody}>
                <div style={s.bpService}>
                  <span style={s.bpServiceName}>Lamination & Hybrid Dye</span>
                  <span style={s.bpServiceMeta}>60 min · £45</span>
                </div>
                <div style={s.bpService}>
                  <span style={s.bpServiceName}>Lash Lift & Tint</span>
                  <span style={s.bpServiceMeta}>60 min · £40</span>
                </div>
                <div style={{ ...s.bpBookBtn, background: brandColor }}>Select & Book</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <button onClick={handleSave} disabled={saving} style={s.saveBtn}>
        {saving ? 'Saving...' : saved ? 'Saved' : 'Save changes'}
      </button>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <div style={s.fieldGroup}>
      <label style={s.fieldLabel}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={s.fieldInput}
      />
    </div>
  );
}

const s = {
  page: {
    padding: '16px 16px 32px',
    maxWidth: 480,
    margin: '0 auto',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
  },
  heroCard: {
    borderRadius: 16,
    padding: '24px 16px',
    textAlign: 'center',
    marginBottom: 16,
  },
  heroLogo: {
    width: 56,
    height: 56,
    borderRadius: 22,
    background: 'rgba(255,255,255,0.25)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 10px',
  },
  heroInitial: {
    // Inherits the hero's onBrand() colour. It hardcoded var(--bg-card), which
    // is near-white, and a pale brand made the monogram 2.45:1 against it.
    fontSize: 24,
    fontWeight: 700,
    color: 'inherit',
  },
  heroName: {
    display: 'block',
    fontSize: 18,
    fontWeight: 700,
    color: 'inherit',   // the hero sets onBrand(brandColor); a pale brand made
                        // this near-white name 3.48:1 against its own card
  },
  heroTagline: {
    display: 'block',
    fontSize: 12,
    color: 'inherit', opacity: 0.85,
    marginTop: 4,
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid var(--border, #E8DDD4)',
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    padding: '10px 0',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'inherit',
    textAlign: 'center',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  card: {
    background: 'var(--card-bg, #FFFCF9)',
    borderRadius: 16,
    padding: 16,
    border: '1px solid var(--border, #E8DDD4)',
  },
  cardLabel: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text, #241B17)',
    marginBottom: 2,
  },
  cardDesc: {
    display: 'block',
    fontSize: 12,
    color: 'var(--text-muted, #6B5D54)',
    marginBottom: 12,
  },
  fieldGroup: {
    background: 'var(--card-bg, #FFFCF9)',
    borderRadius: 16,
    padding: '12px 16px',
    border: '1px solid var(--border, #E8DDD4)',
  },
  fieldLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-muted, #6B5D54)',
    marginBottom: 4,
  },
  fieldInput: {
    width: '100%',
    padding: '8px 0',
    border: 'none',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text, #241B17)',
    boxSizing: 'border-box',
  },
  readOnlyRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    paddingTop: 4,
  },
  readOnlyValue: {
    fontSize: 15,
    fontWeight: 500,
    color: 'var(--text, #241B17)',
  },
  editLink: {
    alignSelf: 'flex-start',
    padding: 0,
    border: 'none',
    background: 'none',
    color: 'var(--accent, #92405e)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  colourGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 10,
    marginBottom: 12,
  },
  colourDot: {
    width: 36,
    height: 36,
    borderRadius: 16,
    cursor: 'pointer',
    transition: 'transform 0.15s',
  },
  customColour: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  customLabel: {
    fontSize: 12,
    color: 'var(--text-muted, #6B5D54)',
  },
  colourInput: {
    width: 30,
    height: 30,
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    padding: 0,
  },
  colourHex: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text, #241B17)',
    fontFamily: 'monospace',
  },
  logoUpload: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: '12px 0',
  },
  logoPlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 16,
    background: 'var(--bg, var(--bg, #FBF6F1))',
    border: '2px dashed var(--border, #E8DDD4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoIcon: { fontSize: 28 },
  uploadBtn: {
    padding: '8px 20px',
    borderRadius: 10,
    border: '1px solid var(--accent, #92405e)',
    background: 'transparent',
    color: 'var(--accent, #92405e)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  uploadHint: {
    fontSize: 11,
    color: 'var(--text-muted, #6B5D54)',
  },
  signOffInput: {
    width: '100%',
    marginTop: 10,
    padding: '11px 13px',
    borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    color: 'var(--text-primary, #241B17)',
    background: 'var(--bg-input, #F4EDE6)',
  },
  brandPreview: {
    borderRadius: 10,
    overflow: 'hidden',
    border: '1px solid var(--border, #E8DDD4)',
    marginTop: 8,
  },
  previewBar: {
    height: 4,
  },
  previewContent: {
    padding: '12px 14px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  previewName: {
    fontSize: 14,
    fontWeight: 700,
  },
  previewButton: {
    padding: '6px 14px',
    borderRadius: 10,
    color: 'var(--bg-card, #FFFCF9)',
    fontSize: 12,
    fontWeight: 600,
  },
  socialRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    background: 'var(--card-bg, #FFFCF9)',
    borderRadius: 16,
    border: '1px solid var(--border, #E8DDD4)',
  },
  socialIcon: { fontSize: 22 },
  socialLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-muted, #6B5D54)',
  },
  socialInput: {
    width: '100%',
    padding: '6px 0',
    border: 'none',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text, #241B17)',
    boxSizing: 'border-box',
  },
  socialNote: {
    fontSize: 12,
    color: 'var(--text-muted, #6B5D54)',
    textAlign: 'center',
    lineHeight: 1.5,
  },
  urlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    padding: '10px 12px',
    background: 'var(--bg, var(--bg, #FBF6F1))',
    borderRadius: 10,
  },
  urlText: {
    flex: 1,
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--accent, #92405e)',
  },
  copyBtn: {
    padding: '6px 14px',
    borderRadius: 10,
    border: '1px solid var(--accent, #92405e)',
    background: 'transparent',
    color: 'var(--accent, #92405e)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  shareGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 8,
    marginTop: 8,
  },
  shareBtn: {
    padding: '10px 0',
    borderRadius: 10,
    border: '1px solid var(--border, #E8DDD4)',
    background: 'var(--bg, var(--bg, #FBF6F1))',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: 'var(--text, #241B17)',
  },
  bookingPreview: {
    borderRadius: 10,
    overflow: 'hidden',
    border: '1px solid var(--border, #E8DDD4)',
    marginTop: 8,
  },
  bpHeader: {
    padding: '16px 14px 12px',
    textAlign: 'center',
  },
  bpName: {
    display: 'block',
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--bg-card, #FFFCF9)',
  },
  bpTagline: {
    display: 'block',
    fontSize: 11,
    color: '#ffffffBB',
    marginTop: 2,
  },
  bpBody: {
    padding: 12,
    background: 'var(--card-bg, #FFFCF9)',
  },
  bpService: {
    padding: '10px 0',
    borderBottom: '1px solid var(--border, #E8DDD4)',
  },
  bpServiceName: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text, #241B17)',
  },
  bpServiceMeta: {
    display: 'block',
    fontSize: 11,
    color: 'var(--text-muted, #6B5D54)',
    marginTop: 2,
  },
  bpBookBtn: {
    marginTop: 12,
    padding: '10px 0',
    borderRadius: 10,
    color: 'var(--bg-card, #FFFCF9)',
    fontSize: 13,
    fontWeight: 600,
    textAlign: 'center',
  },
  saveBtn: {
    width: '100%',
    padding: '14px 0',
    marginTop: 20,
    borderRadius: 10,
    border: 'none',
    background: 'linear-gradient(135deg, var(--accent, #92405e), var(--accent-hover, #782b49))',
    color: 'var(--bg-card, #FFFCF9)',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: 'var(--elev-2)',
  },
};
