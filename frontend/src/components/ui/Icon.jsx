/**
 * Icon — the app's only icon set.
 *
 * Emoji were doing this job across ~680 sites. They render as a different
 * picture on every OS, cannot be tinted, cannot be optically aligned, and carry
 * a texture that belongs to text messages rather than software. Everything here
 * is one stroke weight, sized in a square box, and inherits currentColor, so an
 * icon always matches the text beside it.
 *
 *   <Icon name="calendar" />                 18px, currentColor
 *   <Icon name="pound" size={22} />
 *   <Icon name="check" style={{ color: 'var(--success)' }} />
 *   <Icon name={TYPE_ICONS[row.type]} />     name held in data
 *
 * Unknown names render nothing rather than throwing, so a stale name in stored
 * data degrades to an empty box instead of a white screen.
 */

// 24x24 viewBox. Paths only, no fills: the wrapper sets stroke + linecap.
const PATHS = {
  // structure
  calendar: 'M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v11a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 17.5zM4 9.5h16M8.5 2.8v3.4M15.5 2.8v3.4',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7.2V12l3.2 2.1',
  'map-pin': 'M12 21s6.5-5.6 6.5-10.2A6.5 6.5 0 005.5 10.8C5.5 15.4 12 21 12 21zM12 12.4a2 2 0 100-4 2 2 0 000 4z',
  folder: 'M3.5 7.2A2.2 2.2 0 015.7 5h3.1l2 2.4h7.5a2.2 2.2 0 012.2 2.2v7.2a2.2 2.2 0 01-2.2 2.2H5.7a2.2 2.2 0 01-2.2-2.2z',
  file: 'M6 3.6h7l5 5v11.8a1 1 0 01-1 1H6a1 1 0 01-1-1V4.6a1 1 0 011-1zM13 3.6v5h5M8 13h8M8 16.5h5',
  list: 'M4 6.5h1.6M4 12h1.6M4 17.5h1.6M9 6.5h11M9 12h11M9 17.5h11',
  grid: 'M4 4.5h6v6H4zM14 4.5h6v6h-6zM4 13.5h6v6H4zM14 13.5h6v6h-6z',
  inbox: 'M3.5 12.5L6 5.4A2 2 0 017.9 4h8.2a2 2 0 011.9 1.4l2.5 7.1M3.5 12.5v5A2 2 0 005.5 19.5h13a2 2 0 002-2v-5M3.5 12.5H8l1.3 2.4h5.4L16 12.5h4.5',

  // people
  user: 'M12 12.4a3.9 3.9 0 100-7.8 3.9 3.9 0 000 7.8zM4.6 20.2a7.6 7.6 0 0114.8 0',
  users: 'M9.4 11.6a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.8 19.6a6.8 6.8 0 0113.2 0M16.4 5.1a3.5 3.5 0 010 6.4M18 13.6a6.8 6.8 0 013.2 5',

  // messaging
  message: 'M4 8.4A3.4 3.4 0 017.4 5h9.2A3.4 3.4 0 0120 8.4v5.2a3.4 3.4 0 01-3.4 3.4H10l-4.6 3.4v-3.6A3.4 3.4 0 014 13.6z',
  send: 'M20.4 3.6L3.9 9.9a.5.5 0 00-.05.92l6.6 3.06a.9.9 0 01.44.44l3.06 6.6a.5.5 0 00.92-.05zM20.4 3.6l-9.9 9.9',
  mail: 'M3.5 7.4A2.4 2.4 0 015.9 5h12.2a2.4 2.4 0 012.4 2.4v9.2a2.4 2.4 0 01-2.4 2.4H5.9a2.4 2.4 0 01-2.4-2.4zM3.9 7.1l7.3 5.1a1.4 1.4 0 001.6 0l7.3-5.1',
  phone: 'M8 3.8h8a1.8 1.8 0 011.8 1.8v12.8A1.8 1.8 0 0116 20.2H8a1.8 1.8 0 01-1.8-1.8V5.6A1.8 1.8 0 018 3.8zM10.6 17.2h2.8',
  bell: 'M6.4 10.2a5.6 5.6 0 0111.2 0c0 3.4.9 5 1.7 5.9a.6.6 0 01-.44 1H5.14a.6.6 0 01-.44-1c.8-.9 1.7-2.5 1.7-5.9zM10 20a2.3 2.3 0 004 0',

  // money
  pound: 'M15.6 6.2A3.4 3.4 0 009.3 8v3.6M7.4 11.6h5.4M7.4 18.2h9M7.4 18.2c1.5-1.1 1.9-2.6 1.9-4.3',
  card: 'M3 8A2.5 2.5 0 015.5 5.5h13A2.5 2.5 0 0121 8v8a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 16zM3 10.2h18M6.6 14.6h3',
  wallet: 'M3.6 7.6A2.1 2.1 0 015.7 5.5h11.6a2.1 2.1 0 012.1 2.1v1.1M3.6 7.6v9.3a2.1 2.1 0 002.1 2.1h13.5a1.2 1.2 0 001.2-1.2v-6.6a1.2 1.2 0 00-1.2-1.2H5.7a2.1 2.1 0 01-2.1-2.1zM17 14.2h.01',
  chart: 'M5 19.4V11M12 19.4V5.6M19 19.4v-5.8',
  'trending-up': 'M3.6 16.4l5.4-5.4 3.4 3.4 7.6-7.6M15.4 6.8h4.6v4.6',
  'trending-down': 'M3.6 7.6L9 13l3.4-3.4 7.6 7.6M15.4 17.2h4.6v-4.6',

  // actions
  check: 'M4.6 12.6l4.7 4.6L19.4 6.8',
  'check-circle': 'M12 21a9 9 0 100-18 9 9 0 000 18zM8.2 12.1l2.7 2.7 5-5.4',
  'check-check': 'M2.6 12.6l3.5 3.5 6.3-7M10.6 15.6l1.4 1.4 7.4-8',
  x: 'M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8',
  plus: 'M12 5.2v13.6M5.2 12h13.6',
  minus: 'M5.2 12h13.6',
  edit: 'M4.5 19.5h3.4L18.3 9.1a1.9 1.9 0 000-2.7l-.7-.7a1.9 1.9 0 00-2.7 0L4.5 16.1zM14.2 6.6l3.2 3.2',
  trash: 'M4.5 7h15M9.4 7V5.4a1.4 1.4 0 011.4-1.4h2.4a1.4 1.4 0 011.4 1.4V7M6.6 7l.9 11.4a1.6 1.6 0 001.6 1.5h5.8a1.6 1.6 0 001.6-1.5L17.4 7M10.4 11v5M13.6 11v5',
  copy: 'M8.6 8.6A2 2 0 0110.6 6.6h7A2 2 0 0119.6 8.6v7a2 2 0 01-2 2h-7a2 2 0 01-2-2zM15.4 6.6V5.4a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h1.2',
  share: 'M12 15.4V3.8M8.2 7.4L12 3.6l3.8 3.8M5 13.4v5.2a1.8 1.8 0 001.8 1.8h10.4a1.8 1.8 0 001.8-1.8v-5.2',
  download: 'M12 3.8v11.6M8.2 11.8l3.8 3.8 3.8-3.8M5 15.4v3.2a1.8 1.8 0 001.8 1.8h10.4a1.8 1.8 0 001.8-1.8v-3.2',
  upload: 'M12 20.2V8.6M8.2 12.4L12 8.6l3.8 3.8M5 6.6V5.4a1.8 1.8 0 011.8-1.8h10.4A1.8 1.8 0 0119 5.4v1.2',
  link: 'M10.2 13.8a3.6 3.6 0 005.4.4l2.6-2.6a3.6 3.6 0 00-5.1-5.1l-1.5 1.5M13.8 10.2a3.6 3.6 0 00-5.4-.4l-2.6 2.6a3.6 3.6 0 005.1 5.1l1.5-1.5',
  refresh: 'M20 11.4A8 8 0 006.3 6.3L4 8.6M4 12.6a8 8 0 0013.7 5.1L20 15.4M4 4.6v4h4M20 19.4v-4h-4',
  repeat: 'M4.6 9.4A3.4 3.4 0 018 6h11.4M16.4 2.8L19.6 6l-3.2 3.2M19.4 14.6A3.4 3.4 0 0116 18H4.6M7.6 21.2L4.4 18l3.2-3.2',
  undo: 'M4.4 9.6h9.8a5.2 5.2 0 010 10.4H9M4.4 9.6l4-4M4.4 9.6l4 4',
  play: 'M8.4 5.4l9.4 6.6-9.4 6.6z',
  pause: 'M9.2 5.2v13.6M14.8 5.2v13.6',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM16.1 16.1l4 4',
  filter: 'M4 6h16l-6.2 7.2v5.4l-3.6 1.8v-7.2z',
  eye: 'M2.6 12S6.4 5.6 12 5.6 21.4 12 21.4 12 17.6 18.4 12 18.4 2.6 12 2.6 12zM12 14.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.2 14.2a1.5 1.5 0 00.3 1.7l.06.06a1.8 1.8 0 11-2.56 2.56l-.06-.06a1.5 1.5 0 00-1.7-.3 1.5 1.5 0 00-.9 1.37v.17a1.8 1.8 0 11-3.6 0v-.09a1.5 1.5 0 00-.98-1.37 1.5 1.5 0 00-1.7.3l-.06.06a1.8 1.8 0 11-2.56-2.56l.06-.06a1.5 1.5 0 00.3-1.7 1.5 1.5 0 00-1.37-.9h-.17a1.8 1.8 0 110-3.6h.09a1.5 1.5 0 001.37-.98 1.5 1.5 0 00-.3-1.7l-.06-.06A1.8 1.8 0 118.32 3.5l.06.06a1.5 1.5 0 001.7.3h.07a1.5 1.5 0 00.9-1.37v-.17a1.8 1.8 0 113.6 0v.09a1.5 1.5 0 00.9 1.37 1.5 1.5 0 001.7-.3l.06-.06a1.8 1.8 0 112.56 2.56l-.06.06a1.5 1.5 0 00-.3 1.7v.07a1.5 1.5 0 001.37.9h.17a1.8 1.8 0 010 3.6h-.09a1.5 1.5 0 00-1.37.9z',
  sliders: 'M4.6 8.4h7M15.4 8.4h4M4.6 15.6h4M12.4 15.6h7M13.4 5.6v5.6M8.8 12.8v5.6',
  lock: 'M6.4 10.6h11.2a1.6 1.6 0 011.6 1.6v6.4a1.6 1.6 0 01-1.6 1.6H6.4a1.6 1.6 0 01-1.6-1.6v-6.4a1.6 1.6 0 011.6-1.6zM8.2 10.6V7.8a3.8 3.8 0 017.6 0v2.8',
  shield: 'M12 3.4l7 2.6v5.4c0 4.2-2.9 7.4-7 9.2-4.1-1.8-7-5-7-9.2V6z',

  // meaning
  star: 'M12 3.6l2.66 5.58 5.94.8-4.3 4.32 1.06 6.1L12 17.5l-5.36 2.9 1.06-6.1L3.4 9.98l5.94-.8z',
  sparkle: 'M12 3.4l1.9 5.2 5.2 1.9-5.2 1.9-1.9 5.2-1.9-5.2-5.2-1.9 5.2-1.9z',
  sparkles: 'M10 3.4l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5zM17.4 13.4l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z',
  heart: 'M12 19.8S4.2 15.4 4.2 9.9A4.1 4.1 0 0112 7.6a4.1 4.1 0 017.8 2.3c0 5.5-7.8 9.9-7.8 9.9z',
  // The brand mark: five petals around a gold heart. This is the glyph that
  // means "Florrie did this", so it is the bloom, not a generic asterisk.
  flower: 'M9.06 7.00a2.94 2.94 0 1 0 5.88 0a2.94 2.94 0 1 0 -5.88 0M13.82 10.45a2.94 2.94 0 1 0 5.88 0a2.94 2.94 0 1 0 -5.88 0M12.00 16.05a2.94 2.94 0 1 0 5.88 0a2.94 2.94 0 1 0 -5.88 0M6.12 16.05a2.94 2.94 0 1 0 5.88 0a2.94 2.94 0 1 0 -5.88 0M4.31 10.45a2.94 2.94 0 1 0 5.88 0a2.94 2.94 0 1 0 -5.88 0M10.50 12.00a1.50 1.50 0 1 0 3.00 0a1.50 1.50 0 1 0 -3.00 0',
  gift: 'M4.4 11.4h15.2v7.4a1.4 1.4 0 01-1.4 1.4H5.8a1.4 1.4 0 01-1.4-1.4zM3.6 7.8h16.8v3.6H3.6zM12 7.8v12.4M12 7.8S10.9 3.6 8.6 3.6a2.1 2.1 0 000 4.2zM12 7.8s1.1-4.2 3.4-4.2a2.1 2.1 0 010 4.2z',
  tag: 'M11.4 3.8H5.2a1.4 1.4 0 00-1.4 1.4v6.2a1.4 1.4 0 00.41.99l7.8 7.8a1.4 1.4 0 001.98 0l6.2-6.2a1.4 1.4 0 000-1.98l-7.8-7.8a1.4 1.4 0 00-.99-.41zM8 8h.01',
  flag: 'M5.2 20.4V4.4M5.2 5.4h11.2l-1.8 3.6 1.8 3.6H5.2',
  moon: 'M20 13.6A8.4 8.4 0 019.4 3.4a8.6 8.6 0 100 17.2 8.4 8.4 0 0010.6-7z',
  sun: 'M12 16.6a4.6 4.6 0 100-9.2 4.6 4.6 0 000 9.2zM12 2.4v2M12 19.6v2M4.4 4.4l1.4 1.4M18.2 18.2l1.4 1.4M2.4 12h2M19.6 12h2M4.4 19.6l1.4-1.4M18.2 5.8l1.4-1.4',
  'alert-triangle': 'M10.7 4.3L3.2 17a1.5 1.5 0 001.3 2.3h15a1.5 1.5 0 001.3-2.3L13.3 4.3a1.5 1.5 0 00-2.6 0zM12 9.4v4M12 16.4h.01',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16.2v-4.6M12 8h.01',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16.6a4.6 4.6 0 100-9.2 4.6 4.6 0 000 9.2zM12 12.2h.01',
  camera: 'M3.6 8.8a2 2 0 012-2h1.9l1.3-2.2h6.4l1.3 2.2h1.9a2 2 0 012 2v8.4a2 2 0 01-2 2H5.6a2 2 0 01-2-2zM12 16.4a3.6 3.6 0 100-7.2 3.6 3.6 0 000 7.2',
  image: 'M4 6.4A2.4 2.4 0 016.4 4h11.2A2.4 2.4 0 0120 6.4v11.2a2.4 2.4 0 01-2.4 2.4H6.4A2.4 2.4 0 014 17.6zM8.6 10.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8M4.4 16.6l4.8-4.4 4 3.6 2.6-2.2 3.8 3.4',
  palette: 'M12 20.4a8.4 8.4 0 110-16.8c4.64 0 8.4 3.2 8.4 7.1 0 2.3-1.9 3.5-3.9 3.5h-1.7a1.9 1.9 0 00-1.3 3.3 1.6 1.6 0 01-1.5 2.9zM7.6 11.4h.01M10.6 8h.01M15 8.4h.01',
  scissors: 'M7 8.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2zM7 20.6a2.6 2.6 0 100-5.2 2.6 2.6 0 000 5.2zM19.4 4.4L8.9 17M8.9 7L19.4 19.6',
  coffee: 'M4.4 8.2h12.2v6.2a4.4 4.4 0 01-8.8 0zM16.6 9.4h1.6a2.4 2.4 0 010 4.8h-1.6M4.4 19.6h12.2',
  mic: 'M12 3.4a2.6 2.6 0 012.6 2.6v5.4a2.6 2.6 0 01-5.2 0V6A2.6 2.6 0 0112 3.4zM6.4 11a5.6 5.6 0 0011.2 0M12 16.6v4M9.4 20.6h5.2',

  // direction
  'chevron-right': 'M9.4 5.6l6.4 6.4-6.4 6.4',
  'chevron-left': 'M14.6 5.6L8.2 12l6.4 6.4',
  'chevron-down': 'M5.6 9.4L12 15.8l6.4-6.4',
  'chevron-up': 'M5.6 14.6L12 8.2l6.4 6.4',
  'arrow-right': 'M4.4 12h15.2M13.4 5.8l6.2 6.2-6.2 6.2',
  'arrow-left': 'M19.6 12H4.4M10.6 5.8L4.4 12l6.2 6.2',
  'arrow-up': 'M12 19.6V4.4M5.8 10.6L12 4.4l6.2 6.2',
  'arrow-down': 'M12 4.4v15.2M5.8 13.4L12 19.6l6.2-6.2',
  'arrow-up-right': 'M6.6 17.4L17.4 6.6M8.2 6.6h9.2v9.2',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  'arrow-down-left': 'M17.4 6.6L6.6 17.4M15.8 17.4H6.6V8.2',

  // Added for the Material Symbols retirement: shapes that set had and this
  // one did not. Several are salon vocabulary (spray bottle, syringe) that no
  // general-purpose icon set carries.
  circle: 'M12 21a9 9 0 100-18 9 9 0 000 18z',
  flame: 'M12 21c3.4 0 6.2-2.6 6.2-5.9 0-4.3-4.3-6.2-4.3-9.4 0-1-.3-1.9-.9-2.7-2 1.5-3.2 3.5-3.2 5.6 0 1.3.5 2.2.5 3 0 1-.8 1.8-1.7 1.8-1 0-1.8-.9-1.8-2.3v-.5C5.6 11.9 5.8 13 5.8 15.1 5.8 18.4 8.6 21 12 21z',
  'shopping-bag': 'M5.4 8.2h13.2l-1 11a1.8 1.8 0 01-1.8 1.6H8.2a1.8 1.8 0 01-1.8-1.6zM8.8 11V6.9a3.2 3.2 0 016.4 0V11',
  syringe: 'M14.6 3.4l6 6M18.4 5.6l-2.2 2.2M9.4 8.6l6 6M8.2 9.8l-4 4v5.4h5.4l4-4M5.6 14.6l1.6 1.6M8.2 12l1.6 1.6',
  spray: 'M9 8.4h5.2a1.8 1.8 0 011.8 1.8v8.4a1.8 1.8 0 01-1.8 1.8H9a1.8 1.8 0 01-1.8-1.8v-8.4A1.8 1.8 0 019 8.4zM9.6 8.4V5.2h4M14.2 3.6h2.4M18 5.4h.01M18 8.4h.01M20.4 6.9h.01',
  broom: 'M13.4 3.6l4.4 4.4M15.6 5.8l-8.2 8.2 3.6 3.6 8.2-8.2M7.4 14l-4 6.4 6.4-4M9.6 16.2l2-2',
  thermometer: 'M12.6 4.8a2.2 2.2 0 014.4 0v8.1a4 4 0 11-4.4 0zM8.6 7.6H4.4M8.6 12H5.8M8.6 16.4H4.4',
  // Weather. The Campaigns screen has a "rain brings people in" campaign type
  // and there was no cloud in the set, so it was wearing a thermometer.
  cloud: 'M7 18.2h10.2a3.8 3.8 0 00.4-7.6 5.6 5.6 0 00-10.8-1.2A3.9 3.9 0 007 18.2z',
  'cloud-rain': 'M7.4 15.2h9.8a3.6 3.6 0 00.4-7.2 5.4 5.4 0 00-10.4-1.1 3.7 3.7 0 00.2 8.3M8.6 18.4l-.8 2.2M12.4 18.4l-.8 2.2M16.2 18.4l-.8 2.2',
  box: 'M3.6 8.2l8.4-4.6 8.4 4.6v7.6L12 20.4l-8.4-4.6zM3.6 8.2L12 12.8l8.4-4.6M12 12.8v7.6',
  receipt: 'M5.6 3.6h12.8v16.8l-2.6-1.6-2.6 1.6-2.6-1.6-2.4 1.6-2.6-1.6zM9 8h6M9 12h6',
  book: 'M4.2 5.4a1.8 1.8 0 011.8-1.8H11v15.6H6a1.8 1.8 0 00-1.8 1.8zM19.8 5.4a1.8 1.8 0 00-1.8-1.8H13v15.6h5a1.8 1.8 0 011.8 1.8z',
  badge: 'M12 14.4a5.4 5.4 0 100-10.8 5.4 5.4 0 000 10.8zM8.4 13.4L7 21l5-2.6L17 21l-1.4-7.6',
  'plus-circle': 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 8.2v7.6M8.2 12h7.6',
  'search-off': 'M18.2 18.2a7 7 0 00-9.4-10.2M6.6 6.6a7 7 0 009.4 10.2M20.4 20.4l-4.4-4.4M3.6 3.6l16.8 16.8',
  bookmark: 'M6.2 4.8A1.4 1.4 0 017.6 3.4h8.8a1.4 1.4 0 011.4 1.4v15.4L12 16.8l-5.8 3.4z',
  hand: 'M8.4 11V5.6a1.6 1.6 0 013.2 0v4.6M11.6 10.2V4.4a1.6 1.6 0 113.2 0v5.8M14.8 10.6V6.8a1.6 1.6 0 113.2 0v7.4a6.4 6.4 0 01-6.4 6.4h-.8a5.6 5.6 0 01-4.4-2.2l-2.8-3.7a1.6 1.6 0 012.4-2.1l2 2',
};

