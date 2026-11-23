import { fileURLToPath } from 'node:url';

// Run before Sharp loads Pango so the raster uses the shipped brand fonts,
// independent of the deployment image's installed fonts and cache location.
process.env.FONTCONFIG_FILE ||= fileURLToPath(new URL('./fonts/fonts.conf', import.meta.url));
process.env.PANGOCAIRO_BACKEND ||= 'fontconfig';
