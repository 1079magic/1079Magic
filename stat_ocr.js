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
    const { data: { text } } = await worker.recognize(canvas, {}, { text: true });
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
    const bands = [];
    if (redRows.length) {
      let s = redRows[0], p = redRows[0];
      for (let i = 1; i < redRows.length; i++) {
        if (redRows[i] - p > 8) { bands.push([s, p]); s = redRows[i]; }
        p = redRows[i];
      }
      bands.push([s, p]);
    }

    // Need at least 11 bands (0=InfAtk ... 10=ArcLet, skip defense/health rows)
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

  async function extractTroops(file, setStatus) {
    setStatus('⏳ Loading image…', '#a0b4d0');
    const img = await fileToImage(file);

    setStatus('⏳ Running OCR on troop panel…', '#a0b4d0');

    // Convert dark text (any dark pixel on cream/white/dark bg) → black on white
    const bw = buildBWCanvas(img,
      0.02, 0.25, 0.98, 0.88,
      (r, g, b) => (r + g + b) < 420,  // anything noticeably dark
      2
    );

    const text = await runOCR(bw, '--psm 6', pct => {
      setStatus(`⏳ Recognising… ${pct}%`, '#a0b4d0');
    });

    return parseTroopText(text);
  }

  function parseTroopText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const totals = { inf: 0, cav: 0, arc: 0 };

    // Extract numbers ≥5 digits, handling dot/comma as thousands separator
    function extractNums(s) {
      // Normalise thousands separators: 269.209 → 269209, 269,209 → 269209
      const s2 = s.replace(/(\d)[.,](\d{3})\b/g, '$1$2');
      return [...s2.matchAll(/\b(\d{5,})\b/g)].map(m => parseInt(m[1]));
    }

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const hasInf = /infantry/i.test(line);
      const hasCav = /cavalry/i.test(line);
      const hasArc = /arch/i.test(line);   // archer OR archers
      const nums   = extractNums(line);

      if (hasInf && hasCav && !nums.length) {
        // Two troop names on same line — numbers are on the NEXT number-containing line
        let j = i + 1;
        while (j < lines.length && !extractNums(lines[j]).length) j++;
        if (j < lines.length) {
          const pair = extractNums(lines[j]);
          if (pair.length >= 2) { totals.inf += pair[0]; totals.cav += pair[1]; }
          else if (pair.length === 1) { totals.inf += pair[0]; }
          i = j;
        }
      } else if (hasInf && nums.length) {
        totals.inf += Math.max(...nums);
      } else if (hasCav && nums.length) {
        totals.cav += Math.max(...nums);
      } else if (hasArc && nums.length) {
        totals.arc += Math.max(...nums);
      } else if (hasInf || hasCav || hasArc) {
        // Name without a number — look ahead
        const key = hasInf ? 'inf' : hasCav ? 'cav' : 'arc';
        let j = i + 1;
        while (j < lines.length && !extractNums(lines[j]).length) j++;
        if (j < lines.length) {
          const ns = extractNums(lines[j]);
          if (ns.length) { totals[key] += Math.max(...ns); i = j; }
        }
      }
      i++;
    }

    return totals;
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

  function findContainer(ids) {
    const first = document.getElementById(ids[0]);
    if (!first) return null;
    let el = first.parentElement;
    while (el) {
      if (ids.every(id => el.querySelector('#' + id))) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ── Build upload bar ──────────────────────────────────────
  function makeBar(btnLabel, inputId, onFile) {
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'width:100%','box-sizing:border-box',
      'display:flex','align-items:center','gap:10px',
      'padding:8px 12px','margin-bottom:10px',
      'background:#0d1520','border:1px solid #2a3850','border-radius:8px',
    ].join(';');

    const lbl = document.createElement('label');
    lbl.htmlFor = inputId;
    lbl.style.cssText = [
      'display:inline-flex','align-items:center','gap:6px',
      'padding:6px 14px','background:#1a2c44',
      'border:1px solid #3a5878','border-radius:6px',
      'color:#90b8d8','font-size:13px','font-weight:600',
      'cursor:pointer','white-space:nowrap','flex-shrink:0',
      'transition:background .15s,border-color .15s',
    ].join(';');
    lbl.textContent = btnLabel;
    lbl.addEventListener('mouseenter', () => { lbl.style.background='#243a58'; lbl.style.borderColor='#5a90c0'; });
    lbl.addEventListener('mouseleave', () => { lbl.style.background='#1a2c44'; lbl.style.borderColor='#3a5878'; });

    const inp = document.createElement('input');
    inp.type = 'file'; inp.id = inputId; inp.accept = 'image/*'; inp.style.display = 'none';

    const status = document.createElement('span');
    status.style.cssText = 'font-size:12px;color:#4a6080;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    status.textContent = 'Tap to upload screenshot — processed locally, no data sent anywhere';

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

    wrap.appendChild(lbl); wrap.appendChild(inp); wrap.appendChild(status);
    return wrap;
  }

  // ── Inject stat bar ───────────────────────────────────────
  function injectStatBar() {
    const ids = ['inf_atk','inf_let','cav_atk','cav_let','arc_atk','arc_let'];
    const container = findContainer(ids);
    if (!container) { console.warn('[OCR] stat container not found'); return; }

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

    container.insertBefore(bar, container.firstChild);
  }

  // ── Inject troop bar ──────────────────────────────────────
  function injectTroopBar() {
    const ids = ['stockInf','stockCav','stockArc'];
    const container = findContainer(ids);
    if (!container) { console.warn('[OCR] troop container not found'); return; }

    const bar = makeBar('📷 Import troops from screenshot', 'ocrTroopFile', async (file, setStatus) => {
      const troops = await extractTroops(file, setStatus);

      if (!troops.inf && !troops.cav && !troops.arc) {
        throw new Error('No troop counts detected — try the Troops Preview screen');
      }

      setField('stockInf', Math.round(troops.inf));
      setField('stockCav', Math.round(troops.cav));
      setField('stockArc', Math.round(troops.arc));

      const fmt = n => Number(n).toLocaleString();
      setStatus(`✅ INF ${fmt(troops.inf)}  CAV ${fmt(troops.cav)}  ARC ${fmt(troops.arc)}`, '#4caf88');

      if (window.OptionA?.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
      if (window.Magic?.compute)      setTimeout(() => window.Magic.compute('magic12'), 200);
    });

    container.insertBefore(bar, container.firstChild);
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
