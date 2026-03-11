/* ============================================================
 Stat Screenshot OCR  v8 — fully local, zero external APIs

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
    • Single full-panel OCR (PSM-6 + PSM-4 dual pass, merge-best)
    • Finds cream/white panel bounds via brightness scan
    • Parser accumulates ALL tiers per type:
        Elite + Brave + Veteran + Supreme + Apex → all summed
    • TG level detection — CORRECTED for actual game UI:
        TG badge = small GOLD CIRCLE in TOP-LEFT of hex icon
                   containing Arabic digit 1–5
        Tier badge = BOTTOM of hex with Roman numerals I–X (NOT TG)
      Detection: flood-fill gold clusters → OCR digit whitelist '12345'
    • Tier select driven by highest archer base tier + TG level
 ─────────────────────────────────────────────────────────────
 Tested against: jpow / emmo / spry / cro stats & troops images.
 All 8 image pairs verified correct.
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
  // STATS ENGINE  (v8 – color-based green exclusion)
  // ══════════════════════════════════════════════════════════
  //
  // Layout in every Bonus Details format:
  //   [RED +420.0%]  [Infantry Attack]  [GREEN +660.0%]
  //
  // FIX: Instead of a fixed x-crop (which failed for wider images like
  // emmo-stats), we use COLOR FILTERING to build the B&W canvas:
  //   • Red pixels   (R>G+60, R>B+60, sum<500) → BLACK  ✓ keep (left values)
  //   • Black pixels (all channels low, sum<300) → BLACK  ✓ keep (stat names)
  //   • Green pixels (G>R, G>B, G>120)          → WHITE  ✗ exclude (right values)
  //   • Beige/bg pixels (sum>500)               → WHITE  ✗ exclude
  //
  // This removes green +660/+550/+440 values from OCR input regardless of
  // where they appear in the image — no fixed column boundary needed.

  function isStatTextPixel(r, g, b) {
    // Exclude green text (the right-column bonus values)
    const isGreen = g > r && g > b && g > 120 && r < 140;
    if (isGreen) return false;
    // Include dark/red pixels (left stat values + center black labels)
    return (r + g + b) < 500;
  }

  const STAT_KEYWORDS = {
    inf_atk: /infantry.{0,12}attack/i,
    inf_let: /infantry.{0,12}lethality/i,
    cav_atk: /cavalry.{0,12}attack/i,
    cav_let: /cavalry.{0,12}lethality/i,
    arc_atk: /archer.{0,12}attack/i,
    arc_let: /archer.{0,12}lethality/i,
  };

  /**
   * Extract a stat value from a single text line.
   * Handles:
   *   +412.7%  → 412.7  (standard with dot)
   *   +412,7%  → 412.7  (comma decimal, some locales)
   *   +4127%   → 412.7  (OCR dropped decimal — 4 digits → NNN.N)
   * The decimal-drop case happens when navigation arrow characters
   * (< >) near the Cavalry Attack row create pixel noise that causes
   * Tesseract to lose the period between "412" and "7".
   */
  function parseStatValue(line) {
    // Standard: +NNN.N or +NNN,N
    let m = line.match(/\+(\d{2,4})[.,](\d)/);
    if (m) return parseFloat(`${m[1]}.${m[2]}`);
    // Fallback: 4 digits with no separator (OCR dropped decimal)
    // e.g. "+4127" → 412.7  "+3181" → 318.1
    m = line.match(/\+(\d{3})(\d)(?!\d)/);
    if (m) return parseFloat(`${m[1]}.${m[2]}`);
    return null;
  }

  function parseStatsFromText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const results = {};

    for (const line of lines) {
      for (const [key, re] of Object.entries(STAT_KEYWORDS)) {
        if (key in results || !re.test(line)) continue;
        // Both keyword AND value must be on the same line.
        // parseStatValue handles the arrow-noise case where Tesseract
        // drops the decimal separator ("+4127%" → 412.7).
        // Never look at adjacent lines — they belong to different stat rows
        // and would cause wrong values to be grabbed (e.g. Infantry Health
        // appearing just above the Cavalry Attack row).
        const val = parseStatValue(line);
        if (val !== null) results[key] = val;
      }
    }
    return results;
  }

  async function extractStats(file, setStatus) {
    setStatus('⏳ Loading image…', '#a0b4d0');
    const img = await fileToImage(file);
    setStatus('🔍 Reading stats…', '#a0b4d0');

    // Scan the full image with color filtering:
    //   • Red pixels  (left stat values: +420.0% etc)  → kept as black
    //   • Black pixels (center stat labels)             → kept as black
    //   • Green pixels (right bonus column: +660% etc)  → excluded (white)
    //   • Beige/bg                                      → excluded (white)
    // This works for ALL screenshot formats — Mail popup, Battle Report tab,
    // portrait or landscape — with no geometry assumptions.
    // 3× upscale ensures readable text even on small/thumbnail screenshots.
    const bw = buildBWCanvas(img, 0, 0, 1, 1, isStatTextPixel, 3);
    const text = await runOCR(bw, 6, null);
    return parseStatsFromText(text);
  }

  // ══════════════════════════════════════════════════════════
  // TROOPS ENGINE  (v8 – single-pass + correct TG detection)
  // ══════════════════════════════════════════════════════════

  // Troop name prefix → base tier number
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

  // Sorted descending by tier so highest match wins
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
   * \binfantr / \bcavalr / \barcher prevents "March" → false 'arc' hit.
   * Returns types sorted left-to-right by position in the line.
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
   * Handles: 274,033  274.033  274 033  274033
   * Slash artifact: 2/4033 → 24033
   * 7-digit garble: 6359717 → last 6 digits (359717)
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

  /**
   * Parse OCR text into troop totals and best tiers.
   *
   * KEY FIX — numBank: When Tesseract reads a 2-column grid it sometimes
   * merges numbers from different rows onto the same line, e.g.:
   *   "Apex Infantry Apex Cavalry"
   *   "209,022  129,042  224,969"   ← 3 numbers for 2 types
   *
   * Without the bank, 224,969 is silently dropped, and the next type line
   * (Apex Archer) then grabs 68,800 (Supreme Cavalry's count) instead.
   *
   * With the bank: extra numbers beyond the current line's type count are
   * carried forward and offered first to the next type line encountered.
   * This ensures 224,969 is correctly assigned to Apex Archer.
   */
  function parseTroopText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };
    let numBank = []; // surplus numbers from previous lines, offered first
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const types = getTypesInLine(line);

      // Not a type line — collect any numbers into the bank
      if (types.length === 0) {
        numBank = numBank.concat(extractNums(line));
        i++;
        continue;
      }

      const tier = getTierFromName(line);

      // Start with banked numbers, then inline numbers on the type line
      let nums = numBank.concat(extractNums(line));
      numBank = [];

      // Lookahead: consume following number-only lines if still short
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

      // Assign numbers left-to-right to types, accumulate per type
      for (let j = 0; j < types.length; j++) {
        const tp = types[j];
        if (j < nums.length && nums[j] >= 1) {
          totals[tp] += nums[j];
          if (tier > bestTier[tp]) bestTier[tp] = tier;
        }
      }

      // Bank any surplus numbers for the next type line
      if (nums.length > types.length) {
        numBank = nums.slice(types.length);
      }

      i += 1 + lookAhead;
    }

    return { totals, bestTier };
  }

  // ── TG Badge Detection ────────────────────────────────────
  //
  // Game UI — two badge types on Apex hex icons:
  //   TOP-LEFT corner:  small GOLD CIRCLE, Arabic digit 1–5 = TG LEVEL
  //   BOTTOM of hex:    small badge, Roman numeral I–X     = TROOP TIER
  //
  // We detect the gold circle (top-left) and OCR the Arabic digit inside.

  // panelY0/panelY1: pixel Y bounds of the cream troop panel.
  // We only search within the top 80% of that panel — TG badges are on
  // hex icons, while the Formations button and tier-ring badges (gold
  // ring around the X Roman numeral at the bottom of each icon) sit in
  // the lower portion and would otherwise produce false-positive reads.
  function detectGoldBadgeCandidates(img, panelY0, panelY1) {
    const W = img.naturalWidth, H = img.naturalHeight;
    // Clamp search area: top 80% of panel, exclude image edges
    const scanY0 = Math.round(panelY0);
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
        // Gold pixel: high red, medium-high green, low blue
        if (!(r > 175 && g > 115 && b < 110 && r - b > 85)) continue;

        // Flood fill the gold cluster
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
        // Real TG badge: small (≤40px wide/tall), roughly circular, pixel
        // count ≤300. The tier-ring (around Roman X) is far larger (cnt>>300)
        // and the hex border ring is also too big. This keeps only real badges.
        if (cnt >= 8 && cnt <= 300 && bw <= 40 && bh <= 40 && aspect >= 0.5 && aspect <= 2.0) {
          candidates.push({ cx: mnX + bw/2, cy: mnY + bh/2, w: bw, h: bh, cnt });
        }
      }
    }
    return candidates;
  }

  async function readBadgeDigit(img, badge) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const pad = Math.max(badge.w, badge.h) * 1.2;
    const bx0 = Math.max(0, Math.round(badge.cx - pad));
    const by0 = Math.max(0, Math.round(badge.cy - pad));
    const bx1 = Math.min(W, Math.round(badge.cx + pad));
    const by1 = Math.min(H, Math.round(badge.cy + pad));
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw < 4 || bh < 4) return 0;

    const scale = 10;
    const bc = document.createElement('canvas');
    bc.width = bw * scale; bc.height = bh * scale;
    const bctx = bc.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(img, bx0, by0, bw, bh, 0, 0, bc.width, bc.height);

    // Invert: white/light digit text → black; gold background → white
    const bid = bctx.getImageData(0, 0, bc.width, bc.height);
    const bd = bid.data;
    for (let k = 0; k < bd.length; k += 4) {
      const r = bd[k], g = bd[k+1], b = bd[k+2];
      const isLight = r > 200 && g > 180 && b > 155;
      const isNearWhite = Math.max(r,g,b) - Math.min(r,g,b) < 40 && r > 185;
      bd[k] = bd[k+1] = bd[k+2] = (isLight || isNearWhite) ? 0 : 255;
      bd[k+3] = 255;
    }
    bctx.putImageData(bid, 0, 0);

    try {
      // PSM 10 = treat image as a single character
      const text = await runOCR(bc, 10, '12345');
      const digit = text.trim().replace(/[^1-5]/g, '');
      if (digit.length === 1) return parseInt(digit, 10);
    } catch (_) { /* ignore */ }
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
  async function extractTroops(file, setStatus) {
    setStatus('⏳ Loading image…', '#90b8d8');
    const img = await fileToImage(file);

    setStatus('⏳ Finding content panel…', '#90b8d8');
    const [ytop, ybot] = findPanelBounds(img);

    const isDarkText = (r, g, b) => r + g + b < 320;

    // Dual OCR pass for robustness (PSM-6 block + PSM-4 column)
    setStatus('🔍 Reading troops (pass 1/2)…', '#90b8d8');
    const bwFull = buildBWCanvas(img, 0.02, ytop, 0.98, ybot, isDarkText, 3);
    const text1 = await runOCR(bwFull, 6, null);

    setStatus('🔍 Reading troops (pass 2/2)…', '#90b8d8');
    const text2 = await runOCR(bwFull, 4, null);

    const r1 = parseTroopText(text1);
    const r2 = parseTroopText(text2);

    // Merge passes: PSM-6 is primary. Only fall back to PSM-4 when
    // PSM-6 returns 0 for a type (completely missed it).
    // Do NOT use Math.max — it can inflate counts when one pass picks up
    // a wrong number that happens to be larger than the correct one.
    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };
    for (const tp of ['inf', 'cav', 'arc']) {
      totals[tp]   = r1.totals[tp]   > 0 ? r1.totals[tp]   : r2.totals[tp];
      bestTier[tp] = r1.bestTier[tp] > 0 ? r1.bestTier[tp] : r2.bestTier[tp];
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
