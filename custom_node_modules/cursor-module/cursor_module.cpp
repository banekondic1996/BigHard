#include <napi.h>
#include <wayland-client.h>
#include <wayland-client-protocol.h>
#include "relative-pointer-unstable-v1-client-protocol.h"
#include <iostream>
#include <mutex>

// Wayland globals
struct WaylandData {
    wl_display *display = nullptr;
    wl_registry *registry = nullptr;
    wl_seat *seat = nullptr;
    wl_pointer *pointer = nullptr;
    wl_compositor *compositor = nullptr;
    wl_surface *surface = nullptr;
    zwp_relative_pointer_manager_v1 *relative_pointer_mgr = nullptr;
    zwp_relative_pointer_v1 *relative_pointer = nullptr;
};

// Cursor data
struct CursorData {
    WaylandData wl;
    double x = 0.0;
    double y = 0.0;
    bool initial_position_set = false;
    std::mutex pos_mutex;
};

static CursorData data;

// Wayland pointer listener (for initial position)
static void pointer_handle_enter(void *data, struct wl_pointer *pointer, uint32_t serial,
                                 struct wl_surface *surface, wl_fixed_t x, wl_fixed_t y) {
    CursorData *cursor_data = static_cast<CursorData*>(data);
    std::lock_guard<std::mutex> lock(cursor_data->pos_mutex);
    cursor_data->x = wl_fixed_to_double(x);
    cursor_data->y = wl_fixed_to_double(y);
    cursor_data->initial_position_set = true;
    std::cout << "Initial cursor position: x=" << cursor_data->x << " y=" << cursor_data->y << std::endl;
                                 }

                                 static void pointer_handle_leave(void *data, struct wl_pointer *pointer, uint32_t serial,
                                                                  struct wl_surface *surface) {}
                                                                  static void pointer_handle_motion(void *data, struct wl_pointer *pointer, uint32_t time,
                                                                                                    wl_fixed_t x, wl_fixed_t y) {}
                                                                                                    static void pointer_handle_button(void *data, struct wl_pointer *pointer, uint32_t serial,
                                                                                                                                      uint32_t time, uint32_t button, uint32_t state) {}
                                                                                                                                      static void pointer_handle_axis(void *data, struct wl_pointer *pointer, uint32_t time,
                                                                                                                                                                      uint32_t axis, wl_fixed_t value) {}

                                                                                                                                                                      static const struct wl_pointer_listener pointer_listener = {
                                                                                                                                                                          .enter = pointer_handle_enter,
                                                                                                                                                                          .leave = pointer_handle_leave,
                                                                                                                                                                          .motion = pointer_handle_motion,
                                                                                                                                                                          .button = pointer_handle_button,
                                                                                                                                                                          .axis = pointer_handle_axis,
                                                                                                                                                                      };

                                                                                                                                                                      // Relative pointer listener (for ongoing motion)
                                                                                                                                                                      static void relative_pointer_handle_motion(void *data, zwp_relative_pointer_v1 *relative_pointer,
                                                                                                                                                                                                                 uint32_t utime_hi, uint32_t utime_lo,
                                                                                                                                                                                                                 wl_fixed_t dx, wl_fixed_t dy) {
                                                                                                                                                                          CursorData *cursor_data = static_cast<CursorData*>(data);
                                                                                                                                                                          std::lock_guard<std::mutex> lock(cursor_data->pos_mutex);
                                                                                                                                                                          cursor_data->x += wl_fixed_to_double(dx);
                                                                                                                                                                          cursor_data->y += wl_fixed_to_double(dy);
                                                                                                                                                                                                                 }

                                                                                                                                                                                                                 // Relative pointer listener struct
                                                                                                                                                                                                                 static const zwp_relative_pointer_v1_listener relative_pointer_listener = {
                                                                                                                                                                                                                     .relative_motion = relative_pointer_handle_motion,
                                                                                                                                                                                                                 };

                                                                                                                                                                                                                 // Seat listener
                                                                                                                                                                                                                 static void seat_handle_capabilities(void *data, struct wl_seat *seat, uint32_t capabilities) {
                                                                                                                                                                                                                     CursorData *cursor_data = static_cast<CursorData*>(data);
                                                                                                                                                                                                                     if (capabilities & WL_SEAT_CAPABILITY_POINTER) {
                                                                                                                                                                                                                         cursor_data->wl.pointer = wl_seat_get_pointer(seat);
                                                                                                                                                                                                                         wl_pointer_add_listener(cursor_data->wl.pointer, &pointer_listener, cursor_data);

                                                                                                                                                                                                                         if (cursor_data->wl.relative_pointer_mgr) {
                                                                                                                                                                                                                             cursor_data->wl.relative_pointer = zwp_relative_pointer_manager_v1_get_relative_pointer(
                                                                                                                                                                                                                                 cursor_data->wl.relative_pointer_mgr, cursor_data->wl.pointer);
                                                                                                                                                                                                                             if (cursor_data->wl.relative_pointer) {
                                                                                                                                                                                                                                 zwp_relative_pointer_v1_add_listener(cursor_data->wl.relative_pointer,
                                                                                                                                                                                                                                                                &relative_pointer_listener, cursor_data);
                                                                                                                                                                                                                             }
                                                                                                                                                                                                                         }
                                                                                                                                                                                                                     }
                                                                                                                                                                                                                 }

                                                                                                                                                                                                                 static const struct wl_seat_listener seat_listener = {
                                                                                                                                                                                                                     .capabilities = seat_handle_capabilities,
                                                                                                                                                                                                                 };

                                                                                                                                                                                                                 // Registry listener
                                                                                                                                                                                                                 static void registry_handle_global(void *data, struct wl_registry *registry, uint32_t name,
                                                                                                                                                                                                                                                    const char *interface, uint32_t version) {
                                                                                                                                                                                                                     CursorData *cursor_data = static_cast<CursorData*>(data);
                                                                                                                                                                                                                     if (strcmp(interface, wl_seat_interface.name) == 0) {
                                                                                                                                                                                                                         cursor_data->wl.seat = static_cast<wl_seat*>(
                                                                                                                                                                                                                             wl_registry_bind(registry, name, &wl_seat_interface, 1));
                                                                                                                                                                                                                         wl_seat_add_listener(cursor_data->wl.seat, &seat_listener, cursor_data);
                                                                                                                                                                                                                     } else if (strcmp(interface, wl_compositor_interface.name) == 0) {
                                                                                                                                                                                                                         cursor_data->wl.compositor = static_cast<wl_compositor*>(
                                                                                                                                                                                                                             wl_registry_bind(registry, name, &wl_compositor_interface, 1));
                                                                                                                                                                                                                     } else if (strcmp(interface, zwp_relative_pointer_manager_v1_interface.name) == 0) {
                                                                                                                                                                                                                         cursor_data->wl.relative_pointer_mgr = static_cast<zwp_relative_pointer_manager_v1*>(
                                                                                                                                                                                                                             wl_registry_bind(registry, name, &zwp_relative_pointer_manager_v1_interface, 1));
                                                                                                                                                                                                                     }
                                                                                                                                                                                                                                                    }

                                                                                                                                                                                                                                                    static const struct wl_registry_listener registry_listener = {
                                                                                                                                                                                                                                                        .global = registry_handle_global,
                                                                                                                                                                                                                                                        .global_remove = nullptr,
                                                                                                                                                                                                                                                    };

                                                                                                                                                                                                                                                    // Initialize Wayland and capture initial position
                                                                                                                                                                                                                                                    void init_wayland(Napi::Env env) {
                                                                                                                                                                                                                                                        data.wl.display = wl_display_connect(nullptr);
                                                                                                                                                                                                                                                        if (!data.wl.display) {
                                                                                                                                                                                                                                                            Napi::Error::New(env, "Failed to connect to Wayland display").ThrowAsJavaScriptException();
                                                                                                                                                                                                                                                            return;
                                                                                                                                                                                                                                                        }

                                                                                                                                                                                                                                                        data.wl.registry = wl_display_get_registry(data.wl.display);
                                                                                                                                                                                                                                                        wl_registry_add_listener(data.wl.registry, ®istry_listener, &data);

                                                                                                                                                                                                                                                        // Roundtrip to bind interfaces
                                                                                                                                                                                                                                                        wl_display_roundtrip(data.wl.display);

                                                                                                                                                                                                                                                        if (!data.wl.compositor || !data.wl.seat || !data.wl.relative_pointer_mgr) {
                                                                                                                                                                                                                                                            Napi::Error::New(env, "Missing required Wayland interfaces").ThrowAsJavaScriptException();
                                                                                                                                                                                                                                                            return;
                                                                                                                                                                                                                                                        }

                                                                                                                                                                                                                                                        // Create a temporary surface to get initial position
                                                                                                                                                                                                                                                        data.wl.surface = wl_compositor_create_surface(data.wl.compositor);
                                                                                                                                                                                                                                                        wl_surface_commit(data.wl.surface);

                                                                                                                                                                                                                                                        // Wait for initial position (timeout after a few roundtrips)
                                                                                                                                                                                                                                                        int retries = 5;
                                                                                                                                                                                                                                                        while (!data.initial_position_set && retries-- > 0) {
                                                                                                                                                                                                                                                            wl_display_dispatch(data.wl.display);
                                                                                                                                                                                                                                                        }

                                                                                                                                                                                                                                                        // Destroy the surface after capturing initial position
                                                                                                                                                                                                                                                        if (data.wl.surface) {
                                                                                                                                                                                                                                                            wl_surface_destroy(data.wl.surface);
                                                                                                                                                                                                                                                            data.wl.surface = nullptr;
                                                                                                                                                                                                                                                        }

                                                                                                                                                                                                                                                        if (!data.initial_position_set) {
                                                                                                                                                                                                                                                            std::cerr << "Warning: Initial position not captured, defaulting to (0,0)" << std::endl;
                                                                                                                                                                                                                                                        }
                                                                                                                                                                                                                                                    }

                                                                                                                                                                                                                                                    // Cleanup
                                                                                                                                                                                                                                                    static void cleanup(void* arg) {
                                                                                                                                                                                                                                                        if (data.wl.relative_pointer) zwp_relative_pointer_v1_destroy(data.wl.relative_pointer);
                                                                                                                                                                                                                                                        if (data.wl.pointer) wl_pointer_destroy(data.wl.pointer);
                                                                                                                                                                                                                                                        if (data.wl.seat) wl_seat_destroy(data.wl.seat);
                                                                                                                                                                                                                                                        if (data.wl.relative_pointer_mgr) zwp_relative_pointer_manager_v1_destroy(data.wl.relative_pointer_mgr);
                                                                                                                                                                                                                                                        if (data.wl.compositor) wl_compositor_destroy(data.wl.compositor);
                                                                                                                                                                                                                                                        if (data.wl.registry) wl_registry_destroy(data.wl.registry);
                                                                                                                                                                                                                                                        if (data.wl.display) wl_display_disconnect(data.wl.display);
                                                                                                                                                                                                                                                    }

                                                                                                                                                                                                                                                    // Node.js binding: Get cursor position
                                                                                                                                                                                                                                                    Napi::Value GetCursorPosition(const Napi::CallbackInfo& info) {
                                                                                                                                                                                                                                                        Napi::Env env = info.Env();
                                                                                                                                                                                                                                                        Napi::Object obj = Napi::Object::New(env);
                                                                                                                                                                                                                                                        {
                                                                                                                                                                                                                                                            std::lock_guard<std::mutex> lock(data.pos_mutex);
                                                                                                                                                                                                                                                            obj.Set("x", Napi::Number::New(env, data.x));
                                                                                                                                                                                                                                                            obj.Set("y", Napi::Number::New(env, data.y));
                                                                                                                                                                                                                                                        }
                                                                                                                                                                                                                                                        return obj;
                                                                                                                                                                                                                                                    }

                                                                                                                                                                                                                                                    // Initialize the module
                                                                                                                                                                                                                                                    Napi::Object Init(Napi::Env env, Napi::Object exports) {
                                                                                                                                                                                                                                                        exports.Set("getCursorPosition", Napi::Function::New(env, GetCursorPosition));
                                                                                                                                                                                                                                                        init_wayland(env);
                                                                                                                                                                                                                                                        napi_add_env_cleanup_hook(env, cleanup, nullptr);
                                                                                                                                                                                                                                                        return exports;
                                                                                                                                                                                                                                                    }

                                                                                                                                                                                                                                                    NODE_API_MODULE(cursor_module, Init)
