// native/x11_input_region.cc
// N-API C++-style (using node_api.h C API) addon to set X11 ShapeInput region based on rects array.
// Exports: setPID(pid), setInputRegion(rects), clearInputRegion()

#include <node_api.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/shape.h>
#include <X11/Xutil.h>
#include <pthread.h>
#include <vector>
#include <stdio.h>
#include <stdlib.h>

typedef struct Rect {
    int x, y, w, h;
} Rect;

static pid_t g_target_pid = 0;
static Window g_target_win = 0;

Window FindWindowByPID(Display* display, Window root, pid_t pid) {
  Window parent, *children;
  unsigned int nchildren;
  if (!XQueryTree(display, root, &root, &parent, &children, &nchildren)) {
    fprintf(stderr, "XQueryTree failed\n");
    return 0;
  }

  for (unsigned int i = 0; i < nchildren; i++) {
    pid_t window_pid = 0;
    Atom atom_pid = XInternAtom(display, "_NET_WM_PID", True);
    Atom type;
    int format;
    unsigned long nitems, bytes_after;
    unsigned char* prop;

    if (XGetWindowProperty(display, children[i], atom_pid, 0, 1, False, XA_CARDINAL,
                           &type, &format, &nitems, &bytes_after, &prop) == Success && prop) {
      window_pid = *(pid_t*)prop;
      XFree(prop);
      if (window_pid == pid) {
        Window win = children[i];
        XFree(children);
        fprintf(stderr, "Found matching window %lu for PID %d\n", (unsigned long)win, pid);
        return win;
      }
    }

    Window found = FindWindowByPID(display, children[i], pid);
    if (found) {
      XFree(children);
      return found;
    }
  }

  if (children) XFree(children);
  return 0;
}

// N-API helper: throw string error
static void napi_throw_str(napi_env env, const char* msg) {
    napi_throw_error(env, NULL, msg);
}

// setPID(pid)
napi_value SetPID(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

    if (argc < 1) {
        napi_throw_error(env, NULL, "setPID expects 1 argument (pid)");
        return NULL;
    }

    int32_t pid32 = 0;
    if (napi_get_value_int32(env, argv[0], &pid32) != napi_ok) {
        napi_throw_error(env, NULL, "setPID: invalid pid argument");
        return NULL;
    }

    g_target_pid = (pid_t)pid32;
    fprintf(stderr, "x11_input_region: stored PID %d\n", (int)g_target_pid);

    return NULL;
}

// setInputRegion(rectsArray)
napi_value SetInputRegion(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

    if (g_target_pid == 0) {
        napi_throw_error(env, NULL, "setInputRegion: PID not set. Call setPID first.");
        return nullptr;
    }

    napi_value arr = argv[0];
    bool isArray = false;
    napi_is_array(env, arr, &isArray);
    if (!isArray) {
        napi_throw_error(env, NULL, "setInputRegion: argument must be an array");
        return nullptr;
    }

    uint32_t len = 0;
    napi_get_array_length(env, arr, &len);
    std::vector<XRectangle> xr;
    xr.reserve(len);

    for (uint32_t i = 0; i < len; ++i) {
        napi_value el;
        napi_get_element(env, arr, i, &el);

        napi_value vx, vy, vw, vh;
        napi_get_named_property(env, el, "x", &vx);
        napi_get_named_property(env, el, "y", &vy);
        napi_get_named_property(env, el, "w", &vw);
        napi_get_named_property(env, el, "h", &vh);

        int32_t x=0, y=0, w=0, h=0;
        napi_get_value_int32(env, vx, &x);
        napi_get_value_int32(env, vy, &y);
        napi_get_value_int32(env, vw, &w);
        napi_get_value_int32(env, vh, &h);

        if (w <= 0 || h <= 0) continue;
        XRectangle r = {(short)x, (short)y, (unsigned short)w, (unsigned short)h};
        xr.push_back(r);
    }

    Display* dpy = XOpenDisplay(NULL);
    if (!dpy) {
        napi_throw_error(env, NULL, "setInputRegion: XOpenDisplay failed");
        return nullptr;
    }

    Window root = XRootWindow(dpy, DefaultScreen(dpy));
    Window win = FindWindowByPID(dpy, root, g_target_pid);
    if (win == 0) {
        napi_throw_error(env, NULL, "setInputRegion: target window not found yet");
        XCloseDisplay(dpy);
        return nullptr;
    }

    if (xr.empty()) {
        XRectangle rect = {0, 0, 1, 1};
        XShapeCombineRectangles(dpy, win, ShapeInput, 0, 0, &rect, 0, ShapeSet, YXBanded);
        printf("Ignoring whole window %lu for PID %d\n", (unsigned long)win, g_target_pid);
    } else {
        XShapeCombineRectangles(dpy, win, ShapeInput, 0, 0, xr.data(), xr.size(), ShapeSet, Unsorted);
        printf("Ignoring whole region of window %lu for PID %d\n", (unsigned long)win, g_target_pid);
    }

    XFlush(dpy);
    XCloseDisplay(dpy);
    return nullptr;
}

// clearInputRegion()
napi_value ClearInputRegion(napi_env env, napi_callback_info info) {
    if (g_target_win == 0) {
        napi_throw_str(env, "clearInputRegion: target window not set. Call setPID first.");
        return NULL;
    }

    Display* dpy = XOpenDisplay(NULL);
    if (!dpy) {
        napi_throw_str(env, "clearInputRegion: XOpenDisplay failed");
        return NULL;
    }

    // restore full input by applying mask = None
    XShapeCombineMask(dpy, g_target_win, ShapeInput, 0, 0, None, ShapeSet);
    XFlush(dpy);
    XCloseDisplay(dpy);
    return NULL;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;

    napi_create_function(env, NULL, 0, SetPID, NULL, &fn);
    napi_set_named_property(env, exports, "setPID", fn);

    napi_create_function(env, NULL, 0, SetInputRegion, NULL, &fn);
    napi_set_named_property(env, exports, "setInputRegion", fn);

    napi_create_function(env, NULL, 0, ClearInputRegion, NULL, &fn);
    napi_set_named_property(env, exports, "clearInputRegion", fn);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
