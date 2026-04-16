#pragma once
#include <vector>

struct Rect { int x, y, w, h; };

namespace X11 {
    void SetInputRegion(const std::vector<Rect>& rects);
}
