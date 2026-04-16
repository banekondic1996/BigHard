#include <node_api.h>
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/shape.h>
#include <X11/Xutil.h>
#include <libinput.h>
#include <libudev.h>
#include <fcntl.h>
#include <unistd.h>
#include <pthread.h>
#include <stdio.h>
#include <mutex>

static pthread_t monitor_thread;
static pthread_t position_thread;
static bool running_monitor = false;
static bool running_position = false;
static pid_t target_pid = 0;

// Cursor data for position tracking
struct CursorData {
    double x = 0.0;
    double y = 0.0;
    struct libinput *li = nullptr;
    std::mutex pos_mutex;
    bool initialized = false;
};

static CursorData cursor_data;

// Libinput event handling
static int open_restricted(const char *path, int flags, void *user_data) {
    int fd = open(path, flags);
    return fd < 0 ? -errno : fd;
}

static void close_restricted(int fd, void *user_data) {
    close(fd);
}

static const struct libinput_interface interface = {
    .open_restricted = open_restricted,
    .close_restricted = close_restricted,
};

// Initialize libinput
static void init_libinput() {
    struct udev *udev = udev_new();
    if (!udev) {
        fprintf(stderr, "Failed to create udev context\n");
        return;
    }

    cursor_data.li = libinput_udev_create_context(&interface, nullptr, udev);
    if (!cursor_data.li) {
        udev_unref(udev);
        fprintf(stderr, "Failed to create libinput context\n");
        return;
    }

    if (libinput_udev_assign_seat(cursor_data.li, "seat0") < 0) {
        libinput_unref(cursor_data.li);
        cursor_data.li = nullptr;
        udev_unref(udev);
        fprintf(stderr, "Failed to assign seat\n");
        return;
    }

    udev_unref(udev);
    cursor_data.initialized = true;
    fprintf(stderr, "Libinput initialized for position tracking\n");
}

// Position tracking loop
static void* position_loop(void* arg) {
    while (running_position && cursor_data.li) {
        libinput_dispatch(cursor_data.li);
        struct libinput_event *event;
        while ((event = libinput_get_event(cursor_data.li)) != nullptr) {
            if (libinput_event_get_type(event) == LIBINPUT_EVENT_POINTER_MOTION) {
                struct libinput_event_pointer *p = libinput_event_get_pointer_event(event);
                double dx = libinput_event_pointer_get_dx(p);
                double dy = libinput_event_pointer_get_dy(p);
                std::lock_guard<std::mutex> lock(cursor_data.pos_mutex);
                cursor_data.x += dx;
                cursor_data.y += dy;
            }
            libinput_event_destroy(event);
        }
        usleep(10000); // 10ms polling
    }
    return nullptr;
}

// X11-based mouse ignore logic (unchanged)
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
    while (running_monitor) {
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
                } else {
                    XShapeCombineMask(display, win, ShapeInput, 0, 0, None, ShapeSet);
                }
                XFlush(display);
                last_transparent = is_transparent;
            }
        }
        usleep(10000); // 10 ms polling
    }

    XCloseDisplay(display);
    return nullptr;
}

// Existing N-API functions (unchanged)
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

    if (!running_monitor) {
        running_monitor = true;
        pthread_create(&monitor_thread, nullptr, MonitorMouse, nullptr);
        fprintf(stderr, "Started mouse event monitoring for PID %d\n", pid);
    }

    return nullptr;
}

napi_value StopIgnoreMouseEvents(napi_env env, napi_callback_info info) {
    if (running_monitor) {
        running_monitor = false;
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

// New function to start position tracking with initial x, y
napi_value StartTrackingPosition(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    if (argc != 2 || !napi_get_value_double(env, args[0], &cursor_data.x) || !napi_get_value_double(env, args[1], &cursor_data.y)) {
        napi_throw_error(env, nullptr, "Expected 2 arguments: x (number), y (number)");
        return nullptr;
    }

    if (!cursor_data.initialized) {
        init_libinput();
    }

    if (!running_position && cursor_data.initialized) {
        running_position = true;
        pthread_create(&position_thread, nullptr, position_loop, nullptr);
        fprintf(stderr, "Started position tracking with initial x=%f, y=%f\n", cursor_data.x, cursor_data.y);
    }

    return nullptr;
}

// Get current cursor position
napi_value GetCursorPosition(napi_env env, napi_callback_info info) {
    napi_value obj;
    napi_create_object(env, &obj);

    std::lock_guard<std::mutex> lock(cursor_data.pos_mutex);
    napi_set_named_property(env, obj, "x", napi_create_double(env, cursor_data.x));
    napi_set_named_property(env, obj, "y", napi_create_double(env, cursor_data.y));

    return obj;
}

// Cleanup
static void cleanup(void* arg) {
    if (running_monitor) {
        running_monitor = false;
        pthread_join(monitor_thread, nullptr);
    }
    if (running_position) {
        running_position = false;
        if (position_thread.joinable()) {
            pthread_join(position_thread, nullptr);
        }
    }
    if (cursor_data.li) {
        libinput_unref(cursor_data.li);
        cursor_data.li = nullptr;
    }
}

// Module initialization
napi_value Init(napi_env env, napi_value exports) {
    napi_value start_ignore_fn, stop_ignore_fn, start_tracking_fn, get_position_fn;
    napi_create_function(env, nullptr, 0, StartIgnoreMouseEvents, nullptr, &start_ignore_fn);
    napi_create_function(env, nullptr, 0, StopIgnoreMouseEvents, nullptr, &stop_ignore_fn);
    napi_create_function(env, nullptr, 0, StartTrackingPosition, nullptr, &start_tracking_fn);
    napi_create_function(env, nullptr, 0, GetCursorPosition, nullptr, &get_position_fn);
    napi_set_named_property(env, exports, "startIgnoreMouseEvents", start_ignore_fn);
    napi_set_named_property(env, exports, "stopIgnoreMouseEvents", stop_ignore_fn);
    napi_set_named_property(env, exports, "startTrackingPosition", start_tracking_fn);
    napi_set_named_property(env, exports, "getCursorPosition", get_position_fn);

    napi_add_env_cleanup_hook(env, cleanup, nullptr);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
