#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift plugin with Capacitor's runtime.
CAP_PLUGIN(FlorrieLiveActivity, "FlorrieLiveActivity",
    CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(end, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(isRunning, CAPPluginReturnPromise);
)
