#include "wayland.h"
#include <cstdlib>

static wl_surface* surface = nullptr;
static wl_compositor* compositor = nullptr;

bool Wayland::isRunningWayland() {
    return getenv("WAYLAND_DISPLAY") != nullptr;
}

void Wayland::setSurface(wl_surface* s) {
    surface = s;
}

void Wayland::applyRegion(const std::vector<Rect>& rects) {
    if (!surface) return;
    if (!compositor) return;

    wl_region* region = wl_compositor_create_region(compositor);

    for (auto &r : rects) {
        wl_region_add(region, r.x, r.y, r.w, r.h);
    }

    wl_surface_set_input_region(surface, region);
    wl_surface_commit(surface);

    wl_region_destroy(region);
}