// Small filled marks. Stroke rendering makes a status dot look hollow, so these
// opt out and paint a fill instead.
const FILLED = {
  dot: 'M12 17.2a5.2 5.2 0 100-10.4 5.2 5.2 0 000 10.4z',
};

export default function Icon({
  name,
  size,
  strokeWidth = 1.6,
  color,
  filled = false,
  inline = false,
  style,
  className,
  title,
}) {
  const d = PATHS[name];
  const f = FILLED[name];
  if (!d && !f) return null;

  // Material glyphs were text, so a lot of call sites express their size as
  // `fontSize` inside a shared style object. Honour that when no explicit size
  // is given, so those sites keep the size they were designed at.
  const px = size ?? (typeof style?.fontSize === 'number' ? style.fontSize : 18);

  const common = {
    width: px,
    height: px,
    viewBox: '0 0 24 24',
    className,
    style: {
      flex: '0 0 auto',
      // Material glyphs were text, so they sat on the baseline beside a label.
      // `inline` keeps that behaviour for the call sites that relied on it.
      display: inline ? 'inline-block' : 'block',
      verticalAlign: inline ? 'middle' : undefined,
      color,
      ...style,
    },
    role: title ? 'img' : undefined,
    'aria-label': title || undefined,
    'aria-hidden': title ? undefined : true,
    focusable: 'false',
  };

  if (f) return <svg {...common} fill="currentColor" stroke="none"><path d={f} /></svg>;

  return (
    <svg
      {...common}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* `filled` is the active state the Material FILL axis used to carry (the
          bottom nav, the checklist tabs). A wash inside the same outline reads
          as filled at 20px without needing a second path for every glyph. */}
      {filled && <path d={d} fill="currentColor" fillOpacity={0.2} stroke="none" />}
      <path d={d} />
    </svg>
  );
}

