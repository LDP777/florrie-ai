// Keep one native-sync entry point for local builds and Xcode Cloud.
process.argv.splice(2, 0, 'sync');
require('@capacitor/cli/bin/capacitor');
