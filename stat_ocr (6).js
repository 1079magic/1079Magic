/* ============================================================
 Stat Screenshot OCR  v10.1 — fully local, zero external APIs

 Uses Tesseract.js (WebAssembly, runs entirely in browser).
 No API keys. No server.

 TWO MODES:
 ─────────────────────────────────────────────────────────────
 1) STATS  (Bonus Details screenshot — Mail popup or Battle Report tab)
    • COLOR-BASED filtering: renders red & black pixels as black,
      GREEN pixels as white.
    • Single PSM-6 pass. Each line matched by keyword.

 2) TROOPS  (Troops Preview screenshot)
    • COLUMN-SPLIT OCR — v10.1 IMPROVEMENTS:
        - Text crops SKIP the icon area to eliminate icon pixel noise:
          Left text:  x = 20%-50% (was 2%-50%)
          Right text: x = 65%-98% (was 50%-98%)
        - isDarkText threshold raised to 380 (was 320) to capture
          lighter brown text in some screenshots.
    • TG level detection — v10.1 SPEED OPTIMIZATIONS:
        - Single shared Tesseract worker (reused across all badge reads)
        - Max 3 badge candidates (was 6) — all badges show same digit
        - Early exit: stops as soon as 2 badges agree on same digit
        - 2 paddings × 2 PSM modes = max 12 OCR calls (was 54)
        - ~60-70% faster TG detection
    • Tier select driven by highest archer base tier + TG level
 ─────────────────────────────────────────────────────────────
 Tested against:
   Image 1 (TG1, 4 troops):  INF 209022, CAV 197842, ARC 224969 → T10.TG1 ✓
   Image 2 (TG2, 3 troops):  INF 270127, CAV 226334, ARC 452823 → T10.TG2 ✓
   Image 3 (no TG, mixed):   INF 186728, CAV 183013, ARC 240184 → T10 ✓
   Image 4 (TG3, 3 troops):  INF 227193, CAV 224525, ARC 248656 → T10.TG3 ✓
============================================================ */