/**
 * Legacy emoji bridge.
 *
 * Some icon values arrive from the server ("Florrie thinks" cards) or from rows
 * stored before the icon set existed, so they are still emoji. This maps the
 * ones actually in use onto icon names and falls back to the brand bloom, which
 * means no call site has to care which era its data came from.
 */
const FROM_EMOJI = {
  '\u{1F327}': 'cloud-rain', '\u2614': 'cloud-rain', '\u{1F326}': 'cloud-rain',
  '\u2601': 'cloud', '\u{1F328}': 'cloud',

  '\u{1F4C5}': 'calendar', '\u{1F5D3}\u{FE0F}': 'calendar', '\u{1F5D3}': 'calendar',
  '\u{1F4AC}': 'message', '\u{1F4E8}': 'send', '\u{1F4E3}': 'send', '\u{1F4E7}': 'mail',
  '\u{2709}\u{FE0F}': 'mail', '\u{2709}': 'mail', '\u{1F48C}': 'mail', '\u{1F4F1}': 'phone',
  '\u{1F4DE}': 'phone', '\u{1F4EC}': 'inbox', '\u{1F4ED}': 'inbox',
  '\u{26A0}\u{FE0F}': 'alert-triangle', '\u{26A0}': 'alert-triangle', '\u{1F6A8}': 'alert-triangle',
  '\u{1F915}': 'alert-triangle', '\u{1F912}': 'alert-triangle', '\u{1FA7A}': 'syringe',
  '\u{2705}': 'check-circle', '\u{2611}\u{FE0F}': 'check-circle', '\u{2713}': 'check', '\u{2714}': 'check',
  '\u{274C}': 'x', '\u{2715}': 'x', '\u{2717}': 'x', '\u{1F6AB}': 'x',
  '\u{1F504}': 'refresh', '\u{21BB}': 'refresh',
  '\u{2728}': 'sparkles', '\u{26A1}': 'sparkles', '\u{1F4A1}': 'info', '\u{2139}\u{FE0F}': 'info',
  '\u{2753}': 'info', '\u{1F916}': 'sparkles', '\u{1F48E}': 'sparkles', '\u{1F485}': 'sparkles',
  '\u{1F484}': 'sparkles', '\u{1F9F9}': 'sparkles',
  '\u{1F39F}\u{FE0F}': 'tag', '\u{1F3F7}\u{FE0F}': 'tag', '\u{1F3AB}': 'tag', '\u{1F6CD}': 'shopping-bag',
  '\u{1F495}': 'heart', '\u{2665}': 'heart', '\u{1F49C}': 'heart', '\u{1F44B}': 'hand', '\u{1F48B}': 'heart',
  '\u{270D}\u{FE0F}': 'edit', '\u{1F4DD}': 'edit', '\u{270F}\u{FE0F}': 'edit', '\u{270E}': 'edit',
  '\u{1F58A}\u{FE0F}': 'edit', '\u{1F9FE}': 'receipt', '\u{1F4C4}': 'file', '\u{1F4DA}': 'book',
  '\u{1F4D2}': 'file', '\u{1F4D6}': 'book', '\u{1F4DC}': 'file', '\u{1F393}': 'book', '\u{1F5D2}\u{FE0F}': 'file',
  '\u{2B50}': 'star', '\u{2605}': 'star', '\u{2606}': 'star', '\u{1F3C6}': 'badge', '\u{1F3C5}': 'badge',
  '\u{1F31F}': 'star',
  '\u{1F4B7}': 'pound', '\u{1F4B5}': 'pound', '\u{1FA99}': 'pound', '\u{1F4B0}': 'wallet',
  '\u{1F3E6}': 'wallet', '\u{1F4B3}': 'card',
  '\u{1F399}\u{FE0F}': 'mic', '\u{1F464}': 'user', '\u{1F465}': 'users', '\u{1F91D}': 'users',
  '\u{1F9D6}': 'users', '\u{1F440}': 'eye', '\u{1F441}\u{FE0F}': 'eye',
  '\u{1F319}': 'moon', '\u{1F4A4}': 'moon', '\u{2600}\u{FE0F}': 'sun', '\u{1F3D6}\u{FE0F}': 'sun',
  '\u{23F1}\u{FE0F}': 'clock', '\u{23F3}': 'clock', '\u{23F0}': 'clock', '\u{1F550}': 'clock', '\u{23F1}': 'clock',
  '\u{1F381}': 'gift', '\u{1F389}': 'sparkles', '\u{1F382}': 'gift', '\u{1F384}': 'gift',
  '\u{1F337}': 'flower', '\u{1F338}': 'flower', '\u{1F486}': 'flower', '\u{1F9F4}': 'flower',
  '\u{1F331}': 'flower', '\u{1F36F}': 'flower',
  '\u{1F4CA}': 'chart', '\u{1F4C8}': 'trending-up', '\u{1F525}': 'flame', '\u{1F4C9}': 'trending-down',
  '\u{1F4F8}': 'camera', '\u{1F4F7}': 'camera', '\u{1F3A8}': 'palette', '\u{1F58C}\u{FE0F}': 'palette',
  '\u{1F517}': 'link', '\u{1F310}': 'link', '\u{1F4BB}': 'link', '\u{1F50C}': 'link', '\u{1FA9D}': 'link',
  '\u{1F4CB}': 'list', '\u{1F4E5}': 'download', '\u{1F4E4}': 'share', '\u{1F4E6}': 'box',
  '\u{1F4CD}': 'map-pin', '\u{1F4CC}': 'map-pin', '\u{1F3E0}': 'map-pin', '\u{1F3E2}': 'map-pin', '\u{1F697}': 'map-pin',
  '\u{1F527}': 'sliders', '\u{1F6E0}\u{FE0F}': 'sliders', '\u{1F9F0}': 'sliders',
  '\u{1F6E1}\u{FE0F}': 'shield', '\u{1FA79}': 'shield', '\u{1F512}': 'lock', '\u{1F510}': 'lock',
  '\u{1F514}': 'bell', '\u{1F515}': 'bell', '\u{1F50D}': 'search', '\u{2699}\u{FE0F}': 'settings',
  '\u{1F5D1}\u{FE0F}': 'trash', '\u{25B6}\u{FE0F}': 'play', '\u{270B}': 'pause', '\u{21A9}': 'undo',
  '\u{1F37D}\u{FE0F}': 'coffee', '\u{1F37D}': 'coffee', '\u{2615}': 'coffee',
  '\u{2691}': 'flag', '\u{1F3AF}': 'target', '\u{1FAAE}': 'scissors', '\u{1F487}': 'scissors',
  '\u{1F7E2}': 'dot', '\u{1F534}': 'dot', '\u{25CF}': 'dot',
};

