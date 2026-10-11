var plugin = {
  name: "Name Letter Fill",
  controls: [
    { key: "name", label: "Name (blank = layer text)", type: "text", default: "" },
    { key: "width", label: "Frame Width (mm)", type: "range", min: 10, max: 200, step: 1, default: 60 },
    { key: "height", label: "Frame Height (mm)", type: "range", min: 10, max: 200, step: 1, default: 60 },
    { key: "gap", label: "Gap (mm)", type: "range", min: 0, max: 10, step: 0.5, default: 0 },
    { key: "overlap", label: "Touch overlap (mm)", type: "range", min: 0, max: 10, step: 0.5, default: 2 },
    { key: "cols", label: "Columns (0 = auto)", type: "range", min: 0, max: 8, step: 1, default: 0 },
    { key: "depth", label: "Thickness (mm)", type: "range", min: 1, max: 30, step: 0.5, default: 5 },
    { key: "depths", label: "Per-letter thickness (e.g. 3,6,3,6)", type: "text", default: "" },
    { key: "fit", label: "Fit", type: "select", options: ["fill", "keep-ratio"], default: "fill" }
  ],

  apply: function (obj, params, THREE) {
    if (!obj || !obj.geometry) return;

    var W = Math.max(5, Number(params.width) || 60);
    var H = Math.max(5, Number(params.height) || 60);
    var gap = Math.max(0, Number(params.gap) || 0);
    // Each letter is stretched by this much so neighbouring letters overlap
    // and touch (script fonts have empty corners that otherwise leave gaps)
    var overlap = Math.max(0, Number(params.overlap) || 0);
    // Layout area shrinks by the overlap so the outer edge stays inside the frame
    var Wc = Math.max(5, W - overlap);
    var Hc = Math.max(5, H - overlap);
    var depthDefault = Math.max(0.5, Number(params.depth) || 5);
    var fit = params.fit || "fill";

    // Font = the text layer's own font (changes live when the layer font changes).
    // Only opentype/canvas-type fonts can be used here; typeface-only fonts
    // (Default, Gentilis, Droid...) fall back to Montserrat.
    var fontKey = obj.userData.fontKey || "montserrat_canvas";
    if (!(window.CANVAS_FONT_KEYS && window.CANVAS_FONT_KEYS.has(fontKey))) {
      fontKey = "montserrat_canvas";
    }

    // Name: plugin box first, otherwise the text layer's own text
    var text = String(params.name || "").trim();
    if (!text) text = String((obj.userData.params && obj.userData.params.text) || "").trim();

    // Split into letter clusters. Combining marks (Tamil vowel signs etc.)
    // stay attached to the letter before them, and spaces are skipped.
    var clusters = [];
    Array.from(text).forEach(function (ch) {
      if (ch.trim() === "") return;
      if (clusters.length && /[\p{M}\u200D\uFE0F]/u.test(ch)) {
        clusters[clusters.length - 1] += ch;
      } else {
        clusters.push(ch);
      }
    });
    var n = clusters.length;
    if (n === 0) return;

    // Per-letter thickness list, e.g. "3,6,3,6"
    var depths = String(params.depths || "").split(",")
      .map(function (s) { return parseFloat(s); })
      .filter(function (v) { return v > 0; });
    function depthFor(i) {
      return depths.length ? depths[i % depths.length] : depthDefault;
    }

    // Font must be an opentype font. If it is not loaded yet, keep the plain
    // text for now and re-apply the plugin as soon as the font arrives.
    var otFont = window._otFontCache && window._otFontCache[fontKey];
    if (!otFont) {
      if (window._loadOTFont) {
        window._loadOTFont(fontKey).then(function () {
          if (obj.userData.pluginName !== plugin.name || !obj.userData.pluginEnabled) return;
          if (obj.userData._originalGeoData) {
            obj.geometry.dispose();
            obj.geometry = obj.userData._originalGeoData.clone();
          }
          plugin.apply(obj, obj.userData.pluginParams, THREE);
          if (window.updateLivePreview) window.updateLivePreview();
        }).catch(function () {});
      }
      return;
    }

    // Grid layout: letters fill the box, read left-to-right, top-to-bottom
    var cols = Math.round(Number(params.cols)) || 0;
    if (cols <= 0) cols = Math.max(1, Math.round(Math.sqrt(n * Wc / Hc)));
    cols = Math.min(cols, n);
    var rows = Math.ceil(n / cols);

    var cellW = (Wc - gap * (cols + 1)) / cols;
    var cellH = (Hc - gap * (rows + 1)) / rows;
    if (cellW <= 1 || cellH <= 1) return;

    var parts = [];
    for (var r = 0; r < rows; r++) {
      var inRow = Math.min(cols, n - r * cols);
      // last row is centred horizontally
      var rowOffset = (cols - inRow) * (cellW + gap) / 2;

      for (var c = 0; c < inRow; c++) {
        var i = r * cols + c;
        var d = depthFor(i);

        var g = window._buildOTGeo(otFont, clusters[i], 100, d, fontKey);
        if (!g) continue;

        g.computeBoundingBox();
        var bb = g.boundingBox;
        var bw = bb.max.x - bb.min.x;
        var bh = bb.max.y - bb.min.y;
        if (bw <= 0 || bh <= 0) continue;

        var sx = (cellW + overlap) / bw;
        var sy = (cellH + overlap) / bh;
        if (fit !== "fill") {
          var s = Math.min(sx, sy);
          sx = s;
          sy = s;
        }
        g.scale(sx, sy, 1);

        var cx = -Wc / 2 + gap + cellW / 2 + c * (cellW + gap) + rowOffset;
        var cy = Hc / 2 - gap - cellH / 2 - r * (cellH + gap);
        // geometry is centred, so lift by d/2 to keep every letter's base at z = 0
        g.translate(cx, cy, d / 2);
        parts.push(g);
      }
    }
    if (parts.length === 0) return;

    // Merge all letter geometries into one
    var total = 0;
    parts.forEach(function (g) { total += g.attributes.position.count; });

    var merged = new THREE.BufferGeometry();
    ["position", "normal", "uv"].forEach(function (name) {
      var sample = parts[0].attributes[name];
      if (!sample) return;
      var arr = new Float32Array(total * sample.itemSize);
      var off = 0;
      parts.forEach(function (g) {
        var a = g.attributes[name];
        if (!a) return;
        arr.set(a.array, off);
        off += a.array.length;
      });
      merged.setAttribute(name, new THREE.BufferAttribute(arr, sample.itemSize));
    });
    merged.computeVertexNormals();

    parts.forEach(function (g) { g.dispose(); });
    if (obj.geometry) obj.geometry.dispose();
    obj.geometry = merged;
  },

  reset: function (obj, THREE) {}
};

return plugin;
