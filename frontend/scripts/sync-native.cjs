// Capacitor 6 imports tar's removed default export. Keep the patched tar 7
// dependency and provide that alias within this CLI process only.
const tarPath = require.resolve('tar');
const tar = require(tarPath);
if (!tar.default && typeof tar.extract === 'function') {
  require.cache[tarPath].exports = { ...tar, default: tar };
}
process.argv.splice(2, 0, 'sync');
require('@capacitor/cli/bin/capacitor');