/**
 * Material Symbols bridge.
 *
 * The app carried a second icon system: Google's Material Symbols Outlined, a
 * variable font loaded with display=block (so it blocked icon paint) and used
 * at ~150 sites. Retiring it means those names live on in data - nav tables,
 * checklist templates, category maps, and a user's localStorage recents. This
 * maps them, so those structures keep working untouched.
 */
const FROM_MATERIAL = {
  close: 'x', add: 'plus', check: 'check', check_circle: 'check-circle', task_alt: 'check-circle',
  radio_button_unchecked: 'circle', edit: 'edit', edit_note: 'edit', delete: 'trash',
  download: 'download', upload: 'upload', search: 'search', search_off: 'search-off',
  chevron_right: 'chevron-right', chevron_left: 'chevron-left', expand_less: 'chevron-up',
  expand_more: 'chevron-down', keyboard_arrow_up: 'chevron-up', keyboard_arrow_down: 'chevron-down',
  keyboard_arrow_right: 'chevron-right', keyboard_arrow_left: 'chevron-left',
  arrow_back: 'arrow-left', arrow_back_ios_new: 'chevron-left', arrow_forward: 'arrow-right',
  open_in_browser: 'arrow-up-right', open_in_new: 'arrow-up-right',
  star: 'star', reviews: 'star', workspace_premium: 'badge', military_tech: 'badge',
  info: 'info', help: 'info', lightbulb: 'info', warning: 'alert-triangle', error: 'alert-triangle',
  pause: 'pause', play_arrow: 'play', restart_alt: 'refresh', replay: 'refresh', autorenew: 'refresh',
  sync: 'refresh', schedule: 'clock', hourglass_empty: 'clock', history: 'clock', timer: 'clock',
  today: 'calendar', calendar_today: 'calendar', calendar_month: 'calendar', event_note: 'calendar',
  event_available: 'check-circle', event_busy: 'calendar', calendar_view_week: 'grid',
  trending_up: 'trending-up', trending_down: 'trending-down', analytics: 'chart', bar_chart: 'chart',
  content_cut: 'scissors', photo_camera: 'camera', image: 'image', print: 'file',
  checklist: 'list', format_list_bulleted: 'list', notes: 'file', description: 'file',
  assignment: 'file', receipt_long: 'receipt', menu_book: 'book', school: 'book', gavel: 'book',
  payments: 'pound', savings: 'wallet', account_balance_wallet: 'wallet', money_off: 'trending-down',
  card_membership: 'card', card_giftcard: 'gift', local_offer: 'tag', loyalty: 'tag',
  shopping_bag: 'shopping-bag', inventory: 'box', inventory_2: 'box',
  people: 'users', group: 'users', groups: 'users', person: 'user', person_add: 'user',
  forum: 'message', chat: 'message', sms: 'message', mail: 'mail', outbox: 'send', campaign: 'send',
  notifications: 'bell', notifications_off: 'bell', settings: 'settings', tune: 'sliders',
  smartphone: 'phone', call: 'phone', lock: 'lock', verified_user: 'shield', verified: 'check-circle',
  visibility: 'eye', visibility_off: 'eye', flag: 'flag', bookmark: 'bookmark',
  spa: 'flower', self_care: 'flower', auto_fix_high: 'sparkles', auto_awesome: 'sparkles',
  auto_awesome_motion: 'sparkles', bolt: 'sparkle', celebration: 'sparkles',
  local_fire_department: 'flame', wb_sunny: 'sun', nightlight: 'moon', beach_access: 'sun',
  volunteer_activism: 'heart', waving_hand: 'hand', favorite: 'heart',
  vaccines: 'syringe', sanitizer: 'spray', cleaning_services: 'broom', dry_cleaning: 'broom',
  device_thermostat: 'thermometer', add_circle: 'plus-circle', apps: 'grid', mic: 'mic',
  location_city: 'map-pin', place: 'map-pin', link: 'link', folder: 'folder',
};

/**
 * Resolve a stored value to an icon name. Accepts an icon name, a Material
 * Symbols name, a legacy emoji, or nothing, and always returns something
 * renderable.
 */
export function iconName(value, fallback = 'flower') {
  if (!value) return fallback;
  if (PATHS[value] || FILLED[value]) return value;
  if (FROM_MATERIAL[value]) return FROM_MATERIAL[value];
  return FROM_EMOJI[value] || FROM_EMOJI[value.replace('\uFE0F', '')] || fallback;
}

export const ICON_NAMES = [...Object.keys(PATHS), ...Object.keys(FILLED)];
