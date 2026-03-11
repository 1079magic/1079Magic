/* ============================================================
 Stat Screenshot OCR  v7 — fully local, zero external APIs

 Uses Tesseract.js (WebAssembly, runs entirely in browser).
 No API keys. No server. No network calls beyond loading
 Tesseract itself from CDN once.

 TWO MODES:
 ─────────────────────────────────────────────────────────────
 1) STATS  (Bonus Details / Mail screenshot)
    • Full-image PSM-6 OCR — works on ALL screenshot formats
      (original red-column format AND newer unified-row format)
    • Each line matched by keyword: "Infantry Attack", "Cavalry Lethality", etc.
    • First +NNN.N% on matching line → stat value
    • No red-pixel band detection needed — 100% reliable across formats

 2) TROOPS  (Troops Preview screenshot)
    • Locates inner cream/white panel via brightness scan
    • THREE separate OCR passes per column (left 3-52%, right 48-97%):
        PSM 4, PSM 6, PSM 11 — 3× scaled B&W canvas each
    • For each troop type, take the HIGHEST count from any pass (merge-best)
    • Smart parser:
        – Type detection: \binfantr / \bcavalr / \barcher (word-boundary)
          prevents "March" → false arc detection
        – Number extraction: handles comma/period/space separators,
          slash OCR artifacts (2/4033 → 274033 via suffix),
          7-digit garble (6359717 → 359717 last-6-digits trick)
        – Up to 3-line lookahead for counts separated by icon garbage
        – Accumulates across all tier variants (Elite+Brave+Veteran)
    • Tier select based on ARCHER's tier + TG badge level:
        T1–7 → T6, T8–9 → T9, T10 → T10, T10+TG → T10.TGn
    • TG badge detection via gold-pixel cluster flood fill + digit OCR
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
   * Returns a drawn canvas for a fractional region of img.
   * x0f/y0f/x1f/y1f are 0–1 fractions of natural width/height.
   */
  function getPixels(img, x0f, y0f, x1f, y1f) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const x0 = Math.round(x0f * W), y0 = Math.round(y0f * H);
    const cw = Math.max(1, Math.round(x1f * W) - x0);
    const ch = Math.max(1, Math.round(y1f * H) - y0);
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, x0, y0, cw, ch, 0, 0, cw, ch);
    return { ctx, canvas: c, w: cw, h: ch };
  }

  /**
   * Build a black-on-white B&W canvas.
   * isDark(r,g,b) → true = render as black pixel.
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
   * OCR a canvas with a fresh Tesseract worker.
   * psm: page-seg-mode (6 = uniform block, 7 = single line, 4/11 = column modes)
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
  // STATS ENGINE  (v7 – full-image keyword matching)
  // ══════════════════════════════════════════════════════════
  //
  // Single PSM-6 OCR of the entire image. Each stat row comes out as:
  //   "+511.3%   Infantry Attack   +660.0%"
  // We match by keyword and grab the first +NNN.N% value on that line.
  // Works for ALL screenshot formats (red-column Mail AND no-red-column variants).

  const STAT_KEYWORDS = {
    inf_atk: /infantry.{0,10}attack/i,
    inf_let: /infantry.{0,10}lethality/i,
    cav_atk: /cavalry.{0,10}attack/i,
    cav_let: /cavalry.{0,10}lethality/i,
    arc_atk: /archer.{0,10}attack/i,
    arc_let: /archer.{0,10}lethality/i,
  };

  function parseStatsFromText(text) {
    const results = {};
    for (const line of text.split('\n')) {
      for (const [key, re] of Object.entries(STAT_KEYWORDS)) {
        if (key in results) continue;
        if (!re.test(line)) continue;
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

    // Full-image B&W (capture all dark text on light background), 2× scale
    const bw = buildBWCanvas(img, 0, 0, 1, 1,
      (r, g, b) => r + g + b < 500,
      2
    );
    const text = await runOCR(bw, 6, null);
    return parseStatsFromText(text);
  }

  // ══════════════════════════════════════════════════════════
  // TROOPS ENGINE  (v7 – multi-PSM column split + merge-best)
  // ══════════════════════════════════════════════════════════

  const TIER_MAP = {
    recruit: 1, warrior: 2, fighter: 3, skirmisher: 3,
    guardian: 5, sentinel: 6, veteran: 4, brave: 7,
    elite: 8, champion: 9, hero: 9, supreme: 9,
    apex: 10, legend: 10, legendary: 10,
  };

  const TIER_SELECT_OPTIONS = ['T6','T9','T10','T10.TG1','T10.TG2','T10.TG3','T10.TG4','T10.TG5'];

  /**
   * Map archer's (baseTier, tgLevel) → troopTier select value.
   * Archer is the primary focus of this app.
   */
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

  /**
   * Detect troop types in a line using word-boundary patterns.
   * \binfantr / \bcavalr / \barcher prevents "March" → false arc hit.
   * Returns types sorted by position (left-to-right).
   */
  function getTypesInLine(line) {
    const l = line.toLowerCase();
    const found = [];
    const INF = l.search(/\binfantr/);
    const CAV = l.search(/\bcavalr/);
    const ARC = l.search(/\barcher/);
    if (INF >= 0) found.push([INF, 'inf']);
    if (CAV >= 0) found.push([CAV, 'cav']);
    if (ARC >= 0) found.push([ARC, 'arc']);
    found.sort((a, b) => a[0] - b[0]);
    return found.map(([, tp]) => tp);
  }

  /**
   * Extract troop counts from a text line.
   * Handles:
   *   270,127 / 270.127 / 270 127 / 270127   (clean formats)
   *   2/4033   (slash OCR artifact for comma)  → 24033 → 4033 only, but
   *            with suffix logic for 7-digit numbers it recovers the correct value
   *   6359717  (7-digit OCR garble of 359,717) → last 6 digits: 359717
   */
  function extractNums(line) {
    let s = line.replace(/(\d)\/(\d)/g, '$1$2');         // slash artifact
    s = s.replace(/(\d)[.,](\d{3})(?=\D|$)/g, '$1$2');  // comma/period thousands
    s = s.replace(/(\d{1,3}) (\d{3})(?=\D|$)/g, '$1$2'); // space thousands

    const result = [];
    for (const tok of (s.match(/\b\d{3,}\b/g) || [])) {
      const n = parseInt(tok, 10);
      if (n <= 999999) {
        result.push(n);
      } else if (tok.length > 6) {
        // 7+ digit OCR garble — take last 6 digits as the real count
        const suffix = parseInt(tok.slice(-6), 10);
        if (suffix >= 100) result.push(suffix);
      }
    }
    return result;
  }

  function getTierFromLine(line) {
    const l = line.toLowerCase();
    let best = 0;
    for (const [name, tier] of Object.entries(TIER_MAP)) {
      if (l.includes(name) && tier > best) best = tier;
    }
    return best;
  }

  /**
   * Parse one column's OCR text into { totals, bestTier }.
   * Looks ahead up to 3 lines past a type-word line for the count numbers
   * (needed when icon garbage lines split them).
   */
  function parseColumnText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };

    let i = 0;
    while (i < lines.length) {
      const line  = lines[i];
      const types = getTypesInLine(line);

      if (types.length === 0) { i++; continue; }

      const tier = getTierFromLine(line);
      let nums = extractNums(line);

      // Lookahead: find numbers on following lines (up to 3), stop at next type-word line
      let look = 0;
      while (nums.length < types.length && look < 3 && i + 1 + look < lines.length) {
        const next = lines[i + 1 + look];
        if (getTypesInLine(next).length > 0) break;
        const nn = extractNums(next);
        if (nn.length > 0) {
          nums = nums.concat(nn);
          look++;
          if (nums.length >= types.length) break;
        } else {
          look++;  // blank/garbage line — skip but keep looking
        }
      }

      i += 1 + look;

      // Assign counts to types left-to-right
      for (let j = 0; j < types.length; j++) {
        const tp = types[j];
        if (j < nums.length && nums[j] >= 1) {
          totals[tp]   += nums[j];
          if (tier > bestTier[tp]) bestTier[tp] = tier;
        }
      }
    }

    return { totals, bestTier };
  }

  /**
   * Merge multiple parse results: for each troop type, keep the highest count.
   * OCR errors almost always under-count, so max = best estimate.
   */
  function mergeBest(results) {
    const totals   = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };
    for (const r of results) {
      for (const tp of ['inf', 'cav', 'arc']) {
        if (r.totals[tp]   > totals[tp])   totals[tp]   = r.totals[tp];
        if (r.bestTier[tp] > bestTier[tp]) bestTier[tp] = r.bestTier[tp];
      }
    }
    return { totals, bestTier };
  }

  // ── TG badge detection ────────────────────────────────────
  /**
   * Flood-fill scan for gold circular badge clusters.
   * Returns array of { cx, cy, w, h } for each small gold cluster.
   */
  function detectTGBadgeCandidates(img) {
    const { ctx, w, h } = getPixels(img, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, w, h).data;
    const visited = new Uint8Array(w * h);
    const candidates = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i+1], b = d[i+2];
        if (visited[y*w+x] || !(r>180 && g>120 && b<120 && r-b>80)) continue;

        const queue = [[x, y]];
        visited[y*w+x] = 1;
        let cnt = 0, mnX = x, mxX = x, mnY = y, mxY = y;

        while (queue.length) {
          const [cx, cy] = queue.shift();
          cnt++;
          if (cx < mnX) mnX = cx; if (cx > mxX) mxX = cx;
          if (cy < mnY) mnY = cy; if (cy > mxY) mxY = cy;
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = cx+dx, ny = cy+dy;
            if (nx<0||nx>=w||ny<0||ny>=h||visited[ny*w+nx]) continue;
            const ni = (ny*w+nx)*4;
            if (d[ni]>180 && d[ni+1]>120 && d[ni+2]<120 && d[ni]-d[ni+2]>80) {
              visited[ny*w+nx] = 1; queue.push([nx, ny]);
            }
          }
        }

        const bw = mxX-mnX+1, bh = mxY-mnY+1;
        if (cnt > 12 && bw < 55 && bh < 55 && bw/bh < 2.5 && bh/bw < 2.5) {
          candidates.push({ cx: mnX + bw/2, cy: mnY + bh/2, w: bw, h: bh });
        }
      }
    }
    return candidates;
  }

  // ── Find panel bounds via brightness scan ─────────────────
  function findPanelBounds(img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const { ctx } = getPixels(img, 0, 0, 1, 1);
    const px = ctx.getImageData(0, 0, W, H).data;

    const threshold = W * 0.35;
    const blocks = [];
    let inBlock = false, blockStart = 0;

    for (let y = 0; y < H; y++) {
      let bright = 0;
      for (let x = 0; x < W; x++) {
        const i = (y*W+x)*4;
        if (px[i] + px[i+1] + px[i+2] > 660) bright++;
      }
      if (!inBlock && bright > threshold)  { inBlock = true; blockStart = y; }
      else if (inBlock && bright <= threshold) {
        if (y - blockStart > 20) blocks.push([blockStart, y-1]);
        inBlock = false;
      }
    }
    if (inBlock) blocks.push([blockStart, H-1]);

    if (blocks.length === 0) return [Math.round(H*0.15), Math.round(H*0.92)];
    return blocks.reduce((a, b) => (b[1]-b[0] > a[1]-a[0]) ? b : a);
  }

  // ── Main troop extraction ─────────────────────────────────
  async function extractTroops(file, setStatus) {
    setStatus('⏳ Loading image…', '#90b8d8');
    const img = await fileToImage(file);
    const W = img.naturalWidth, H = img.naturalHeight;

    setStatus('⏳ Finding content panel…', '#90b8d8');
    const [panelTop, panelBot] = findPanelBounds(img);
    const ytop = panelTop / H;
    const ybot = panelBot / H;

    const isDarkText = (r, g, b) => r + g + b < 320;

    setStatus('🔍 Reading troops…', '#90b8d8');

    // Build B&W canvases for left and right columns (3× scale)
    const bwLeft  = buildBWCanvas(img, 0.03, ytop, 0.52, ybot, isDarkText, 3);
    const bwRight = buildBWCanvas(img, 0.48, ytop, 0.97, ybot, isDarkText, 3);

    // OCR each column with 3 PSM modes; merge-best across all 6 results
    const PSM_MODES = [4, 6, 11];
    const allResults = [];

    for (const psm of PSM_MODES) {
      const tL = await runOCR(bwLeft,  psm, null);
      allResults.push(parseColumnText(tL));
      const tR = await runOCR(bwRight, psm, null);
      allResults.push(parseColumnText(tR));
    }

    const { totals, bestTier } = mergeBest(allResults);

    // Archer's tier drives the select value
    // Fall back to best overall tier if archer was not found
    const archerTier = bestTier.arc > 0
      ? bestTier.arc
      : Math.max(bestTier.inf, bestTier.cav, bestTier.arc);

    // TG badge detection (only meaningful for T10/Apex)
    let tgLevel = 0;
    if (archerTier >= 10) {
      setStatus('🔍 Detecting TG level…', '#90b8d8');
      const candidates = detectTGBadgeCandidates(img);

      for (const badge of candidates.slice(0, 12)) {
        const pad = Math.max(badge.w, badge.h) * 0.9;
        const bx0 = Math.max(0, Math.round(badge.cx - pad));
        const by0 = Math.max(0, Math.round(badge.cy - pad));
        const bx1 = Math.min(W, Math.round(badge.cx + pad));
        const by1 = Math.min(H, Math.round(badge.cy + pad));
        const bw  = bx1 - bx0, bh = by1 - by0;
        if (bw < 4 || bh < 4) continue;

        const bc = document.createElement('canvas');
        bc.width = bw * 8; bc.height = bh * 8;
        const bctx = bc.getContext('2d');
        bctx.scale(8, 8);
        bctx.drawImage(img, bx0, by0, bw, bh, 0, 0, bw, bh);

        // Invert: white digit text on gold → black on white
        const bid = bctx.getImageData(0, 0, bc.width, bc.height);
        const bd  = bid.data;
        for (let k = 0; k < bd.length; k += 4) {
          const isW = bd[k]>200 && bd[k+1]>185 && bd[k+2]>160;
          bd[k] = bd[k+1] = bd[k+2] = isW ? 0 : 255;
        }
        bctx.putImageData(bid, 0, 0);

        try {
          const badgeText = await runOCR(bc, 10, '0123456789');
          const digit = badgeText.trim().replace(/\D/g, '');
          if (digit >= '1' && digit <= '5') {
            const v = parseInt(digit, 10);
            if (v > tgLevel) tgLevel = v;
          }
        } catch (_) { /* ignore single-badge OCR errors */ }
      }
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
    inp.type = 'file'; inp.id = inputId; inp.accept = 'image/*'; inp.style.display = 'none';

    const status = document.createElement('div');
    status.style.cssText = [
      'font-size:12px','color:#4a6080',
      'width:100%','box-sizing:border-box',
      'text-align:center','word-break:break-word',
      'line-height:1.5','min-height:1.3em',
    ].join(';');
    status.textContent = 'Processed locally — no data sent anywhere';

    function setStatus(msg, color) {
      status.textContent = msg;
      status.style.color = color || '#4a6080';
    }

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

  // ── Inject stat bar ───────────────────────────────────────
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
        setStatus(`⚠️ Got ${filled}/6 — check remaining fields`, '#e0a055');
      }

      if (window.OptionA?.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
    });

    const statsGrid = document.querySelector('.grid.grid-stats');
    if (statsGrid && statsGrid.parentElement) {
      statsGrid.parentElement.insertBefore(bar, statsGrid);
    } else {
      console.warn('[OCR] .grid.grid-stats not found');
    }
  }

  // ── Inject troop bar ──────────────────────────────────────
  function injectTroopBar() {
    const bar = makeBar('📷 Import troops from screenshot', 'ocrTroopFile', async (file, setStatus) => {
      const troops = await extractTroops(file, setStatus);

      if (!troops.inf && !troops.cav && !troops.arc) {
        throw new Error('No troop counts detected — try the Troops Preview screen');
      }

      setField('stockInf', Math.round(troops.inf));
      setField('stockCav', Math.round(troops.cav));
      setField('stockArc', Math.round(troops.arc));

      // Set tier dropdown (based on archer's tier + TG level)
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
      setStatus(
        `✅ INF ${fmt(troops.inf)} CAV ${fmt(troops.cav)} ARC ${fmt(troops.arc)}${tierStr}`,
        '#4caf88'
      );

      if (window.OptionA?.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
      if (window.Magic?.compute)      setTimeout(() => window.Magic.compute('magic12'), 200);
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
    getTesseract().catch(() => {});  // pre-warm in background
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
