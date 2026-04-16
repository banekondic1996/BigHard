#pragma once
#include <wayland-client.h>
#include <vector>

struct Rect { int x, y, w, h; };

namespace Wayland {
    bool isRunningWayland();
    void setSurface(wl_surface* s);
    void applyRegion(const std::vector<Rect>& rects);
}
