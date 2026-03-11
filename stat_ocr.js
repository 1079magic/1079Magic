/* ============================================================
 Stat Screenshot OCR  v8 — fully local, zero external APIs

 Uses Tesseract.js (WebAssembly, runs entirely in browser).
 No API keys. No server. No network calls beyond loading
 Tesseract itself from CDN once.

 TWO MODES:
 ─────────────────────────────────────────────────────────────
 1) STATS  (Bonus Details / Mail screenshot)
    • OCR restricted to LEFT 72% of image only
      → FIXES: was previously picking up right-column green +660%
        values. Layout is [RED left%] [Stat Name center] [GREEN right%]
        Cropping to 72% captures red values + stat names, excludes green.
    • PSM-6 full pass on cropped region
    • Each line matched by keyword: "Infantry Attack", etc.
    • First +NNN.N% on matching line → stat value (the red left value)

 2) TROOPS  (Troops Preview screenshot)
    • COMPLETELY REWRITTEN — single full-panel OCR instead of
      unreliable left/right column splitting
    • Single PSM-6 pass on full cream panel area
    • Parser scans line by line:
        – Detects troop name line (Infantry/Cavalry/Archer keyword)
        – Extracts tier from troop name prefix (Elite=T8, Apex=T10, etc.)
        – Reads count from same line or next line
        – ACCUMULATES all tiers per type (Elite+Brave+Veteran all sum up)
    • TG level detection — FIXED based on actual game UI:
        The TG badge is a small GOLD CIRCLE in the TOP-LEFT corner
        of the hexagon icon, containing an Arabic digit (1, 2, 3, 4, 5).
        The Roman numeral badge at the BOTTOM of the hex is the TROOP
        TIER (I=T1 ... X=T10), NOT the TG level.
        Detection: scan for gold circular clusters in top-left quadrant
        of each troop icon region, OCR the Arabic digit inside.
    • Tier select: based on highest archer base tier + TG level
 ─────────────────────────────────────────────────────────────
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

  /**
   * Draw a fractional region of img onto a new canvas.
   * x0f/y0f/x1f/y1f are 0–1 fractions of natural width/height.
   */
  function getRegionCanvas(img, x0f, y0f, x1f, y1f) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const x0 = Math.round(x0f * W), y0 = Math.round(y0f * H);
    const cw = Math.max(1, Math.round(x1f * W) - x0);
    const ch = Math.max(1, Math.round(y1f * H) - y0);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(img, x0, y0, cw, ch, 0, 0, cw, ch);
    return c;
  }

  /**
   * Get raw pixel data for a fractional region.
   */
  function getPixels(img, x0f, y0f, x1f, y1f) {
    const c = getRegionCanvas(img, x0f, y0f, x1f, y1f);
    const ctx = c.getContext('2d');
    return { ctx, canvas: c, w: c.width, h: c.height };
  }

  /**
   * Build a high-contrast black-on-white B&W canvas for OCR.
   * isDark(r,g,b) → true = render as black (text) pixel.
   * scale: integer upscale factor for better OCR accuracy (default 3).
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
   * OCR a canvas with a fresh Tesseract worker.
   * psm: page-seg-mode (6=uniform block, 7=single line, 10=single char)
   * whitelist: char whitelist string or null.
   * Worker is terminated after use.
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
  // STATS ENGINE  (v8 – LEFT 72% CROP to avoid green right column)
  // ══════════════════════════════════════════════════════════
  //
  // The Bonus Details screen layout per row:
  //   [RED +420.0%]   [Infantry Attack]   [GREEN +660.0%]
  //    ~0-25%              ~25-70%              ~70-100%
  //
  // By cropping to x=0..0.72 we capture the red left values AND the
  // stat name text, but exclude the green right column entirely.
  // This prevents the engine from ever reading +660 as a stat value.

  const STAT_KEYWORDS = {
    inf_atk: /infantry.{0,12}attack/i,
    inf_let: /infantry.{0,12}lethality/i,
    cav_atk: /cavalry.{0,12}attack/i,
    cav_let: /cavalry.{0,12}lethality/i,
    arc_atk: /archer.{0,12}attack/i,
    arc_let: /archer.{0,12}lethality/i,
  };

  function parseStatsFromText(text) {
    const results = {};
    for (const line of text.split('\n')) {
      for (const [key, re] of Object.entries(STAT_KEYWORDS)) {
        if (key in results) continue;
        if (!re.test(line)) continue;
        // Grab first +NNN.N% pattern on this line — that's the red left value
        const m = line.match(/\+(\d{2,4})[.,](\d)/);
        if (m) results[key] = parseFloat(`${m[1]}.${m[2]}`);
      }
    }
    return results;
  }

  async function extractStats(file, setStatus) {
    setStatus('⏳ Loading image…', '#a0b4d0');
    const img = await fileToImage(file);
    setStatus('🔍 Reading stats…', '#a0b4d0');

    // Crop to left 72%: captures red values + center stat names, skips green right col
    const bw = buildBWCanvas(img, 0, 0, 0.72, 1,
      (r, g, b) => r + g + b < 500,
      2
    );
    const text = await runOCR(bw, 6, null);
    return parseStatsFromText(text);
  }

  // ══════════════════════════════════════════════════════════
  // TROOPS ENGINE  (v8 – single-pass full OCR + correct TG detection)
  // ══════════════════════════════════════════════════════════

  // Troop name prefix → base tier number
  // Used for tier select dropdown logic
  const TROOP_PREFIX_TIER = {
    // T1-T6 range → map to T6 in dropdown
    'recruit':    1,
    'warrior':    2,
    'fighter':    3,
    'skirmisher': 3,
    'guardian':   5,
    'sentinel':   6,
    // T7
    'brave':      7,
    // T8
    'elite':      8,
    // T9
    'veteran':    4,   // veteran is actually T4 in game naming
    'champion':   9,
    'hero':       9,
    'supreme':    9,
    // T10
    'apex':      10,
    'legend':    10,
    'legendary': 10,
  };

  // Sorted by tier descending so highest match wins
  const SORTED_PREFIXES = Object.entries(TROOP_PREFIX_TIER)
    .sort((a, b) => b[1] - a[1]);

  const TIER_SELECT_OPTIONS = ['T6','T9','T10','T10.TG1','T10.TG2','T10.TG3','T10.TG4','T10.TG5'];

  function tierToSelectValue(baseTier, tgLevel) {
    if (baseTier >= 10) {
      if (tgLevel >= 1) {
        const clamped = Math.min(tgLevel, 5);
        const opt = 'T10.TG' + clamped;
        return TIER_SELECT_OPTIONS.includes(opt) ? opt : 'T10';
      }
      return 'T10';
    }
    if (baseTier >= 8) return 'T9';
    return 'T6';
  }

  /**
   * Get the base tier for a troop name line.
   * Checks for known prefix words (apex, elite, supreme, etc.)
   */
  function getTierFromName(line) {
    const l = line.toLowerCase();
    for (const [prefix, tier] of SORTED_PREFIXES) {
      if (l.includes(prefix)) return tier;
    }
    return 0;
  }

  /**
   * Detect what troop TYPE(s) appear in a line.
   * Uses word-boundary patterns to prevent false matches
   * (e.g. "March" should not trigger "arc" for Archer).
   * Returns array of matched types: 'inf', 'cav', 'arc'
   */
  function getTypesInLine(line) {
    const l = line.toLowerCase();
    const found = [];
    // Word-boundary checks to avoid partial matches
    if (/\binfantr/.test(l)) found.push([l.search(/\binfantr/), 'inf']);
    if (/\bcavalr/.test(l)) found.push([l.search(/\bcavalr/), 'cav']);
    if (/\barcher/.test(l)) found.push([l.search(/\barcher/), 'arc']);
    // Sort by position (left to right)
    found.sort((a, b) => a[0] - b[0]);
    return found.map(([, tp]) => tp);
  }

  /**
   * Extract troop count numbers from a text line.
   * Handles all common OCR number formats:
   *   274,033  274.033  274 033  274033
   *   Slash artifact: 2/4033 → 24033
   *   7-digit garble: 6359717 → take last 6 digits (359717)
   */
  function extractNums(line) {
    // Fix slash OCR artifact (comma read as slash)
    let s = line.replace(/(\d)\/(\d)/g, '$1$2');
    // Normalize thousands separators: comma/period/space between digit groups
    s = s.replace(/(\d)[.,](\d{3})(?!\d)/g, '$1$2');
    s = s.replace(/(\d) (\d{3})(?!\d)/g, '$1$2');

    const result = [];
    const matches = s.match(/\b\d{3,}\b/g) || [];
    for (const tok of matches) {
      const n = parseInt(tok, 10);
      if (tok.length > 6) {
        // 7+ digit OCR garble — last 6 digits heuristic
        const suffix = parseInt(tok.slice(-6), 10);
        if (suffix >= 100) result.push(suffix);
      } else if (n >= 100) {
        result.push(n);
      }
    }
    return result;
  }

  /**
   * Find the content panel bounds (the cream/white troop list area).
   * Scans rows for brightness to locate the main light panel.
   * Returns [yTopFraction, yBottomFraction] of the panel.
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

    // Use the largest bright block
    const best = blocks.reduce((a, b) => (b[1] - b[0] > a[1] - a[0]) ? b : a);
    return [best[0] / H, best[1] / H];
  }

  /**
   * Parse OCR text from the troop panel into totals and best tiers.
   * Strategy:
   *   - Scan line by line
   *   - When a line contains a troop type keyword, record the type + tier
   *   - Look for numbers on same line or immediately following lines
   *   - Accumulate counts per type (all tiers summed)
   *   - Track highest base tier per type
   */
  function parseTroopText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const types = getTypesInLine(line);

      if (types.length === 0) { i++; continue; }

      const tier = getTierFromName(line);
      let nums = extractNums(line);

      // Lookahead: scan up to 3 following lines for missing counts
      // Stop if we hit another type-keyword line
      let lookAhead = 0;
      while (nums.length < types.length && lookAhead < 3) {
        const nextIdx = i + 1 + lookAhead;
        if (nextIdx >= lines.length) break;
        const nextLine = lines[nextIdx];
        if (getTypesInLine(nextLine).length > 0) break; // next troop block started
        const nextNums = extractNums(nextLine);
        if (nextNums.length > 0) {
          nums = nums.concat(nextNums);
        }
        lookAhead++;
      }

      // Assign numbers to types in left-to-right order
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

  // ── TG Badge Detection ────────────────────────────────────
  //
  // IMPORTANT — How TG badges work in game (from annotated screenshot):
  //
  //   Each Apex troop hexagon icon has TWO badge overlays:
  //
  //   1) TOP-LEFT corner: small GOLD CIRCLE with ARABIC digit (1, 2, 3, 4, 5)
  //      → This is the TG LEVEL badge (Training Ground upgrade level)
  //      → This is what we need to detect!
  //
  //   2) BOTTOM of hex: small badge with ROMAN NUMERAL (I, II, ... X)
  //      → This is the TROOP TIER (T1=I, T9=IX, T10=X)
  //      → NOT the TG level — do not read this for TG
  //
  // Detection approach:
  //   - Find gold circular clusters (R>180, G>120, B<120, R-B>80)
  //   - Small size (under 40px), roughly circular
  //   - OCR with digit whitelist '12345' (valid TG range)
  //   - Take the highest digit found (most reliable read)

  function detectTGBadgeCandidates(img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const { ctx } = getPixels(img, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, W, H).data;
    const visited = new Uint8Array(W * H);
    const candidates = [];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (visited[idx]) continue;

        const i = idx * 4;
        const r = d[i], g = d[i+1], b = d[i+2];

        // Gold pixel: high red, medium-high green, low blue
        if (!(r > 175 && g > 115 && b < 110 && r - b > 85)) continue;

        // Flood fill the gold cluster
        const queue = [idx];
        visited[idx] = 1;
        let cnt = 0, mnX = x, mxX = x, mnY = y, mxY = y;

        while (queue.length) {
          const cur = queue.pop();
          const cy = Math.floor(cur / W);
          const cx = cur % W;
          cnt++;
          if (cx < mnX) mnX = cx; if (cx > mxX) mxX = cx;
          if (cy < mnY) mnY = cy; if (cy > mxY) mxY = cy;

          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const ni = ny * W + nx;
            if (visited[ni]) continue;
            const np = ni * 4;
            if (d[np] > 165 && d[np+1] > 105 && d[np+2] < 120 && d[np] - d[np+2] > 75) {
              visited[ni] = 1;
              queue.push(ni);
            }
          }
        }

        const bw = mxX - mnX + 1;
        const bh = mxY - mnY + 1;
        const aspect = bw / Math.max(bh, 1);

        // Filter: small enough to be an icon badge, roughly circular
        if (cnt >= 10 && bw <= 50 && bh <= 50 && aspect >= 0.5 && aspect <= 2.0) {
          candidates.push({
            cx: mnX + bw / 2,
            cy: mnY + bh / 2,
            w: bw, h: bh, cnt
          });
        }
      }
    }

    return candidates;
  }

  /**
   * OCR a single TG badge candidate.
   * The badge is a gold circle with a white Arabic digit inside (1-5).
   * We invert: white digit text → black on white background.
   */
  async function readTGBadgeDigit(img, badge) {
    const W = img.naturalWidth, H = img.naturalHeight;

    // Expand crop area generously around the badge center
    const pad = Math.max(badge.w, badge.h) * 1.2;
    const bx0 = Math.max(0, Math.round(badge.cx - pad));
    const by0 = Math.max(0, Math.round(badge.cy - pad));
    const bx1 = Math.min(W, Math.round(badge.cx + pad));
    const by1 = Math.min(H, Math.round(badge.cy + pad));
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw < 4 || bh < 4) return 0;

    // Draw at 10x scale for single-digit OCR accuracy
    const scale = 10;
    const bc = document.createElement('canvas');
    bc.width = bw * scale; bc.height = bh * scale;
    const bctx = bc.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(img, bx0, by0, bw, bh, 0, 0, bc.width, bc.height);

    // Convert: white/light digit pixels → black; gold background → white
    const bid = bctx.getImageData(0, 0, bc.width, bc.height);
    const bd = bid.data;
    for (let k = 0; k < bd.length; k += 4) {
      const r = bd[k], g = bd[k+1], b = bd[k+2];
      // White/light pixels (the digit text) → black
      const isLight = r > 200 && g > 180 && b > 155;
      // Also catch slightly off-white
      const isText = r > 185 && g > 170 && b > 140 && Math.max(r,g,b) - Math.min(r,g,b) < 40;
      bd[k] = bd[k+1] = bd[k+2] = (isLight || isText) ? 0 : 255;
      bd[k+3] = 255;
    }
    bctx.putImageData(bid, 0, 0);

    try {
      // PSM 10 = single character, whitelist only valid TG digits 1-5
      const text = await runOCR(bc, 10, '12345');
      const digit = text.trim().replace(/[^1-5]/g, '');
      if (digit.length === 1) return parseInt(digit, 10);
    } catch (_) { /* ignore */ }
    return 0;
  }

  /**
   * Main TG detection: find all gold badge candidates,
   * OCR each one, return the highest valid digit found.
   * Higher TG level = more meaningful for tier selection.
   */
  async function detectTGLevel(img, setStatus) {
    setStatus('🔍 Detecting TG level…', '#90b8d8');

    const candidates = detectTGBadgeCandidates(img);

    if (candidates.length === 0) return 0;

    // Sort by size (larger = more likely a real badge), take top 8
    const top = candidates
      .sort((a, b) => b.cnt - a.cnt)
      .slice(0, 8);

    let maxTG = 0;
    for (const badge of top) {
      const digit = await readTGBadgeDigit(img, badge);
      if (digit > maxTG) maxTG = digit;
    }

    return maxTG;
  }

  // ── Main troop extraction ─────────────────────────────────
  async function extractTroops(file, setStatus) {
    setStatus('⏳ Loading image…', '#90b8d8');
    const img = await fileToImage(file);

    setStatus('⏳ Finding content panel…', '#90b8d8');
    const [ytop, ybot] = findPanelBounds(img);

    // Build B&W canvas of full panel width, 3× scale, dark text on light bg
    const isDarkText = (r, g, b) => r + g + b < 320;
    const bwFull = buildBWCanvas(img, 0.02, ytop, 0.98, ybot, isDarkText, 3);

    setStatus('🔍 Reading troops (pass 1/2)…', '#90b8d8');
    const text1 = await runOCR(bwFull, 6, null);

    // Second pass with PSM 4 (column detection) for better multi-column layouts
    setStatus('🔍 Reading troops (pass 2/2)…', '#90b8d8');
    const text2 = await runOCR(bwFull, 4, null);

    // Parse both passes and merge by taking highest count per type
    const r1 = parseTroopText(text1);
    const r2 = parseTroopText(text2);

    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };

    for (const tp of ['inf', 'cav', 'arc']) {
      totals[tp]   = Math.max(r1.totals[tp],   r2.totals[tp]);
      bestTier[tp] = Math.max(r1.bestTier[tp], r2.bestTier[tp]);
    }

    // Use archer's tier as primary (it's the most important for this app)
    // Fall back to any detected tier if archer not found
    const archerTier = bestTier.arc > 0
      ? bestTier.arc
      : Math.max(bestTier.inf, bestTier.cav, 0);

    // TG detection — only meaningful for T10 (Apex) troops
    let tgLevel = 0;
    if (archerTier >= 10) {
      tgLevel = await detectTGLevel(img, setStatus);
    }

    const selectVal = tierToSelectValue(archerTier, tgLevel);

    return {
      inf: totals.inf,
      cav: totals.cav,
      arc: totals.arc,
      archerTier,
      tgLevel,
      selectVal,
    };
  }

  // ══════════════════════════════════════════════════════════
  // UI helpers
  // ══════════════════════════════════════════════════════════

  /**
   * Set an input field value and flash it green to indicate auto-fill.
   */
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

  /**
   * Create an import button bar with file input and status text.
   */
  function makeBar(btnLabel, inputId, onFile) {
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'width:100%', 'box-sizing:border-box',
      'display:flex', 'flex-direction:column', 'align-items:center', 'gap:8px',
      'padding:12px 16px', 'margin-bottom:10px',
      'background:#0d1520', 'border:1px solid #2a3850', 'border-radius:8px',
    ].join(';');

    const lbl = document.createElement('label');
    lbl.htmlFor = inputId;
    lbl.style.cssText = [
      'display:inline-flex', 'align-items:center', 'justify-content:center', 'gap:7px',
      'padding:8px 20px', 'background:#1a2c44',
      'border:1px solid #3a5878', 'border-radius:8px',
      'color:#90b8d8', 'font-size:14px', 'font-weight:600',
      'cursor:pointer', 'white-space:nowrap',
      'transition:background .15s, border-color .15s, color .15s',
    ].join(';');
    lbl.textContent = btnLabel;

    lbl.addEventListener('mouseenter', () => {
      lbl.style.background = '#243a58';
      lbl.style.borderColor = '#5a90c0';
      lbl.style.color = '#c0d8f0';
    });
    lbl.addEventListener('mouseleave', () => {
      lbl.style.background = '#1a2c44';
      lbl.style.borderColor = '#3a5878';
      lbl.style.color = '#90b8d8';
    });

    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id = inputId;
    inp.accept = 'image/*';
    inp.style.display = 'none';

    const status = document.createElement('div');
    status.style.cssText = [
      'font-size:12px', 'color:#4a6080',
      'width:100%', 'box-sizing:border-box',
      'text-align:center', 'word-break:break-word',
      'line-height:1.5', 'min-height:1.3em',
    ].join(';');
    status.textContent = 'Processed locally — no data sent anywhere';

    function setStatus(msg, color) {
      status.textContent = msg;
      status.style.color = color || '#4a6080';
    }

    inp.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      lbl.style.opacity = '0.5';
      lbl.style.pointerEvents = 'none';
      try {
        await onFile(file, setStatus);
      } catch (err) {
        console.error('[OCR]', err);
        setStatus('❌ ' + err.message, '#e05555');
      } finally {
        lbl.style.opacity = '';
        lbl.style.pointerEvents = '';
      }
    });

    wrap.appendChild(lbl);
    wrap.appendChild(inp);
    wrap.appendChild(status);
    return wrap;
  }

  // ── Inject stat import bar ────────────────────────────────
  function injectStatBar() {
    const FIELD_IDS = ['inf_atk', 'inf_let', 'cav_atk', 'cav_let', 'arc_atk', 'arc_let'];

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
        setStatus(`⚠️ Got ${filled}/6 stats — check remaining fields`, '#e0a055');
      }

      if (window.OptionA && window.OptionA.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
    });

    const statsGrid = document.querySelector('.grid.grid-stats');
    if (statsGrid && statsGrid.parentElement) {
      statsGrid.parentElement.insertBefore(bar, statsGrid);
    } else {
      console.warn('[OCR] .grid.grid-stats not found — stat bar not injected');
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

      // Set tier dropdown
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
            setTimeout(() => {
              sel.style.outline = '';
              sel.style.boxShadow = '';
              sel.style.background = '';
            }, 1600);
          }
        }
      }

      const fmt = n => Number(n).toLocaleString();
      const tierStr = troops.archerTier > 0 ? ` · Tier → ${troops.selectVal}` : '';
      const tgStr   = troops.tgLevel > 0 ? ` (TG${troops.tgLevel})` : '';
      setStatus(
        `✅ INF ${fmt(troops.inf)} CAV ${fmt(troops.cav)} ARC ${fmt(troops.arc)}${tierStr}${tgStr}`,
        '#4caf88'
      );

      if (window.OptionA && window.OptionA.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
      if (window.Magic  && window.Magic.compute)       setTimeout(() => window.Magic.compute('magic12'), 200);
    });

    const troopGrid = document.querySelector('.grid.grid-two');
    if (troopGrid && troopGrid.parentElement) {
      troopGrid.parentElement.insertBefore(bar, troopGrid);
    } else {
      console.warn('[OCR] .grid.grid-two not found — troop bar not injected');
    }
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    injectStatBar();
    injectTroopBar();
    // Pre-warm Tesseract in background so first use is faster
    getTesseract().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
