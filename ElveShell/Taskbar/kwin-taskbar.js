// kwin-taskbar.js
// KWin script — runs inside KWin compositor.
// Pushes window lifecycle + state events to com.taskbar.KWin via D-Bus.
//
// Loaded/unloaded dynamically by kwin-backend.js (Node.js side).
// All communication is one-way: KWin → D-Bus service → Node.js.
// Window control commands go the other way: Node.js → qdbus → KWin DBus API.

const SERVICE   = "com.taskbar.KWin";
const OBJ_PATH  = "/TaskBar";
const INTERFACE = "com.taskbar.KWin";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendEvent(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    // callDBus is variadic: service, path, interface, method[, arg, arg, ..., callback]
    var callArgs = [SERVICE, OBJ_PATH, INTERFACE, method].concat(args);
    callDBus.apply(null, callArgs);
}

function windowData(w) {
    if (!w) return {};
    return {
        internalId : String(w.internalId  || ""),
        caption    : String(w.caption     || ""),
        appId      : String(w.resourceName || w.resourceClass || ""),
        resourceClass: String(w.resourceClass || ""),
        pid        : Number(w.pid         || 0),
        active     : Boolean(w.active),
        minimized  : Boolean(w.minimized),
        maximized  : Boolean(w.maximizable && (w.maximized === true)),
        fullscreen : Boolean(w.fullScreen),
        skipTaskbar: Boolean(w.skipTaskbar),
        specialWindow: Boolean(w.specialWindow),
        x          : Number(w.x          || 0),
        y          : Number(w.y          || 0),
        width      : Number(w.width      || 0),
        height     : Number(w.height     || 0)
    };
}

// Serialize to JSON string — KWin's callDBus only passes simple scalars,
// so we pack everything into a single string argument.
function emit(method, w) {
    var data = windowData(w);
    var json = JSON.stringify(data);
    sendEvent(method, json);
}

// ─── Skip non-taskbar windows ─────────────────────────────────────────────────

function isTaskbarWindow(w) {
    if (!w) return false;
    if (w.skipTaskbar)    return false;
    if (w.specialWindow)  return false;
    if (!w.managed)       return false;
    return true;
}

// ─── Initial snapshot ─────────────────────────────────────────────────────────
// Send the full window list once on startup so the Node side can seed its Map.

function sendSnapshot() {
    var wins = workspace.windowList();
    var list = [];
    for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (isTaskbarWindow(w)) {
            list.push(windowData(w));
        }
    }
    sendEvent("Snapshot", JSON.stringify(list));
}

// Give KWin a tick to settle before sending the snapshot.
// (callDBus is async; the service may not be listening yet either — the
//  Node side retries, but a small delay prevents a lost first call.)
workspace.windowAdded.connect(function() {}); // force script to stay loaded
sendSnapshot();

// ─── Live events ──────────────────────────────────────────────────────────────

workspace.windowAdded.connect(function(w) {
    if (!isTaskbarWindow(w)) return;
    emit("WindowAdded", w);
    hookWindow(w);
});

workspace.windowRemoved.connect(function(w) {
    // specialWindow check might already be false for a removed window; send anyway.
    var data = windowData(w);
    sendEvent("WindowRemoved", JSON.stringify(data));
});

// Active window changed
workspace.windowActivated.connect(function(w) {
    if (!w) {
        sendEvent("WindowActivated", "{}");
        return;
    }
    emit("WindowActivated", w);
});

// ─── Per-window signal hooks ──────────────────────────────────────────────────

function hookWindow(w) {
    if (!w) return;

    w.captionChanged.connect(function() {
        emit("TitleChanged", w);
    });

    w.minimizedChanged.connect(function() {
        emit("StateChanged", w);
    });

    w.maximizedAboutToChange.connect(function() {
        emit("StateChanged", w);
    });

    w.fullScreenChanged.connect(function() {
        emit("StateChanged", w);
    });

    w.moveResizedChanged.connect(function() {
        emit("GeometryChanged", w);
    });
}

// Hook windows already open when the script loads.
(function() {
    var wins = workspace.windowList();
    for (var i = 0; i < wins.length; i++) {
        hookWindow(wins[i]);
    }
})();