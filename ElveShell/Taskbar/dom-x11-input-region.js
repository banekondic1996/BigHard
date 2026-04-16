// dom-x11-input-region.js
// Efficient DOM engine: MutationObserver + ResizeObserver + optional webview scanning

(function(global) {

  function nowMs() { return performance.now(); }

  function mergeRects(rects) {
    if (rects.length <= 1) return rects.slice();
    rects = rects.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const horizontal = [];
    for (const rect of rects) {
      const last = horizontal.length ? horizontal[horizontal.length - 1] : null;
      if (last && rect.y === last.y && rect.h === last.h && rect.x <= last.x + last.w) {
        last.w = Math.max(last.w, (rect.x + rect.w) - last.x);
      } else {
        horizontal.push(Object.assign({}, rect));
      }
    }

    const vertical = [];
    for (const rect of horizontal) {
      const last = vertical.length ? vertical[vertical.length - 1] : null;
      if (last && rect.x === last.x && rect.w === last.w && rect.y <= last.y + last.h) {
        last.h = Math.max(last.h, (rect.y + rect.h) - last.y);
      } else {
        vertical.push(Object.assign({}, rect));
      }
    }

    return vertical;
  }

  function rasterizeToTiles(boxes, tileSize, surfaceW, surfaceH) {
    const cols = Math.max(1, Math.ceil(surfaceW / tileSize));
    const rows = Math.max(1, Math.ceil(surfaceH / tileSize));
    const grid = new Uint8Array(cols * rows);

    for (const box of boxes) {
      const x0 = Math.max(0, Math.floor(box.x / tileSize));
      const y0 = Math.max(0, Math.floor(box.y / tileSize));
      const x1 = Math.min(cols - 1, Math.floor((box.x + box.w - 1) / tileSize));
      const y1 = Math.min(rows - 1, Math.floor((box.y + box.h - 1) / tileSize));
      for (let yy = y0; yy <= y1; yy++) {
        const base = yy * cols;
        for (let xx = x0; xx <= x1; xx++) {
          grid[base + xx] = 1;
        }
      }
    }

    const rects = [];
    for (let y = 0; y < rows; y++) {
      let start = -1;
      for (let x = 0; x < cols; x++) {
        const filled = grid[y * cols + x];
        if (filled && start === -1) start = x;
        if ((!filled || x === cols - 1) && start !== -1) {
          const end = !filled ? x - 1 : x;
          rects.push({
            x: start * tileSize,
            y: y * tileSize,
            w: (end - start + 1) * tileSize,
            h: tileSize
          });
          start = -1;
        }
      }
    }

    const merged = mergeRects(rects);
    for (const rect of merged) {
      if (rect.x + rect.w > surfaceW) rect.w = surfaceW - rect.x;
      if (rect.y + rect.h > surfaceH) rect.h = surfaceH - rect.y;
    }
    return merged;
  }

  function isElementHitTarget(el, selector, view) {
    if (!el || !(el instanceof view.Element)) return false;

    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0) return false;
    if (style.pointerEvents === 'none') return false;
    if (selector && !el.matches(selector)) return false;

    const tag = el.tagName.toLowerCase();
    if (['button', 'a', 'input', 'textarea', 'select', 'video', 'canvas'].includes(tag)) return true;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const hasBackground = (style.backgroundImage && style.backgroundImage !== 'none')
      || (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)')
      || (parseFloat(style.borderWidth) > 0);

    return !!hasBackground;
  }

  function collectDocumentBoxes(doc, selector, pixelRatio, options) {
    if (!doc || !doc.body || !doc.defaultView) return [];

    const view = doc.defaultView;
    const boxes = [];
    const nodes = selector ? doc.querySelectorAll(selector) : doc.body.getElementsByTagName('*');

    for (const el of nodes) {
      try {
        if (options.includeWebviews && el.tagName && el.tagName.toLowerCase() === 'webview') {
          continue;
        }
        if (!isElementHitTarget(el, selector, view)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        boxes.push({
          x: Math.floor(rect.left * pixelRatio),
          y: Math.floor(rect.top * pixelRatio),
          w: Math.ceil(rect.width * pixelRatio),
          h: Math.ceil(rect.height * pixelRatio)
        });
      } catch (error) {
        // Ignore detached nodes.
      }
    }

    return boxes;
  }

  function isVisibleFrameHost(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0) return false;
    if (style.pointerEvents === 'none') return false;
    if (el.classList.contains('hide')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buildGuestCollectorCode(selector) {
    return `
      (() => {
        const selector = ${JSON.stringify(selector || '*')};
        function isHitTarget(el) {
          if (!el || !(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0) return false;
          if (style.pointerEvents === 'none') return false;
          if (selector && el.matches(selector)) return true;
          const tag = el.tagName.toLowerCase();
          if (['button', 'a', 'input', 'textarea', 'select', 'video', 'canvas'].includes(tag)) return true;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          return !!(
            (style.backgroundImage && style.backgroundImage !== 'none') ||
            (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') ||
            (parseFloat(style.borderWidth) > 0)
          );
        }

        const nodes = selector ? document.querySelectorAll(selector) : document.body.getElementsByTagName('*');
        const boxes = [];
        for (const el of nodes) {
          try {
            if (!isHitTarget(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            boxes.push({
              x: Math.floor(rect.left),
              y: Math.floor(rect.top),
              w: Math.ceil(rect.width),
              h: Math.ceil(rect.height)
            });
          } catch (error) {}
        }
        return JSON.stringify(boxes);
      })();
    `;
  }

  function executeScriptPromise(webview, code) {
    return new Promise((resolve) => {
      try {
        webview.executeScript({ code }, (result) => {
          if (Array.isArray(result)) {
            resolve(result[0] || null);
            return;
          }
          resolve(result || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  async function collectWebviewBoxes(selector, pixelRatio, options) {
    const webviews = Array.from(document.querySelectorAll(options.webviewSelector || 'webview'));
    if (!webviews.length) return [];

    const guestCode = buildGuestCollectorCode(selector);
    const allBoxes = [];

    for (const webview of webviews) {
      if (!isVisibleFrameHost(webview)) continue;

      const hostRect = webview.getBoundingClientRect();
      let guestBoxes = null;

      try {
        const result = await executeScriptPromise(webview, guestCode);
        if (result) {
          guestBoxes = JSON.parse(result);
        }
      } catch (error) {
        guestBoxes = null;
      }

      if (!Array.isArray(guestBoxes) || !guestBoxes.length) {
        allBoxes.push({
          x: Math.floor(hostRect.left * pixelRatio),
          y: Math.floor(hostRect.top * pixelRatio),
          w: Math.ceil(hostRect.width * pixelRatio),
          h: Math.ceil(hostRect.height * pixelRatio)
        });
        continue;
      }

      const limitedBoxes = guestBoxes.slice(0, options.maxWebviewRects || 240);
      limitedBoxes.forEach((box) => {
        if (!box || box.w <= 0 || box.h <= 0) return;
        allBoxes.push({
          x: Math.floor((hostRect.left + box.x) * pixelRatio),
          y: Math.floor((hostRect.top + box.y) * pixelRatio),
          w: Math.ceil(box.w * pixelRatio),
          h: Math.ceil(box.h * pixelRatio)
        });
      });
    }

    return allBoxes;
  }

  async function collectBoundingBoxes(selector, pixelRatio, options) {
    const boxes = collectDocumentBoxes(document, selector, pixelRatio, options);
    if (!options.includeWebviews) return boxes;
    const webviewBoxes = await collectWebviewBoxes(selector, pixelRatio, options);
    return boxes.concat(webviewBoxes);
  }

  function start(opts) {
    console.log('dom-x11-input-region starting...');

    const cfg = Object.assign({
      native: null,
      selector: '*',
      tileSize: 12,
      minIntervalMs: 16,
      pixelRatio: window.devicePixelRatio || 1,
      maxRects: 800,
      includeWebviews: true,
      webviewSelector: 'webview',
      webviewPollMs: 260,
      maxWebviewRects: 240,
      refreshIntervalMs: 1000,
      reapplySameRegionMs: 1200
    }, opts || {});

    if (!cfg.native || typeof cfg.native.setInputRegion !== 'function') {
      throw new Error('native.setInputRegion required');
    }

    let scheduled = false;
    let lastEmit = 0;
    let lastHash = null;
    let lastApplyAt = 0;
    let webviewPollTimer = null;
    let forceRefreshTimer = null;
    let updateToken = 0;

    const mutObs = new MutationObserver(() => {
      observeNodes();
      schedule();
    });
    const resizeObs = new ResizeObserver(() => schedule());

    function observeNodes() {
      const nodes = document.querySelectorAll(cfg.selector);
      for (const node of nodes) {
        try { resizeObs.observe(node); } catch (error) {}
      }
      if (cfg.includeWebviews) {
        const webviews = document.querySelectorAll(cfg.webviewSelector);
        for (const webview of webviews) {
          try { resizeObs.observe(webview); } catch (error) {}
        }
      }
    }

    observeNodes();

    mutObs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'src']
    });

    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    if (cfg.refreshIntervalMs > 0) {
      forceRefreshTimer = setInterval(schedule, cfg.refreshIntervalMs);
    }

    function queueVisibleWebviewPoll() {
      if (webviewPollTimer) {
        clearTimeout(webviewPollTimer);
        webviewPollTimer = null;
      }
      if (!cfg.includeWebviews || !cfg.webviewPollMs) return;

      const hasVisibleWebview = Array.from(document.querySelectorAll(cfg.webviewSelector))
        .some((el) => isVisibleFrameHost(el));

      if (!hasVisibleWebview) return;

      webviewPollTimer = setTimeout(() => {
        webviewPollTimer = null;
        schedule();
      }, cfg.webviewPollMs);
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const since = nowMs() - lastEmit;
        if (since < cfg.minIntervalMs) {
          setTimeout(doUpdate, Math.max(0, cfg.minIntervalMs - since));
        } else {
          doUpdate();
        }
      });
    }

    async function doUpdate() {
      const surfaceW = Math.ceil(window.innerWidth * cfg.pixelRatio);
      const surfaceH = Math.ceil(window.innerHeight * cfg.pixelRatio);
      const token = ++updateToken;

      const boxes = await collectBoundingBoxes(cfg.selector, cfg.pixelRatio, cfg);
      if (token !== updateToken) return;

      if (!boxes.length) {
        if (lastHash !== 'EMPTY') {
          cfg.native.setInputRegion([]);
          lastHash = 'EMPTY';
          lastApplyAt = nowMs();
        }
        lastEmit = nowMs();
        queueVisibleWebviewPoll();
        return;
      }

      const tiles = rasterizeToTiles(boxes, cfg.tileSize, surfaceW, surfaceH);
      const rects = tiles.length > cfg.maxRects
        ? (() => {
            const union = tiles.reduce((acc, rect) => {
              if (!acc) return rect;
              return {
                x: Math.min(acc.x, rect.x),
                y: Math.min(acc.y, rect.y),
                w: Math.max(acc.x + acc.w, rect.x + rect.w) - Math.min(acc.x, rect.x),
                h: Math.max(acc.y + acc.h, rect.y + rect.h) - Math.min(acc.y, rect.y)
              };
            }, null);
            return union ? [union] : [];
          })()
        : tiles.map((rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }));

      const hash = rects.map((rect) => `${rect.x},${rect.y},${rect.w},${rect.h}`).join('|');
      const applyNow = nowMs();
      const shouldReapply = hash !== lastHash || (applyNow - lastApplyAt) >= cfg.reapplySameRegionMs;
      if (shouldReapply) {
        try {
          cfg.native.setInputRegion(rects);
          lastHash = hash;
          lastApplyAt = applyNow;
        } catch (error) {
          console.error('setInputRegion failed', error);
        }
      }

      lastEmit = nowMs();
      queueVisibleWebviewPoll();
    }

    schedule();

    return {
      stop() {
        mutObs.disconnect();
        resizeObs.disconnect();
        if (webviewPollTimer) {
          clearTimeout(webviewPollTimer);
          webviewPollTimer = null;
        }
        if (forceRefreshTimer) {
          clearInterval(forceRefreshTimer);
          forceRefreshTimer = null;
        }
        window.removeEventListener('scroll', schedule, true);
        window.removeEventListener('resize', schedule);
      }
    };
  }

  global.domRegion = { start };

})(window);
