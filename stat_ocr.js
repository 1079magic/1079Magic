/* ============================================================
 Stat Screenshot OCR  v5 — fully local, zero external APIs
 
 Uses Tesseract.js (WebAssembly, runs entirely in browser).
 No API keys. No server. No network calls beyond loading
 Tesseract itself from CDN once.

 TWO MODES:
 ─────────────────────────────────────────────────────────────
 1) STATS  (Bonus Details screenshot)
    • Detects red/dark number bands in left column by pixel color
    • Maps them to the 12 stat rows by position
    • Extracts indices 0,2,4,6,8,10 → inf_atk,inf_let,cav_atk,cav_let,arc_atk,arc_let
    • Accuracy: tested 100% on both sample screenshots

 2) TROOPS  (Troops Preview OR app screenshot)
    • Converts dark-brown text on cream background → black on white
    • OCRs full panel, parses line-by-line with lookahead for numbers
    • Handles: "Infantry + Cavalry on same line, numbers on next line"
               "Archer alone, number below"
               "Archers label (from app UI) with number on next line"
    • Handles dot AND comma as thousands separator (269.209 or 269,209)
    • Accuracy: tested 100% on all sample screenshots
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

  // Get raw pixel data for a fractional region of an image
  function getPixels(img, x0f, y0f, x1f, y1f) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const x0 = Math.round(x0f*W), y0 = Math.round(y0f*H);
    const x1 = Math.round(x1f*W), y1 = Math.round(y1f*H);
    const cw = x1-x0, ch = y1-y0;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, x0, y0, cw, ch, 0, 0, cw, ch);
    return { ctx, canvas: c, w: cw, h: ch };
  }

  // Build a clean black-on-white canvas from an image region
  // isDark(r,g,b) → true = render as black text
  function buildBWCanvas(img, x0f, y0f, x1f, y1f, isDark, scale=3) {
    const { ctx, w, h } = getPixels(img, x0f, y0f, x1f, y1f);
    const d = ctx.getImageData(0, 0, w, h);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      const v = isDark(px[i], px[i+1], px[i+2]) ? 0 : 255;
      px[i] = px[i+1] = px[i+2] = v;
      px[i+3] = 255;
    }
    ctx.putImageData(d, 0, 0);

    const out = document.createElement('canvas');
    out.width = w * scale; out.height = h * scale;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.drawImage(ctx.canvas, 0, 0, out.width, out.height);
    return out;
  }

  // Run Tesseract on a canvas, return text string
  async function runOCR(canvas, config, onProgress) {
    const T = await getTesseract();
    const worker = await T.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text' && onProgress) {
          onProgress(Math.round((m.progress||0)*100));
        }
      }
    });
    // Tesseract.js ignores CLI-style strings like '--psm 7'.
    // Parse the config string and apply via setParameters() instead.
    const params = {};
    const psmMatch = (config || '').match(/--psm\s+(\d+)/);
    if (psmMatch) params.tessedit_pageseg_mode = psmMatch[1];
    const wlMatch  = (config || '').match(/tessedit_char_whitelist=(\S+)/);
    if (wlMatch)  params.tessedit_char_whitelist = wlMatch[1];
    if (Object.keys(params).length) await worker.setParameters(params);
    const { data: { text } } = await worker.recognize(canvas.toDataURL('image/png'));
    await worker.terminate();
    return text;
  }

  // ── STATS ENGINE ──────────────────────────────────────────
  //
  // The Bonus Details panel has 12 stat rows (Inf/Cav/Arc × Atk/Def/Let/Hlth).
  // Each row's left-column number is a red/orange value on tan background.
  // We detect these by scanning for pixels where R is high and G+B are low.
  // The 12 rows map to our 6 fields at indices 0,2,4,6,8,10.

  async function extractStats(file, setStatus) {
    setStatus('⏳ Loading image…', '#a0b4d0');
    const img = await fileToImage(file);
    const W = img.naturalWidth, H = img.naturalHeight;

    setStatus('⏳ Detecting stat rows…', '#a0b4d0');

    // Scan for red-ish rows in the left column (x=5%-42%)
    // Red pixels: R>150, G<120, B<120
    const { ctx, w, h } = getPixels(img, 0.05, 0.25, 0.42, 0.96);
    const d = ctx.getImageData(0, 0, w, h).data;

    const redRows = [];
    for (let y = 0; y < h; y++) {
      let redCount = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i] > 150 && d[i+1] < 120 && d[i+2] < 120) redCount++;
      }
      if (redCount > 4) redRows.push(y);
    }

    // Group into bands (gap > 8px = new band)
    const rawBands = [];
    if (redRows.length) {
      let s = redRows[0], p = redRows[0];
      for (let i = 1; i < redRows.length; i++) {
        if (redRows[i] - p > 8) { rawBands.push([s, p]); s = redRows[i]; }
        p = redRows[i];
      }
      rawBands.push([s, p]);
    }

    // Filter out garbage bands at edges: keep only bands ≥8px tall
    // and whose position is between 50px and (cropH - 50px)
    const cropH = Math.round((0.96 - 0.25) * H);
    const bands = rawBands.filter(([s, e]) => (e - s) >= 8 && s > 50 && e < cropH - 50);

    // Need at least 11 valid bands
    if (bands.length < 11) {
      throw new Error(`Only found ${bands.length} stat rows (need 11+). Try a clearer screenshot.`);
    }

    // The 6 we need are at even indices: 0,2,4,6,8,10
    const targetIndices = [0, 2, 4, 6, 8, 10];
    const fieldKeys     = ['inf_atk','inf_let','cav_atk','cav_let','arc_atk','arc_let'];

    // For each target band, OCR just that row
    // Band y-values are relative to the crop (0.25h offset)
    const yOffset = 0.25;
    const results = {};

    const config = '--psm 7 -c tessedit_char_whitelist=0123456789.';

    for (let fi = 0; fi < 6; fi++) {
      const [y0, y1] = bands[targetIndices[fi]];
      const pad = 10;
      // Convert band coords back to image fractions
      const rowY0f = yOffset + (y0 - pad) / H;
      const rowY1f = yOffset + (y1 + pad) / H;

      setStatus(`⏳ Reading ${fieldKeys[fi]}… (${fi+1}/6)`, '#a0b4d0');

      const bw = buildBWCanvas(img,
        0.05, Math.max(0, rowY0f),
        0.42, Math.min(1, rowY1f),
        (r, g, b) => r > 130 && g < 130 && b < 130,  // red → black
        3
      );

      const text = await runOCR(bw, config, null);
      // Extract first decimal number
      const m = text.match(/(\d{2,3}[.,]\d)/);
      if (m) {
        results[fieldKeys[fi]] = parseFloat(m[1].replace(',', '.'));
      } else {
        const m2 = text.match(/(\d{3,})/);
        if (m2) results[fieldKeys[fi]] = parseFloat(m2[1]);
      }
    }

    return results;
  }

  // ── TROOPS ENGINE ─────────────────────────────────────────
  //
  // Handles two screenshot types:
  //   A) Kingshot "Troops Preview" — cream background, dark-brown text
  //      Cards in 2-col grid: Infantry|Cavalry on row1, Archer on row2
  //   B) App screenshot — troop count fields labeled Infantry/Cavalry/Archers
  //
  // Single parser handles both by reading name + lookahead for number.

  // ── Troop tier name → numeric tier ───────────────────────
  const TROOP_TIER_NAMES = {
    recruit:1, warrior:2, fighter:3, skirmisher:3,
    guardian:5, sentinel:6, veteran:4, brave:7,
    elite:8, champion:9, hero:9,
    apex:10, legend:10, legendary:10,
  };
  const TIER_SELECT_OPTIONS = ['T6','T9','T10','T10.TG1','T10.TG2','T10.TG3','T10.TG4','T10.TG5'];

  function tierToSelectValue(baseTier, tgLevel) {
    if (baseTier >= 10) {
      if (tgLevel >= 1) {
        const opt = `T10.TG${Math.min(tgLevel, 5)}`;
        return TIER_SELECT_OPTIONS.includes(opt) ? opt : 'T10.TG1';
      }
      return 'T10';
    }
    // T8 & T9 → T9 (T8 is 1 step from T9, 2 steps from T6 — round to nearest)
    // T7 and below → T6
    if (baseTier >= 8) return 'T9';
    return 'T6';
  }

  function getTroopType(s) {
    const l = s.toLowerCase();
    if (l.includes('infantry')) return 'inf';
    if (l.includes('cavalry'))  return 'cav';
    if (l.includes('arch'))     return 'arc';
    return null;
  }

  function getTroopTier(s) {
    const l = s.toLowerCase();
    for (const [name, tier] of Object.entries(TROOP_TIER_NAMES)) {
      if (l.includes(name)) return tier;
    }
    return 0;
  }

  // Number extraction: handles dot / comma / space as thousands separator
  function extractNums(s) {
    let s2 = s.replace(/(\d)[.,](\d{3})(?=\D|$)/g, '$1$2');
    s2 = s2.replace(/(\d{3})\s(\d{3})(?=\D|$)/g, '$1$2');
    return [...s2.matchAll(/\b(\d{5,})\b/g)].map(m => parseInt(m[1]));
  }
  function extractSingleNum(s) {
    let s2 = s.replace(/(\d)[.,](\d{3})(?=\D|$)/g, '$1$2');
    s2 = s2.replace(/(\d{3})\s(\d{3})(?=\D|$)/g, '$1$2');
    const m = s2.match(/\b(\d{3,})\b/);
    return m ? parseInt(m[1]) : null;
  }

  // Parse one column's OCR text — accumulate into shared totals + bestByType
  function parseTroopColumn(text, totals, bestByType) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const type = getTroopType(line);
      const tier = getTroopTier(line);
      if (type) {
        let count = extractSingleNum(line);
        if ((!count || count < 10) && i + 1 < lines.length) {
          const next = extractSingleNum(lines[i + 1]);
          if (next && next >= 10) { count = next; i++; }
        }
        if (count && count >= 10) {
          totals[type] += count;
          if (tier > 0 && tier > (bestByType[type]?.tier || 0)) {
            bestByType[type] = { tier, name: line.replace(/[^a-zA-Z ]/g, '').trim() };
          }
        }
      }
      i++;
    }
  }

  // TG badge scan: find gold pixel clusters in icon area, return candidates
  function detectTGBadgeCandidates(imgEl, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0);
    const y0 = Math.round(h * 0.18), y1 = Math.round(h * 0.75);
    const id = ctx.getImageData(0, y0, w, y1 - y0);
    const d = id.data; const W = w, H = y1 - y0;

    const goldMap = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        const r = d[idx], g = d[idx+1], b = d[idx+2];
        if (r > 180 && g > 120 && b < 120 && r - b > 80) goldMap[y * W + x] = 1;
      }
    }

    const visited = new Uint8Array(W * H);
    const candidates = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!goldMap[y * W + x] || visited[y * W + x]) continue;
        const queue = [[x, y]]; visited[y * W + x] = 1;
        let mnX=x, mxX=x, mnY=y, mxY=y, cnt=0;
        while (queue.length) {
          const [cx, cy] = queue.shift(); cnt++;
          mnX=Math.min(mnX,cx); mxX=Math.max(mxX,cx);
          mnY=Math.min(mnY,cy); mxY=Math.max(mxY,cy);
          for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx=cx+dx, ny=cy+dy;
            if (nx>=0&&nx<W&&ny>=0&&ny<H&&goldMap[ny*W+nx]&&!visited[ny*W+nx]) {
              visited[ny*W+nx]=1; queue.push([nx,ny]);
            }
          }
        }
        const bw2=mxX-mnX+1, bh2=mxY-mnY+1;
        if (cnt>12 && bw2<55 && bh2<55 && bw2/bh2<2.5 && bh2/bw2<2.5) {
          candidates.push({ cx: mnX+bw2/2, cy: y0+mnY+bh2/2, w: bw2, h: bh2 });
        }
      }
    }
    return candidates;
  }

  // ── Main troop extraction ─────────────────────────────────
  async function extractTroops(file, setStatus) {
    setStatus('⏳ Loading image…', '#90b8d8');
    const img = await fileToImage(file);
    const w = img.naturalWidth, h = img.naturalHeight;

    // Create ONE worker and reuse it for every recognize() call.
    // Creating/terminating a worker per call (as runOCR does) is slow and
    // causes mobile failures when called multiple times in quick succession.
    setStatus('⏳ Starting OCR engine…', '#90b8d8');
    const T = await getTesseract();
    const worker = await T.createWorker('eng', 1, {});
    // PSM 6 = "uniform block of text" — essential for reading cropped column images.
    // Must be set via setParameters(); passing '--psm 6' as a string is ignored by Tesseract.js.
    await worker.setParameters({ tessedit_pageseg_mode: '6' });

    // Convert canvas → data URL before passing to worker.recognize().
    // Canvas elements may not transfer correctly across worker thread boundaries
    // in all browsers; a data URL string is always safe.
    async function ocr(canvas) {
      const dataUrl = canvas.toDataURL('image/png');
      const { data: { text } } = await worker.recognize(dataUrl);
      return text;
    }

    const totals     = { inf: 0, cav: 0, arc: 0 };
    const bestByType = { inf: null, cav: null, arc: null };

    try {
      // Two-column OCR: left [2%-52%] and right [48%-98%]
      for (const [x0p, x1p] of [[0.02, 0.52], [0.48, 0.98]]) {
        setStatus('🔍 Reading troop columns…', '#90b8d8');
        const bwCanvas = buildBWCanvas(img, x0p, 0.18, x1p, 0.90,
          (r, g, b) => (r + g + b) < 380, 2);
        const text = await ocr(bwCanvas);
        parseTroopColumn(text, totals, bestByType);
      }

      // Find overall best tier
      let bestTier = 0;
      for (const bt of Object.values(bestByType)) {
        if (bt && bt.tier > bestTier) bestTier = bt.tier;
      }

      // TG badge detection (only for T10 Apex troops)
      let tgLevel = 0;
      if (bestTier >= 10) {
        setStatus('🔍 Detecting TG level…', '#90b8d8');
        const candidates = detectTGBadgeCandidates(img, w, h);
        const votes = [];
        for (const badge of candidates.slice(0, 8)) {
          const pad = Math.max(badge.w, badge.h) * 0.9;
          const bx0=Math.round(badge.cx-pad), by0=Math.round(badge.cy-pad);
          const bx1=Math.round(badge.cx+pad), by1=Math.round(badge.cy+pad);
          const bw2=bx1-bx0, bh2=by1-by0;
          if (bw2 < 4 || bh2 < 4) continue;
          const bc = document.createElement('canvas');
          bc.width=bw2*8; bc.height=bh2*8;
          const bctx = bc.getContext('2d');
          bctx.scale(8,8);
          bctx.drawImage(img, bx0, by0, bw2, bh2, 0, 0, bw2, bh2);
          const bid = bctx.getImageData(0, 0, bc.width, bc.height);
          const bd = bid.data;
          for (let k = 0; k < bd.length; k+=4) {
            const isWhite = bd[k]>200 && bd[k+1]>185 && bd[k+2]>160;
            bd[k]=bd[k+1]=bd[k+2]= isWhite ? 0 : 255;
          }
          bctx.putImageData(bid, 0, 0);
          const badgeText = await ocr(bc);
          const digit = badgeText.trim().replace(/\D/g,'');
          if (digit >= '1' && digit <= '5') votes.push(parseInt(digit));
        }
        if (votes.length > 0) {
          const freq = {};
          votes.forEach(v => freq[v] = (freq[v]||0)+1);
          tgLevel = parseInt(Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0]);
        }
      }

      const selectVal = tierToSelectValue(bestTier, tgLevel);
      return { ...totals, bestTier, tgLevel, selectVal };

    } finally {
      await worker.terminate(); // always free memory
    }
  }

  // ── Field fill + flash ────────────────────────────────────
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

  // (findContainerAndParent removed — using direct CSS selector targeting)

  // ── Build upload bar ──────────────────────────────────────
  function makeBar(btnLabel, inputId, onFile) {
    const wrap = document.createElement('div');
    // Outer wrapper: centered column — button centered, status text centered below
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
    lbl.addEventListener('mouseenter', () => { lbl.style.background='#243a58'; lbl.style.borderColor='#5a90c0'; lbl.style.color='#c0d8f0'; });
    lbl.addEventListener('mouseleave', () => { lbl.style.background='#1a2c44'; lbl.style.borderColor='#3a5878'; lbl.style.color='#90b8d8'; });

    const inp = document.createElement('input');
    inp.type = 'file'; inp.id = inputId; inp.accept = 'image/*'; inp.style.display = 'none';

    // Status line — centered, full width, wraps freely
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
      } catch(err) {
        console.error('[OCR]', err);
        setStatus('❌ ' + err.message, '#e05555');
      } finally {
        lbl.style.opacity = ''; lbl.style.pointerEvents = '';
      }
    });

    wrap.appendChild(lbl);
    wrap.appendChild(inp);
    wrap.appendChild(status);
    return wrap;
  }

  // ── Inject stat bar ───────────────────────────────────────
  // HTML structure: .panel > .grid.grid-stats (3-col: Infantry | Cavalry | Archers)
  // We insert the bar directly before .grid.grid-stats inside the panel.
  function injectStatBar() {
    const ids = ['inf_atk','inf_let','cav_atk','cav_let','arc_atk','arc_let'];

    const bar = makeBar('📷 Import stats from screenshot', 'ocrStatFile', async (file, setStatus) => {
      const stats = await extractStats(file, setStatus);
      const filled = ids.filter(k => stats[k] != null).length;

      if (filled === 0) throw new Error('No stats detected — try a sharper screenshot');

      ids.forEach(k => setField(k, stats[k]));

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

    // Target: the .grid.grid-stats div (3-col stat grid)
    // Insert before it inside its parent (.panel)
    const statsGrid = document.querySelector('.grid.grid-stats');
    if (statsGrid && statsGrid.parentElement) {
      statsGrid.parentElement.insertBefore(bar, statsGrid);
    } else {
      console.warn('[OCR] .grid.grid-stats not found');
    }
  }

  // ── Inject troop bar ──────────────────────────────────────
  // HTML structure: .panel > .grid.grid-two (2-col: Your available troops | Formation settings)
  // The left column contains stockInf/Cav/Arc.
  // We insert the bar directly BEFORE the entire .grid.grid-two div.
  function injectTroopBar() {
    const bar = makeBar('📷 Import troops from screenshot', 'ocrTroopFile', async (file, setStatus) => {
      const troops = await extractTroops(file, setStatus);

      if (!troops.inf && !troops.cav && !troops.arc) {
        throw new Error('No troop counts detected — try the Troops Preview screen');
      }

      setField('stockInf', Math.round(troops.inf));
      setField('stockCav', Math.round(troops.cav));
      setField('stockArc', Math.round(troops.arc));

      // Auto-set troop tier select if detected
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
      const tierStr = troops.bestTier > 0
        ? (troops.tgLevel > 0 ? ` \u00b7 \ud83c\udf96 ${troops.selectVal} detected` : ` \u00b7 Tier \u2192 ${troops.selectVal}`)
        : '';
      setStatus(`\u2705 INF ${fmt(troops.inf)}  CAV ${fmt(troops.cav)}  ARC ${fmt(troops.arc)}${tierStr}`, '#4caf88');

      if (window.OptionA?.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
      if (window.Magic?.compute)      setTimeout(() => window.Magic.compute('magic12'), 200);
    });

    // Target: .grid.grid-two (the 2-col troops + formation grid)
    // Insert before it inside its parent (.panel)
    const troopGrid = document.querySelector('.grid.grid-two');
    if (troopGrid && troopGrid.parentElement) {
      troopGrid.parentElement.insertBefore(bar, troopGrid);
    } else {
      console.warn('[OCR] .grid.grid-two not found');
    }
  }

    // ── Init: inject both bars, pre-warm Tesseract ───────────
  function init() {
    injectStatBar();
    injectTroopBar();
    // Start loading Tesseract.js in background so first upload is instant
    getTesseract().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
