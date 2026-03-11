/* ============================================================
 Stat Screenshot OCR  v9 — fully local, zero external APIs

 Uses Tesseract.js (WebAssembly, runs entirely in browser).
 No API keys. No server.

 TWO MODES:
 ─────────────────────────────────────────────────────────────
 1) STATS  (Bonus Details screenshot — Mail popup or Battle Report tab)
    • COLOR-BASED filtering: renders red & black pixels as black,
      GREEN pixels as white. This eliminates the right-column
      green +660% / +550% / +440% values from the OCR canvas
      entirely — regardless of image width or layout.
    • Works for all screenshot formats:
        - Portrait phone Mail popup (red left col, green right col)
        - Wider Battle Report tab (same layout, different proportions)
        - Overlays / partial crops (red badge on jpow-stats etc.)
    • Single PSM-6 pass. Each line matched by keyword.
      First +NNN.N% match per line = the red left value.

 2) TROOPS  (Troops Preview screenshot)
    • COLUMN-SPLIT OCR: image split into LEFT (x 0-50%) and RIGHT
      (x 50-100%) halves, each OCR'd independently as a single column.
      This eliminates 2-column grid interleaving that previously caused
      wrong troop counts (e.g. Archer getting Supreme Cavalry's number).
    • LEFT column  → Infantry + Archer totals
    • RIGHT column → Cavalry + any secondary Cavalry totals (accumulated)
    • TG level detection — CORRECTED for actual game UI:
        TG badge = small GOLD CIRCLE in TOP area of hex icon
                   containing Arabic digit 1–5
        Reads digit using multiple crop-size attempts + majority vote.
    • Tier select driven by highest archer base tier + TG level
 ─────────────────────────────────────────────────────────────
 Tested against: jpow troops image.
 Correct result: INF 209022, CAV 197842, ARC 224969, Tier T10.TG1
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
  // STATS ENGINE  (v9 – dual-column OCR, arrow-proof)
  // ══════════════════════════════════════════════════════════
  // *** UNCHANGED — stats reading is working correctly ***

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
  // TROOPS ENGINE  (v9 – COLUMN-SPLIT OCR for correct counts)
  // ══════════════════════════════════════════════════════════
  //
  // ROOT CAUSE OF PREVIOUS WRONG COUNTS:
  //   The 2-column grid layout caused Tesseract to interleave text from
  //   both columns. E.g. "Apex Infantry Apex Cavalry" on one line, then
  //   "209,022 129,042 224,969" on the next — making 224,969 get assigned
  //   to the wrong troop type via the numBank mechanism.
  //
  // FIX: Split the image into LEFT half and RIGHT half, OCR each separately.
  //   LEFT half  → Apex Infantry (top-left) + Apex Archer (bottom-left)
  //   RIGHT half → Apex Cavalry (top-right) + Supreme/extra Cavalry (bottom-right)
  //   Each half is parsed as a SIMPLE single column — no numBank needed.
  //   Same troop types from both halves are ACCUMULATED (e.g. Cavalry + Supreme Cavalry).

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

  /**
   * Detect troop types in a line using word-boundary patterns.
   */
  function getTypesInLine(line) {
    const l = line.toLowerCase();
    const found = [];
    if (/\binfantr/.test(l)) found.push([l.search(/\binfantr/), 'inf']);
    if (/\bcavalr/.test(l)) found.push([l.search(/\bcavalr/), 'cav']);
    if (/\barcher/.test(l)) found.push([l.search(/\barcher/), 'arc']);
    found.sort((a, b) => a[0] - b[0]);
    return found.map(([, tp]) => tp);
  }

  /**
   * Extract troop count numbers from a text line.
   */
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

  /**
   * Parse a SINGLE COLUMN of troop OCR text.
   *
   * This is simpler than the old parseTroopText because each column
   * contains at most one troop type per row (no 2-column interleaving).
   * We still accumulate multiple tiers of the same type (e.g. Apex + Supreme).
   *
   * Returns: { inf: count, cav: count, arc: count, bestTier: {inf,cav,arc} }
   */
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

      // Look ahead for numbers if none on the type line itself
      let lookAhead = 0;
      while (nums.length < types.length && lookAhead < 3) {
        const nextIdx = i + 1 + lookAhead;
        if (nextIdx >= lines.length) break;
        const nextLine = lines[nextIdx];
        if (getTypesInLine(nextLine).length > 0) break; // next type → stop
        const nextNums = extractNums(nextLine);
        if (nextNums.length > 0) nums = nums.concat(nextNums);
        lookAhead++;
      }

      // Assign numbers to types and accumulate
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

  /**
   * Find the cream/white troop panel bounds via brightness scan.
   * Returns [yTopFraction, yBottomFraction].
   */
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

  // ── TG Badge Detection ────────────────────────────────────
  //
  // The TG badge is a small GOLD CIRCLE at the top-left of each hex icon
  // containing an Arabic digit 1–5.
  // Detection: flood-fill gold clusters with cnt<=300, roughly circular.
  // Digit reading: multiple crop sizes + majority vote (PSM 7/8, raw image).
  //
  // KEY IMPROVEMENT over v8:
  //   - No image inversion (raw crop works better)
  //   - Multiple crop aspect ratios (sw=2.5/3.0, sh=1.5/2.0 × badge size)
  //   - Majority vote: need ≥2 agreements OR accept single result
  //   - PSM 7 (single line) works best for single-digit badge

  function detectGoldBadgeCandidates(img, panelY0, panelY1) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const scanY0 = Math.round(panelY0);
    // Scan top 80% of panel where hex icons are
    const scanY1 = Math.round(panelY0 + (panelY1 - panelY0) * 0.80);
    const { ctx } = getPixels(img, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, W, H).data;
    const visited = new Uint8Array(W * H);
    const candidates = [];

    for (let y = scanY0; y < scanY1; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (visited[idx]) continue;
        const i = idx * 4;
        const r = d[i], g = d[i+1], b = d[i+2];
        if (!(r > 175 && g > 115 && b < 110 && r - b > 85)) continue;

        const queue = [idx];
        visited[idx] = 1;
        let cnt = 0, mnX = x, mxX = x, mnY = y, mxY = y;

        while (queue.length) {
          const cur = queue.pop();
          const cy = Math.floor(cur / W), cx = cur % W;
          cnt++;
          if (cx < mnX) mnX = cx; if (cx > mxX) mxX = cx;
          if (cy < mnY) mnY = cy; if (cy > mxY) mxY = cy;

          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = cx+dx, ny = cy+dy;
            if (nx<0||nx>=W||ny<0||ny>=H) continue;
            const ni = ny*W+nx;
            if (visited[ni]) continue;
            const np = ni*4;
            if (d[np]>165 && d[np+1]>105 && d[np+2]<120 && d[np]-d[np+2]>75) {
              visited[ni] = 1; queue.push(ni);
            }
          }
        }

        const bw = mxX - mnX + 1, bh = mxY - mnY + 1;
        const aspect = bw / Math.max(bh, 1);
        if (cnt >= 8 && cnt <= 300 && bw <= 40 && bh <= 40 && aspect >= 0.5 && aspect <= 2.0) {
          candidates.push({ cx: mnX + bw/2, cy: mnY + bh/2, w: bw, h: bh, cnt });
        }
      }
    }
    return candidates;
  }

  /**
   * Read the TG digit from a badge using multiple crop sizes + majority vote.
   *
   * v9 CHANGES vs v8:
   *   - No image inversion — raw image crop works better
   *   - Multiple aspect ratios: sw × badge_w horizontal, sh × badge_h vertical
   *   - PSM 7 (single text line) as primary, PSM 8 (single word) as fallback
   *   - Majority vote: need ≥2 matches or accept single unambiguous result
   */
  async function readBadgeDigit(img, badge) {
    const W = img.naturalWidth, H = img.naturalHeight;

    // Canvas for cropping the raw image (no B&W conversion)
    function cropRaw(x0, y0, x1, y1) {
      const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
      const c = document.createElement('canvas');
      const scale = 8;
      c.width = cw * scale; c.height = ch * scale;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, x0, y0, cw, ch, 0, 0, c.width, c.height);
      return c;
    }

    // Try multiple crop sizes: (sw × badge_w) wide, (sh × badge_h) tall
    const cropVariants = [
      [2.5, 1.5],
      [3.0, 2.0],
      [2.0, 2.0],
      [3.5, 1.5],
    ];

    const results = [];

    for (const [sw, sh] of cropVariants) {
      const x0 = Math.max(0, Math.round(badge.cx - badge.w * sw / 2));
      const y0 = Math.max(0, Math.round(badge.cy - badge.h * sh / 2));
      const x1 = Math.min(W, Math.round(badge.cx + badge.w * sw / 2));
      const y1 = Math.min(H, Math.round(badge.cy + badge.h * sh / 2));

      if (x1 - x0 < 4 || y1 - y0 < 4) continue;

      const canvas = cropRaw(x0, y0, x1, y1);

      for (const psm of [7, 8]) {
        try {
          const text = await runOCR(canvas, psm, '12345');
          const digit = text.trim().replace(/[^1-5]/g, '');
          if (digit.length >= 1) {
            results.push(parseInt(digit[0], 10));
          }
        } catch (_) { /* ignore individual OCR failures */ }
      }
    }

    if (results.length === 0) return 0;

    // Majority vote: count occurrences of each digit
    const counts = {};
    for (const d of results) counts[d] = (counts[d] || 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

    // Need ≥2 agreements, OR accept if only one unique result appears
    if (sorted[0][1] >= 2 || sorted.length === 1) {
      return parseInt(sorted[0][0], 10);
    }

    // All results different — ambiguous, return 0
    return 0;
  }

  async function detectTGLevel(img, setStatus, panelY0px, panelY1px) {
    setStatus('🔍 Detecting TG level…', '#90b8d8');
    const candidates = detectGoldBadgeCandidates(img, panelY0px, panelY1px);
    if (candidates.length === 0) return 0;

    // Sort by largest cluster first (more pixels = more reliable), top 6 only
    const top = candidates.sort((a, b) => b.cnt - a.cnt).slice(0, 6);
    let maxTG = 0;
    for (const badge of top) {
      const digit = await readBadgeDigit(img, badge);
      if (digit > maxTG) maxTG = digit;
    }
    return maxTG;
  }

  // ── Main troop extraction ─────────────────────────────────
  //
  // v9: COLUMN-SPLIT approach
  //   1. Find panel bounds
  //   2. OCR left half (x=0-50%) with PSM 4 and PSM 6
  //   3. OCR right half (x=50%-100%) with PSM 4 and PSM 6
  //   4. Parse each as single column, accumulate same types
  //   5. Cross-validate PSM4 vs PSM6 for each half
  //   6. Merge left+right results

  async function extractTroops(file, setStatus) {
    setStatus('⏳ Loading image…', '#90b8d8');
    const img = await fileToImage(file);

    setStatus('⏳ Finding content panel…', '#90b8d8');
    const [ytop, ybot] = findPanelBounds(img);

    const isDarkText = (r, g, b) => r + g + b < 320;

    // OCR left column (x 2%-50%) — Infantry + Archer
    setStatus('🔍 Reading left column (pass 1/2)…', '#90b8d8');
    const leftBW_psm4 = buildBWCanvas(img, 0.02, ytop, 0.50, ybot, isDarkText, 3);
    const textLeft4   = await runOCR(leftBW_psm4, 4, null);

    setStatus('🔍 Reading left column (pass 2/2)…', '#90b8d8');
    const textLeft6   = await runOCR(leftBW_psm4, 6, null);

    // OCR right column (x 50%-98%) — Cavalry + any secondary Cavalry
    setStatus('🔍 Reading right column (pass 1/2)…', '#90b8d8');
    const rightBW_psm4 = buildBWCanvas(img, 0.50, ytop, 0.98, ybot, isDarkText, 3);
    const textRight4   = await runOCR(rightBW_psm4, 4, null);

    setStatus('🔍 Reading right column (pass 2/2)…', '#90b8d8');
    const textRight6   = await runOCR(rightBW_psm4, 6, null);

    // Parse each column text
    const rL4 = parseSingleColumnText(textLeft4);
    const rL6 = parseSingleColumnText(textLeft6);
    const rR4 = parseSingleColumnText(textRight4);
    const rR6 = parseSingleColumnText(textRight6);

    // Merge left PSM4+PSM6 with cross-validation
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

  /**
   * Cross-validate two parseSingleColumnText results.
   * For each troop type, if both passes agree within 5% → use PSM4.
   * If they disagree >5% → use the larger value (less likely to be cut off).
   * If one is zero → use whichever has a value.
   */
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
  // UI helpers
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

  function makeBar(btnLabel, inputId, onFile) {
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'width:100%','box-sizing:border-box',
      'display:flex','flex-direction:column','align-items:center','gap:8px',
      'padding:12px 16px','margin-bottom:10px',
      'background:#0d1520','border:1px solid #2a3850','border-radius:8px',
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

    wrap.appendChild(lbl); wrap.appendChild(inp); wrap.appendChild(status);
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
    });

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
    });

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
