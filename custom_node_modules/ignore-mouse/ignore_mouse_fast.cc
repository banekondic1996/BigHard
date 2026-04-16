#include <node_api.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/shape.h>
#include <X11/Xutil.h>
#include <stdio.h>
#include <pthread.h>
#include <unistd.h>

static pthread_t monitor_thread;
static bool running = false;
static pid_t target_pid = 0;

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

bool IsPixelTransparent(Display* display, Window win, int x, int y) {
  XWindowAttributes attrs;
  if (!XGetWindowAttributes(display, win, &attrs)) {
    fprintf(stderr, "Failed to get window attributes\n");
    return false;
  }

  if (x < 0 || x >= attrs.width || y < 0 || y >= attrs.height) {
    return true; // Outside window bounds, allow click-through
  }

  XImage* image = XGetImage(display, win, x, y, 1, 1, AllPlanes, ZPixmap);
  if (!image) {
    fprintf(stderr, "Failed to get image at (%d, %d)\n", x, y);
    return false;
  }

  unsigned long pixel = XGetPixel(image, 0, 0);
  XDestroyImage(image);

  bool is_transparent = (pixel == 0x00000000);
  // fprintf(stderr, "Pixel at (%d, %d) = %lx, transparent: %s\n", x, y, pixel, is_transparent ? "yes" : "no");
  return is_transparent;
}

void* MonitorMouse(void* arg) {
  Display* display = XOpenDisplay(nullptr);
  if (!display) {
    fprintf(stderr, "Failed to open X11 display in thread\n");
    return nullptr;
  }

  Window root = XRootWindow(display, DefaultScreen(display));
  Window win = FindWindowByPID(display, root, target_pid);
  if (!win) {
    fprintf(stderr, "No window found for PID %d in thread\n", target_pid);
    XCloseDisplay(display);
    return nullptr;
  }

  bool last_transparent = false;
  while (running) {
    Window root_return, child_return;
    int root_x, root_y, win_x, win_y;
    unsigned int mask_return;

    if (XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y, &win_x, &win_y, &mask_return)) {
      XWindowAttributes attrs;
      XGetWindowAttributes(display, win, &attrs);
      int win_rel_x = root_x - attrs.x;
      int win_rel_y = root_y - attrs.y;

      bool is_transparent = IsPixelTransparent(display, win, win_rel_x, win_rel_y);
      if (is_transparent != last_transparent) { // Only update shape on change
        if (is_transparent) {
          XRectangle rect = {(short)win_rel_x, (short)win_rel_y, 1, 1};
          XShapeCombineRectangles(display, win, ShapeInput, 0, 0, &rect, 1, ShapeSet, Unsorted);
          // fprintf(stderr, "Set 1x1 input shape at (%d, %d) for window %lu\n", win_rel_x, win_rel_y, (unsigned long)win);
        } else {
          XShapeCombineMask(display, win, ShapeInput, 0, 0, None, ShapeSet);
          // fprintf(stderr, "Reset input shape for window %lu\n", (unsigned long)win);
        }
        XFlush(display);
        last_transparent = is_transparent;
      }
    }
    usleep(10000); // 10 ms polling (100 Hz), adjust as needed
  }

  XCloseDisplay(display);
  return nullptr;
}

napi_value StartIgnoreMouseEvents(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc != 1) {
    napi_throw_error(env, nullptr, "Expected 1 argument: pid (number)");
    return nullptr;
  }

  uint32_t pid;
  napi_get_value_uint32(env, args[0], &pid);
  target_pid = pid;

/*   if (!IsX11OrXWayland()) {
    napi_throw_error(env, nullptr, "X11 or XWayland not available");
    return nullptr;
  } */

  if (!running) {
    running = true;
    pthread_create(&monitor_thread, nullptr, MonitorMouse, nullptr);
    fprintf(stderr, "Started mouse event monitoring for PID %d\n", pid);
  }

  return nullptr;
}

napi_value StopIgnoreMouseEvents(napi_env env, napi_callback_info info) {
  if (running) {
    running = false;
    pthread_join(monitor_thread, nullptr);
    fprintf(stderr, "Stopped mouse event monitoring\n");

    Display* display = XOpenDisplay(nullptr);
    if (display) {
      Window root = XRootWindow(display, DefaultScreen(display));
      Window win = FindWindowByPID(display, root, target_pid);
      if (win) {
        XShapeCombineMask(display, win, ShapeInput, 0, 0, None, ShapeSet);
        XFlush(display);
      }
      XCloseDisplay(display);
    }
  }

  return nullptr;
}

bool IsX11OrXWayland() {
  Display* display = XOpenDisplay(nullptr);
  if (!display) return false;
  XCloseDisplay(display);
  return true;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value start_fn, stop_fn;
  napi_create_function(env, nullptr, 0, StartIgnoreMouseEvents, nullptr, &start_fn);
  napi_create_function(env, nullptr, 0, StopIgnoreMouseEvents, nullptr, &stop_fn);
  napi_set_named_property(env, exports, "startIgnoreMouseEvents", start_fn);
  napi_set_named_property(env, exports, "stopIgnoreMouseEvents", stop_fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
