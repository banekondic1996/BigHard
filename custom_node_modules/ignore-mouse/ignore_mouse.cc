#include <node_api.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/shape.h>
#include <stdio.h>

Window FindWindowByPID(Display* display, Window root, pid_t target_pid) {
  Window parent, *children;
  unsigned int nchildren;
  if (!XQueryTree(display, root, &root, &parent, &children, &nchildren)) {
    fprintf(stderr, "XQueryTree failed\n");
    return 0;
  }

  for (unsigned int i = 0; i < nchildren; i++) {
    pid_t pid = 0;
    Atom atom_pid = XInternAtom(display, "_NET_WM_PID", True);
    Atom type;
    int format;
    unsigned long nitems, bytes_after;
    unsigned char* prop;

    if (XGetWindowProperty(display, children[i], atom_pid, 0, 1, False, XA_CARDINAL,
                           &type, &format, &nitems, &bytes_after, &prop) == Success && prop) {
      pid = *(pid_t*)prop;
      XFree(prop);
      fprintf(stderr, "Window %lu has PID %d\n", (unsigned long)children[i], pid);
      if (pid == target_pid) {
        Window win = children[i];
        XFree(children);
        fprintf(stderr, "Found matching window %lu for PID %d\n", (unsigned long)win, pid);
        return win;
      }
    }

    Window found = FindWindowByPID(display, children[i], target_pid);
    if (found) {
      XFree(children);
      return found;
    }
  }

  if (children) XFree(children);
  return 0;
}

static bool IsX11OrXWayland() {
  Display* display = XOpenDisplay(nullptr);
  if (!display) return false;
  XCloseDisplay(display);
  return true;
}

// Set "always on top" state
void SetAlwaysOnTop(Display* display, Window win, bool enable) {
  Atom wm_state = XInternAtom(display, "_NET_WM_STATE", False);
  Atom state_above = XInternAtom(display, "_NET_WM_STATE_ABOVE", False);

  if (enable) {
    XChangeProperty(display, win, wm_state, XA_ATOM, 32, PropModeReplace, (unsigned char*)&state_above, 1);
    fprintf(stderr, "Set window %lu to always on top\n", (unsigned long)win);
  } else {
    XDeleteProperty(display, win, wm_state);
    fprintf(stderr, "Removed always on top from window %lu\n", (unsigned long)win);
  }
}

napi_value IgnoreMouseEvents(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc != 2) {
    napi_throw_error(env, nullptr, "Expected 2 arguments: pid (number), ignore (boolean)");
    return nullptr;
  }

  uint32_t pid;
  napi_get_value_uint32(env, args[0], &pid);

  bool ignore;
  napi_get_value_bool(env, args[1], &ignore);

  if (!IsX11OrXWayland()) {
    napi_throw_error(env, nullptr, "X11 or XWayland not available");
    return nullptr;
  }

  Display* display = XOpenDisplay(nullptr);
  if (!display) {
    napi_throw_error(env, nullptr, "Failed to open X11 display");
    return nullptr;
  }

  int event_base, error_base;
  if (!XShapeQueryExtension(display, &event_base, &error_base)) {
    XCloseDisplay(display);
    napi_throw_error(env, nullptr, "XShape extension not available");
    return nullptr;
  }

  Window root = XRootWindow(display, DefaultScreen(display));
  Window win = FindWindowByPID(display, root, static_cast<pid_t>(pid));
  if (!win) {
    XCloseDisplay(display);
    napi_throw_error(env, nullptr, "No window found for PID");
    return nullptr;
  }

  if (ignore) {
    XRectangle rect = {0, 0, 1, 1};
    XShapeCombineRectangles(display, win, ShapeInput, 0, 0, &rect, 1, ShapeSet, YXBanded);
    fprintf(stderr, "Set 1x1 input shape for window %lu\n", (unsigned long)win);
  } else {
    XShapeCombineMask(display, win, ShapeInput, 0, 0, None, ShapeSet);
    fprintf(stderr, "Reset input shape for window %lu\n", (unsigned long)win);
  }

  XFlush(display);
  XCloseDisplay(display);

  return nullptr;
}

napi_value SetAlwaysOnTop(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc != 2) {
    napi_throw_error(env, nullptr, "Expected 2 arguments: pid (number), enable (boolean)");
    return nullptr;
  }

  uint32_t pid;
  napi_get_value_uint32(env, args[0], &pid);

  bool enable;
  napi_get_value_bool(env, args[1], &enable);

  if (!IsX11OrXWayland()) {
    napi_throw_error(env, nullptr, "X11 or XWayland not available");
    return nullptr;
  }

  Display* display = XOpenDisplay(nullptr);
  if (!display) {
    napi_throw_error(env, nullptr, "Failed to open X11 display");
    return nullptr;
  }

  Window root = XRootWindow(display, DefaultScreen(display));
  Window win = FindWindowByPID(display, root, static_cast<pid_t>(pid));
  if (!win) {
    XCloseDisplay(display);
    napi_throw_error(env, nullptr, "No window found for PID");
    return nullptr;
  }

  SetAlwaysOnTop(display, win, enable);
  XFlush(display);
  XCloseDisplay(display);

  return nullptr;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value ignore_fn, always_on_top_fn;
  napi_create_function(env, nullptr, 0, IgnoreMouseEvents, nullptr, &ignore_fn);
  napi_create_function(env, nullptr, 0, SetAlwaysOnTop, nullptr, &always_on_top_fn);
  napi_set_named_property(env, exports, "ignoreMouseEvents", ignore_fn);
  napi_set_named_property(env, exports, "setAlwaysOnTop", always_on_top_fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)