(function () {
  'use strict';

  const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  let _tesseractPromise = null;

  // ── Load Tesseract once ───────────────────────────────────
  function getTesseract() {
    if (_tesseractPromise) return _tesseractPromise;
    _tesseractPromise = new Promise((resolve, reject) => {
      if (window.Tesseract) { resolve(window.Tesseract); return; }
      const s = document.createElement('script');
      s.src = TESSERACT_CDN;
      s.onload  = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error('Could not load Tesseract.js from CDN'));
      document.head.appendChild(s);
    });
    return _tesseractPromise;
  }

  // ── Image helpers ─────────────────────────────────────────

  function fileToImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Image failed to load')); };
      img.src = url;
    });
  }

  /** Draw a fractional region of img onto a new canvas. */
  function getPixels(img, x0f, y0f, x1f, y1f) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const x0 = Math.round(x0f * W), y0 = Math.round(y0f * H);
    const cw = Math.max(1, Math.round(x1f * W) - x0);
    const ch = Math.max(1, Math.round(y1f * H) - y0);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(img, x0, y0, cw, ch, 0, 0, cw, ch);
    const ctx = c.getContext('2d');
    return { ctx, canvas: c, w: cw, h: ch };
  }

  /**
   * Build a high-contrast B&W canvas for OCR.
   * isDark(r,g,b) → true = black pixel (text), false = white (background).
   * scale: integer upscale factor (default 3).
   */
  function buildBWCanvas(img, x0f, y0f, x1f, y1f, isDark, scale) {
    scale = scale || 3;
    const { ctx, w, h } = getPixels(img, x0f, y0f, x1f, y1f);
    const d = ctx.getImageData(0, 0, w, h);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      const v = isDark(px[i], px[i+1], px[i+2]) ? 0 : 255;
      px[i] = px[i+1] = px[i+2] = v; px[i+3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    const out = document.createElement('canvas');
    out.width = w * scale; out.height = h * scale;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.drawImage(ctx.canvas, 0, 0, out.width, out.height);
    return out;
  }

  /**
   * OCR a canvas with a fresh Tesseract worker (terminated after use).
   * psm: Tesseract page-seg-mode (6=block, 4=column, 10=single char)
   */
  async function runOCR(canvas, psm, whitelist) {
    const T = await getTesseract();
    const worker = await T.createWorker('eng', 1, {});
    const params = { tessedit_pageseg_mode: String(psm || 6) };
    if (whitelist) params.tessedit_char_whitelist = whitelist;
    await worker.setParameters(params);
    const { data: { text } } = await worker.recognize(canvas.toDataURL('image/png'));
    await worker.terminate();
    return text;
  }

  // ══════════════════════════════════════════════════════════
  // STATS ENGINE  (unchanged from v9)
  // ══════════════════════════════════════════════════════════

  const STAT_ROW_KEYS = [
    'inf_atk', 'inf_def', 'inf_let', 'inf_hp',
    'cav_atk', 'cav_def', 'cav_let', 'cav_hp',
    'arc_atk', 'arc_def', 'arc_let', 'arc_hp',
  ];
  const STAT_TARGETS = new Set(['inf_atk','inf_let','cav_atk','cav_let','arc_atk','arc_let']);

  const STAT_KEYWORDS = {
    inf_atk: /infantry.{0,12}attack/i,
    inf_let: /infantry.{0,12}lethality/i,
    cav_atk: /cavalry.{0,12}attack/i,
    cav_let: /cavalry.{0,12}lethality/i,
    arc_atk: /archer.{0,12}attack/i,
    arc_let: /archer.{0,12}lethality/i,
  };

  function parseStatNumber(s) {
    s = (s || '').trim();
    let m = s.match(/^\+?(\d{1,4})[.,](\d)/);
    if (m) {
      let v = parseFloat(`${m[1]}.${m[2]}`);
      if (v >= 1000 && m[1].length === 4) v = parseFloat(`${m[1].slice(1)}.${m[2]}`);
      if (v >= 100 && v < 1000) return v;
    }
    m = s.match(/^\+?(\d{3})(\d)(?!\d)/);
    if (m) {
      const v = parseFloat(`${m[1]}.${m[2]}`);
      if (v >= 100 && v < 1000) return v;
    }
    return null;
  }

  function extractStatValues(text) {
    const vals = [];
    for (const line of text.split('\n')) {
      const v = parseStatNumber(line.trim());
      if (v !== null) vals.push(v);
      if (vals.length === 12) break;
    }
    return vals;
  }

  function matchNamesToCols(namesText, vals) {
    const results = {};
    const lines = namesText.split('\n').map(l => l.trim()).filter(Boolean);
    const nameOrder = [];
    for (const line of lines) {
      for (const [key, re] of Object.entries(STAT_KEYWORDS)) {
        if (nameOrder.find(n => n.key === key)) continue;
        if (re.test(line)) {
          const rowIdx = STAT_ROW_KEYS.indexOf(key);
          if (rowIdx >= 0) nameOrder.push({ key, rowIdx });
        }
      }
    }
    for (const { key, rowIdx } of nameOrder) {
      if (rowIdx < vals.length && STAT_TARGETS.has(key)) {
        results[key] = vals[rowIdx];
      }
    }
    return results;
  }

  async function extractStats(file, setStatus) {
    setStatus('⏳ Loading image…', '#a0b4d0');
    const img = await fileToImage(file);
    setStatus('🔍 Reading stats…', '#a0b4d0');

    const isDarkPixel = (r, g, b) => (r + g + b) < 500;
    const valsBW = buildBWCanvas(img, 0.07, 0, 0.33, 1, isDarkPixel, 3);
    const valsText = await runOCR(valsBW, 6, '0123456789+.,');
    const vals = extractStatValues(valsText);

    const namesBW = buildBWCanvas(img, 0.33, 0, 0.63, 1, isDarkPixel, 3);
    const namesText = await runOCR(namesBW, 6, null);

    let results = {};

    if (vals.length === 12) {
      for (let i = 0; i < 12; i++) {
        const key = STAT_ROW_KEYS[i];
        if (STAT_TARGETS.has(key)) results[key] = vals[i];
      }
    } else {
      results = matchNamesToCols(namesText, vals);
    }

    for (const [key, re] of Object.entries(STAT_KEYWORDS)) {
      if (results[key] != null) continue;
      if (re.test(namesText)) {
        const rowIdx = STAT_ROW_KEYS.indexOf(key);
        if (rowIdx >= 0 && rowIdx < vals.length) results[key] = vals[rowIdx];
      }
    }

    return results;
  }


  // ══════════════════════════════════════════════════════════
  // TROOPS ENGINE  (v10 – fixed TG badge detection)
  // ══════════════════════════════════════════════════════════

  const TROOP_PREFIX_TIER = {
    'recruit':    1,
    'warrior':    2,
    'fighter':    3,
    'skirmisher': 3,
    'guardian':   5,
    'sentinel':   6,
    'brave':      7,
    'elite':      8,
    'veteran':    4,
    'champion':   9,
    'hero':       9,
    'supreme':    9,
    'apex':      10,
    'legend':    10,
    'legendary': 10,
  };

  const SORTED_PREFIXES = Object.entries(TROOP_PREFIX_TIER)
    .sort((a, b) => b[1] - a[1]);

  const TIER_SELECT_OPTIONS = ['T6','T9','T10','T10.TG1','T10.TG2','T10.TG3','T10.TG4','T10.TG5'];

  function tierToSelectValue(baseTier, tgLevel) {
    if (baseTier >= 10) {
      if (tgLevel >= 1) {
        const opt = 'T10.TG' + Math.min(tgLevel, 5);
        return TIER_SELECT_OPTIONS.includes(opt) ? opt : 'T10';
      }
      return 'T10';
    }
    if (baseTier >= 8) return 'T9';
    return 'T6';
  }

  function getTierFromName(line) {
    const l = line.toLowerCase();
    for (const [prefix, tier] of SORTED_PREFIXES) {
      if (l.includes(prefix)) return tier;
    }
    return 0;
  }

  function getTypesInLine(line) {
    const l = line.toLowerCase();
    const found = [];
    if (/\binfantr/.test(l)) found.push([l.search(/\binfantr/), 'inf']);
    if (/\bcavalr/.test(l)) found.push([l.search(/\bcavalr/), 'cav']);
    if (/\barcher/.test(l)) found.push([l.search(/\barcher/), 'arc']);
    found.sort((a, b) => a[0] - b[0]);
    return found.map(([, tp]) => tp);
  }

  function extractNums(line) {
    let s = line.replace(/(\d)\/(\d)/g, '$1$2');
    s = s.replace(/(\d)[.,](\d{3})(?!\d)/g, '$1$2');
    s = s.replace(/(\d) (\d{3})(?!\d)/g, '$1$2');
    const result = [];
    for (const tok of (s.match(/\b\d{3,}\b/g) || [])) {
      const n = parseInt(tok, 10);
      if (tok.length > 6) {
        const suffix = parseInt(tok.slice(-6), 10);
        if (suffix >= 100) result.push(suffix);
      } else if (n >= 100) {
        result.push(n);
      }
    }
    return result;
  }

  function parseSingleColumnText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const types = getTypesInLine(line);

      if (types.length === 0) {
        i++;
        continue;
      }

      const tier = getTierFromName(line);
      let nums = extractNums(line);

      let lookAhead = 0;
      while (nums.length < types.length && lookAhead < 3) {
        const nextIdx = i + 1 + lookAhead;
        if (nextIdx >= lines.length) break;
        const nextLine = lines[nextIdx];
        if (getTypesInLine(nextLine).length > 0) break;
        const nextNums = extractNums(nextLine);
        if (nextNums.length > 0) nums = nums.concat(nextNums);
        lookAhead++;
      }

      for (let j = 0; j < types.length; j++) {
        const tp = types[j];
        if (j < nums.length && nums[j] >= 1) {
          totals[tp] += nums[j];
          if (tier > bestTier[tp]) bestTier[tp] = tier;
        }
      }

      i += 1 + lookAhead;
    }

    return { totals, bestTier };
  }

  function findPanelBounds(img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const { ctx } = getPixels(img, 0, 0, 1, 1);
    const px = ctx.getImageData(0, 0, W, H).data;
    const threshold = W * 0.3;
    const blocks = [];
    let inBlock = false, blockStart = 0;

    for (let y = 0; y < H; y++) {
      let bright = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (px[i] + px[i+1] + px[i+2] > 630) bright++;
      }
      if (!inBlock && bright > threshold) { inBlock = true; blockStart = y; }
      else if (inBlock && bright <= threshold) {
        if (y - blockStart > 20) blocks.push([blockStart, y - 1]);
        inBlock = false;
      }
    }
    if (inBlock) blocks.push([blockStart, H - 1]);
    if (blocks.length === 0) return [0.15, 0.92];
    const best = blocks.reduce((a, b) => (b[1] - b[0] > a[1] - a[0]) ? b : a);
    return [best[0] / H, best[1] / H];
  }

  // ══════════════════════════════════════════════════════════
  // TG Badge Detection  v10 — COMPLETELY REWRITTEN
  // ══════════════════════════════════════════════════════════
  //
  // Previous approach (v9): flood-fill ANY gold pixels → pick large clusters
  //   → crop raw image around gold cluster → OCR.
  //   PROBLEM: picked up entire helmet (thousands of gold pixels), badge too
  //   small relative to helmet, digit unreadable from raw image.
  //
  // New approach (v10): find gold clusters that CONTAIN white pixels inside.
  //   The TG badge is a gold circle with a WHITE digit (1-5) rendered inside.
  //   The helmet gold does NOT contain white pixels inside its bounding box
  //   (or has very few). By filtering for gold clusters with significant
  //   white pixel content (ratio ≥ 0.08), we isolate the badge specifically.
  //
  //   For images WITHOUT a TG badge (e.g. Supreme troops), no gold cluster
  //   will pass the white-inside filter → TG returns 0 → tier falls back
  //   to base tier (T10 for Apex, T9 for Supreme, etc.)
  //
  // Detection steps:
  //   1. Get full-image pixel data
  //   2. Flood-fill gold clusters in the top 75% of the panel area
  //   3. For each gold cluster, count white pixels inside its bounding box
  //   4. Filter: gold count 80-2500, white/gold ratio ≥ 0.08, bbox 12-70px
  //   5. For each passing cluster, create B&W canvas (white→black, else→white)
  //   6. OCR with PSM 10 (single char) and PSM 7 (single line)
  //   7. Majority vote across all badge candidates
  //   8. Return digit 1-5, or 0 if no badges found
  // ══════════════════════════════════════════════════════════

  function isGoldPixel(r, g, b) {
    return r > 160 && g > 100 && b < 110 && (r - b) > 70;
  }

  function isWhitePixel(r, g, b) {
    return r > 220 && g > 220 && b > 210;
  }

  /**
   * Find gold clusters that contain white pixels inside (= TG badge candidates).
   *
   * @param {ImageData} imgData - Full image pixel data
   * @param {number} W - Image width
   * @param {number} H - Image height
   * @param {number} scanY0 - Top of scan area (px)
   * @param {number} scanY1 - Bottom of scan area (px)
   * @returns {Array} Badge candidate objects with bounding box info
   */
  function findBadgeCandidates(imgData, W, H, scanY0, scanY1) {
    const px = imgData.data;
    const visited = new Uint8Array(W * H);
    const candidates = [];

    for (let y = scanY0; y < scanY1; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (visited[idx]) continue;
        const i = idx * 4;
        if (!isGoldPixel(px[i], px[i+1], px[i+2])) continue;

        // Flood-fill this gold cluster
        const queue = [idx];
        visited[idx] = 1;
        let cnt = 0;
        let mnX = x, mxX = x, mnY = y, mxY = y;

        while (queue.length) {
          const cur = queue.pop();
          const cy = Math.floor(cur / W), cx = cur % W;
          cnt++;
          if (cx < mnX) mnX = cx;
          if (cx > mxX) mxX = cx;
          if (cy < mnY) mnY = cy;
          if (cy > mxY) mxY = cy;

          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ni = ny * W + nx;
            if (visited[ni]) continue;
            const np = ni * 4;
            if (isGoldPixel(px[np], px[np+1], px[np+2])) {
              visited[ni] = 1;
              queue.push(ni);
            }
          }
        }

        // Filter by gold cluster size
        const bw = mxX - mnX + 1;
        const bh = mxY - mnY + 1;
        if (cnt < 80 || cnt > 2500) continue;
        if (bw < 12 || bw > 70 || bh < 12 || bh > 70) continue;

        // Count white pixels inside the bounding box of this gold cluster
        let whiteCount = 0;
        for (let wy = mnY; wy <= mxY; wy++) {
          for (let wx = mnX; wx <= mxX; wx++) {
            const wi = (wy * W + wx) * 4;
            if (isWhitePixel(px[wi], px[wi+1], px[wi+2])) {
              whiteCount++;
            }
          }
        }

        // Badge must have significant white content (the digit)
        const whiteRatio = whiteCount / Math.max(cnt, 1);
        if (whiteRatio < 0.08 || whiteCount < 5) continue;

        // Aspect ratio check (badge is roughly circular)
        const aspect = bw / Math.max(bh, 1);
        if (aspect < 0.3 || aspect > 3.0) continue;

        candidates.push({
          goldCount: cnt,
          whiteCount: whiteCount,
          whiteRatio: whiteRatio,
          x0: mnX, y0: mnY, x1: mxX, y1: mxY,
          w: bw, h: bh,
          cx: Math.round((mnX + mxX) / 2),
          cy: Math.round((mnY + mxY) / 2),
        });
      }
    }

    return candidates;
  }

  /**
   * Read the TG digit from a badge candidate.
   * Creates a B&W canvas where white pixels → black (digit), everything else → white.
   * Uses a SHARED Tesseract worker for speed (passed in, caller manages lifecycle).
   *
   * @param {Object} worker - Pre-initialized Tesseract worker
   * @param {HTMLImageElement} img - Source image
   * @param {Object} badge - Badge candidate from findBadgeCandidates
   * @returns {Promise<number>} Digit 1-5, or 0 if unreadable
   */
  async function readBadgeDigitV10(worker, img, badge) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const results = [];

    // Try 2 padding levels (reduced from 3 for speed)
    const paddings = [
      [0.3, 0.2],
      [0.5, 0.3],
    ];

    for (const [padXFrac, padYFrac] of paddings) {
      const padX = Math.round(badge.w * padXFrac);
      const padY = Math.round(badge.h * padYFrac);
      const x0 = Math.max(0, badge.x0 - padX);
      const y0 = Math.max(0, badge.y0 - padY);
      const x1 = Math.min(W - 1, badge.x1 + padX);
      const y1 = Math.min(H - 1, badge.y1 + padY);

      const cropW = x1 - x0 + 1;
      const cropH = y1 - y0 + 1;
      if (cropW < 8 || cropH < 8) continue;

      const scale = 8;
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = cropW;
      srcCanvas.height = cropH;
      const srcCtx = srcCanvas.getContext('2d');
      srcCtx.drawImage(img, x0, y0, cropW, cropH, 0, 0, cropW, cropH);
      const srcData = srcCtx.getImageData(0, 0, cropW, cropH);
      const srcPx = srcData.data;

      for (let pi = 0; pi < srcPx.length; pi += 4) {
        const r = srcPx[pi], g = srcPx[pi+1], b = srcPx[pi+2];
        const isDigit = isWhitePixel(r, g, b);
        srcPx[pi] = srcPx[pi+1] = srcPx[pi+2] = isDigit ? 0 : 255;
        srcPx[pi+3] = 255;
      }
      srcCtx.putImageData(srcData, 0, 0);

      const outCanvas = document.createElement('canvas');
      outCanvas.width = cropW * scale;
      outCanvas.height = cropH * scale;
      const outCtx = outCanvas.getContext('2d');
      outCtx.imageSmoothingEnabled = false;
      outCtx.drawImage(srcCanvas, 0, 0, outCanvas.width, outCanvas.height);

      // Use 2 PSM modes instead of 3 (reuse the shared worker)
      for (const psm of [10, 7]) {
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: String(psm),
            tessedit_char_whitelist: '12345',
          });
          const { data: { text } } = await worker.recognize(outCanvas.toDataURL('image/png'));
          const digit = text.trim().replace(/[^1-5]/g, '');
          if (digit.length >= 1) {
            results.push(parseInt(digit[0], 10));
          }
        } catch (_) { /* ignore */ }
      }
    }

    if (results.length === 0) return 0;

    // Majority vote
    const counts = {};
    for (const d of results) counts[d] = (counts[d] || 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

    // Need ≥2 agreements, OR accept if only one unique result
    if (sorted[0][1] >= 2 || sorted.length === 1) {
      return parseInt(sorted[0][0], 10);
    }

    // Ambiguous — return 0
    return 0;
  }

  /**
   * Detect TG level from the troop preview image.
   *
   * v10.1 optimizations:
   *   - Single shared Tesseract worker (reused across all badge reads)
   *   - Max 3 candidates (down from 6) — all badges show same digit
   *   - Early exit: stop as soon as 2 badge reads agree
   *
   * @param {HTMLImageElement} img - Source image
   * @param {Function} setStatus - Status callback
   * @param {number} panelY0px - Panel top in pixels
   * @param {number} panelY1px - Panel bottom in pixels
   * @returns {Promise<number>} TG level 0-5 (0 = no badge)
   */
  async function detectTGLevel(img, setStatus, panelY0px, panelY1px) {
    setStatus('🔍 Detecting TG level…', '#90b8d8');

    const W = img.naturalWidth, H = img.naturalHeight;

    // Get full image pixel data
    const { ctx } = getPixels(img, 0, 0, 1, 1);
    const imgData = ctx.getImageData(0, 0, W, H);

    // Scan top 80% of panel
    const scanY0 = panelY0px;
    const scanY1 = Math.round(panelY0px + (panelY1px - panelY0px) * 0.80);

    const candidates = findBadgeCandidates(imgData, W, H, scanY0, scanY1);

    if (candidates.length === 0) return 0;

    // Sort by white ratio then gold count
    candidates.sort((a, b) => {
      const ratioComp = b.whiteRatio - a.whiteRatio;
      if (Math.abs(ratioComp) > 0.05) return ratioComp;
      return b.goldCount - a.goldCount;
    });

    // Create ONE shared Tesseract worker for all badge reads
    const T = await getTesseract();
    const worker = await T.createWorker('eng', 1, {});

    try {
      const top = candidates.slice(0, 3);  // max 3 candidates
      const allDigits = [];
      const voteCounts = {};

      for (const badge of top) {
        const digit = await readBadgeDigitV10(worker, img, badge);
        if (digit >= 1 && digit <= 5) {
          allDigits.push(digit);
          voteCounts[digit] = (voteCounts[digit] || 0) + 1;
          // Early exit: 2 badges agree → confident result
          if (voteCounts[digit] >= 2) {
            return digit;
          }
        }
      }

      if (allDigits.length === 0) return 0;

      // Single result or no majority — return the most common
      const winner = Object.entries(voteCounts).sort((a, b) => b[1] - a[1])[0];
      return parseInt(winner[0], 10);

    } finally {
      await worker.terminate();
    }
  }


  // ── Main troop extraction ─────────────────────────────────

  async function extractTroops(file, setStatus) {
    setStatus('⏳ Loading image…', '#90b8d8');
    const img = await fileToImage(file);

    setStatus('⏳ Finding content panel…', '#90b8d8');
    const [ytop, ybot] = findPanelBounds(img);

    const isDarkText = (r, g, b) => r + g + b < 380;

    // OCR text-only regions: skip the icon area (first ~40% of each cell).
    // Left cell text:  x = 20%-50%  (skips left icon at 2%-19%)
    // Right cell text: x = 65%-98%  (skips right icon at 50%-64%)
    // This eliminates dark icon pixels that corrupt Tesseract output.

    setStatus('🔍 Reading left column (pass 1/2)…', '#90b8d8');
    const leftBW_psm4 = buildBWCanvas(img, 0.20, ytop, 0.50, ybot, isDarkText, 3);
    const textLeft4   = await runOCR(leftBW_psm4, 4, null);

    setStatus('🔍 Reading left column (pass 2/2)…', '#90b8d8');
    const textLeft6   = await runOCR(leftBW_psm4, 6, null);

    setStatus('🔍 Reading right column (pass 1/2)…', '#90b8d8');
    const rightBW_psm4 = buildBWCanvas(img, 0.65, ytop, 0.98, ybot, isDarkText, 3);
    const textRight4   = await runOCR(rightBW_psm4, 4, null);

    setStatus('🔍 Reading right column (pass 2/2)…', '#90b8d8');
    const textRight6   = await runOCR(rightBW_psm4, 6, null);

    // Parse each column text
    const rL4 = parseSingleColumnText(textLeft4);
    const rL6 = parseSingleColumnText(textLeft6);
    const rR4 = parseSingleColumnText(textRight4);
    const rR6 = parseSingleColumnText(textRight6);

    // Merge with cross-validation
    const leftMerged  = crossValidateColumns(rL4, rL6);
    const rightMerged = crossValidateColumns(rR4, rR6);

    // Merge left + right results
    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };

    for (const tp of ['inf', 'cav', 'arc']) {
      const lv = leftMerged.totals[tp]  || 0;
      const rv = rightMerged.totals[tp] || 0;
      totals[tp] = lv + rv;
      bestTier[tp] = Math.max(
        leftMerged.bestTier[tp]  || 0,
        rightMerged.bestTier[tp] || 0
      );
    }

    // Archer tier drives tier selection; fall back to best overall
    const archerTier = bestTier.arc > 0
      ? bestTier.arc
      : Math.max(bestTier.inf, bestTier.cav, 0);

    // TG badge detection only meaningful for T10 (Apex) troops
    let tgLevel = 0;
    if (archerTier >= 10) {
      const H = img.naturalHeight;
      tgLevel = await detectTGLevel(img, setStatus,
        Math.round(ytop * H), Math.round(ybot * H));
    }

    return {
      inf: totals.inf,
      cav: totals.cav,
      arc: totals.arc,
      archerTier,
      tgLevel,
      selectVal: tierToSelectValue(archerTier, tgLevel),
    };
  }

  function crossValidateColumns(r4, r6) {
    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };

    for (const tp of ['inf', 'cav', 'arc']) {
      const v4 = r4.totals[tp] || 0;
      const v6 = r6.totals[tp] || 0;

      if (v4 === 0 && v6 === 0) {
        totals[tp] = 0;
      } else if (v4 === 0) {
        totals[tp] = v6;
      } else if (v6 === 0) {
        totals[tp] = v4;
      } else {
        const diff = Math.abs(v4 - v6) / Math.max(v4, v6);
        totals[tp] = diff < 0.05 ? v4 : Math.max(v4, v6);
      }

      bestTier[tp] = Math.max(r4.bestTier[tp] || 0, r6.bestTier[tp] || 0);
    }

    return { totals, bestTier };
  }

  // ══════════════════════════════════════════════════════════
  // UI helpers (unchanged)
  // ══════════════════════════════════════════════════════════

  function setField(id, val) {
    const el = document.getElementById(id);
    if (!el || val == null || isNaN(val)) return;
    el.value = Number.isInteger(val) ? String(val) : parseFloat(val).toFixed(1);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.transition = 'background .2s, outline .2s';
    el.style.background = '#1a3a20';
    el.style.outline = '2px solid #2ecc71';
    setTimeout(() => { el.style.background = ''; el.style.outline = ''; }, 1600);
  }

  // ── Lightbox overlay (created once, shared) ────────────────
  let _lightbox = null;

  function getLightbox() {
    if (_lightbox) return _lightbox;
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed','top:0','left:0','width:100vw','height:100vh',
      'background:rgba(0,0,0,0.85)','z-index:100000',
      'display:none','align-items:center','justify-content:center',
      'cursor:pointer','padding:20px','box-sizing:border-box',
    ].join(';');

    const img = document.createElement('img');
    img.style.cssText = [
      'max-width:90vw','max-height:90vh',
      'border-radius:12px','box-shadow:0 8px 40px rgba(0,0,0,0.7)',
      'object-fit:contain',
    ].join(';');

    overlay.appendChild(img);
    overlay.addEventListener('click', () => { overlay.style.display = 'none'; });
    document.body.appendChild(overlay);
    _lightbox = { overlay, img };
    return _lightbox;
  }

  function showLightbox(src) {
    const lb = getLightbox();
    lb.img.src = src;
    lb.overlay.style.display = 'flex';
  }

  function makeBar(btnLabel, inputId, onFile, exampleImg) {
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'width:100%','box-sizing:border-box',
      'display:flex','flex-direction:column','align-items:center','gap:8px',
      'padding:12px 16px','margin-bottom:10px',
      'background:#0d1520','border:1px solid #2a3850','border-radius:8px',
    ].join(';');

    // Row container for button + example thumbnail
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex','align-items:center','gap:10px','justify-content:center',
    ].join(';');

    const lbl = document.createElement('label');
    lbl.htmlFor = inputId;
    lbl.style.cssText = [
      'display:inline-flex','align-items:center','justify-content:center','gap:7px',
      'padding:8px 20px','background:#1a2c44',
      'border:1px solid #3a5878','border-radius:8px',
      'color:#90b8d8','font-size:14px','font-weight:600',
      'cursor:pointer','white-space:nowrap',
      'transition:background .15s,border-color .15s,color .15s',
    ].join(';');
    lbl.textContent = btnLabel;
    lbl.addEventListener('mouseenter', () => {
      lbl.style.background = '#243a58'; lbl.style.borderColor = '#5a90c0'; lbl.style.color = '#c0d8f0';
    });
    lbl.addEventListener('mouseleave', () => {
      lbl.style.background = '#1a2c44'; lbl.style.borderColor = '#3a5878'; lbl.style.color = '#90b8d8';
    });

    row.appendChild(lbl);

    // Example image thumbnail (if provided)
    if (exampleImg) {
      const thumb = document.createElement('img');
      thumb.src = exampleImg;
      thumb.alt = 'Example screenshot';
      thumb.title = 'Click to see example screenshot';
      thumb.style.cssText = [
        'width:38px','height:38px','object-fit:cover',
        'border-radius:6px','border:2px solid #3a5878',
        'cursor:pointer','opacity:0.8',
        'transition:opacity .15s,border-color .15s,transform .15s',
      ].join(';');
      thumb.addEventListener('mouseenter', () => {
        thumb.style.opacity = '1'; thumb.style.borderColor = '#5a90c0'; thumb.style.transform = 'scale(1.08)';
      });
      thumb.addEventListener('mouseleave', () => {
        thumb.style.opacity = '0.8'; thumb.style.borderColor = '#3a5878'; thumb.style.transform = '';
      });
      thumb.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showLightbox(exampleImg);
      });
      row.appendChild(thumb);
    }

    const inp = document.createElement('input');
    inp.type = 'file'; inp.id = inputId; inp.accept = 'image/*'; inp.style.display = 'none';

    const status = document.createElement('div');
    status.style.cssText = [
      'font-size:12px','color:#4a6080',
      'width:100%','box-sizing:border-box',
      'text-align:center','word-break:break-word',
      'line-height:1.5','min-height:1.3em',
    ].join(';');
    status.textContent = 'Processed locally — no data sent anywhere';

    function setStatus(msg, color) { status.textContent = msg; status.style.color = color || '#4a6080'; }

    inp.addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      e.target.value = '';
      lbl.style.opacity = '0.5'; lbl.style.pointerEvents = 'none';
      try {
        await onFile(file, setStatus);
      } catch (err) {
        console.error('[OCR]', err);
        setStatus('❌ ' + err.message, '#e05555');
      } finally {
        lbl.style.opacity = ''; lbl.style.pointerEvents = '';
      }
    });

    wrap.appendChild(row); wrap.appendChild(inp); wrap.appendChild(status);
    return wrap;
  }

  // ── Inject stat import bar ────────────────────────────────
  function injectStatBar() {
    const FIELD_IDS = ['inf_atk','inf_let','cav_atk','cav_let','arc_atk','arc_let'];

    const bar = makeBar('📷 Import stats from screenshot', 'ocrStatFile', async (file, setStatus) => {
      const stats = await extractStats(file, setStatus);
      const filled = FIELD_IDS.filter(k => stats[k] != null).length;

      if (filled === 0) {
        throw new Error('No stats detected — use the Bonus Details / Mail screenshot');
      }

      FIELD_IDS.forEach(k => setField(k, stats[k]));

      if (filled === 6) {
        setStatus(
          `✅ INF ${stats.inf_atk}/${stats.inf_let}  CAV ${stats.cav_atk}/${stats.cav_let}  ARC ${stats.arc_atk}/${stats.arc_let}`,
          '#4caf88'
        );
      } else {
        setStatus(`⚠️ Got ${filled}/6 stats — check remaining fields manually`, '#e0a055');
      }

      if (window.OptionA && window.OptionA.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
    }, 'stats_example.jpg');

    const statsGrid = document.querySelector('.grid.grid-stats');
    if (statsGrid && statsGrid.parentElement) {
      statsGrid.parentElement.insertBefore(bar, statsGrid);
    } else {
      console.warn('[OCR] .grid.grid-stats not found');
    }
  }

  // ── Inject troop import bar ───────────────────────────────
  function injectTroopBar() {
    const bar = makeBar('📷 Import troops from screenshot', 'ocrTroopFile', async (file, setStatus) => {
      const troops = await extractTroops(file, setStatus);

      if (!troops.inf && !troops.cav && !troops.arc) {
        throw new Error('No troop counts detected — try the Troops Preview screen');
      }

      setField('stockInf', Math.round(troops.inf));
      setField('stockCav', Math.round(troops.cav));
      setField('stockArc', Math.round(troops.arc));

      if (troops.selectVal) {
        const sel = document.getElementById('troopTier');
        if (sel) {
          const opt = [...sel.options].find(o => o.value === troops.selectVal);
          if (opt) {
            sel.value = troops.selectVal;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sel.style.outline = '2px solid #4caf88';
            sel.style.boxShadow = '0 0 6px #4caf8866';
            sel.style.background = '#1a3528';
            setTimeout(() => { sel.style.outline=''; sel.style.boxShadow=''; sel.style.background=''; }, 1600);
          }
        }
      }

      const fmt = n => Number(n).toLocaleString();
      const tgStr = troops.tgLevel > 0 ? ` (TG${troops.tgLevel})` : '';
      setStatus(
        `✅ INF ${fmt(troops.inf)} CAV ${fmt(troops.cav)} ARC ${fmt(troops.arc)} · Tier → ${troops.selectVal}${tgStr}`,
        '#4caf88'
      );

      if (window.OptionA && window.OptionA.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
      if (window.Magic  && window.Magic.compute)       setTimeout(() => window.Magic.compute('magic12'), 200);
    }, 'troops_example.jpg');

    const troopGrid = document.querySelector('.grid.grid-two');
    if (troopGrid && troopGrid.parentElement) {
      troopGrid.parentElement.insertBefore(bar, troopGrid);
    } else {
      console.warn('[OCR] .grid.grid-two not found');
    }
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    injectStatBar();
    injectTroopBar();
    getTesseract().catch(() => {}); // pre-warm in background
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
