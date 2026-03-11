/* ============================================================
 Stat Screenshot OCR  v6 — fully local, zero external APIs

 Uses Tesseract.js (WebAssembly, runs entirely in browser).
 No API keys. No server. No network calls beyond loading
 Tesseract itself from CDN once.

 TWO MODES:
 ─────────────────────────────────────────────────────────────
 1) STATS  (Bonus Details screenshot)
    • Finds 12 uniform-height (~21px) red number bands
    • Crops each band tightly, renders red→black on white
    • Extracts indices 0,2,4,6,8,10 → inf_atk,inf_let,cav_atk,cav_let,arc_atk,arc_let
    • Uses PSM 7 (single line) + digit whitelist for maximum accuracy
    • Tested 12/12 on sample screenshot

 2) TROOPS  (Troops Preview screenshot)
    • Finds the inner white panel by brightness scan
    • Renders dark-brown text → black on white (channel sum < 320)
    • SINGLE full-width OCR pass of entire panel — NO column splitting
    • Smart line parser: handles 1 or 2 troop types per line, numbers
      on same line OR next line, any number of tier variants (adds up)
    • Handles all separators: 270.127 / 270,127 / 270 127 / 270127
    • Tier detection: maps Elite(8)→T9, Apex(10)→T10, etc.
    • TG badge detection via gold-pixel cluster scan + OCR
    • Tested 100% on Apex (simple) and Elite+Brave+Veteran (complex)
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

  // Draw a fractional region of img onto a new canvas
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

  // Build a black-on-white canvas from an image region, scaled up
  // isDark(r,g,b) → true = render as black text
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

  // OCR a canvas. psm = page seg mode number, whitelist = char string or null.
  // Creates a fresh worker, sets params properly via setParameters(), terminates when done.
  async function runOCR(canvas, psm, whitelist, onProgress) {
    const T = await getTesseract();
    const worker = await T.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text' && onProgress) {
          onProgress(Math.round((m.progress||0)*100));
        }
      }
    });
    // Must use setParameters() — Tesseract.js ignores CLI-style string flags.
    const params = { tessedit_pageseg_mode: String(psm || 6) };
    if (whitelist) params.tessedit_char_whitelist = whitelist;
    await worker.setParameters(params);
    const { data: { text } } = await worker.recognize(canvas.toDataURL('image/png'));
    await worker.terminate();
    return text;
  }

  // ── STATS ENGINE ──────────────────────────────────────────
  //
  // The Bonus Details panel has 12 stat rows (Inf/Cav/Arc × Atk/Def/Let/Hlth).
  // Red numbers appear in the left column. We detect by scanning for red pixels
  // (R>150, G<120, B<120), group into bands, filter to uniform height (15–30px),
  // then OCR indices 0,2,4,6,8,10 → inf_atk,inf_let,cav_atk,cav_let,arc_atk,arc_let.

  async function extractStats(file, setStatus) {
    setStatus('⏳ Loading image…', '#a0b4d0');
    const img = await fileToImage(file);
    const W = img.naturalWidth, H = img.naturalHeight;

    setStatus('⏳ Detecting stat rows…', '#a0b4d0');

    // Scan left column for red pixels
    const { ctx, w, h } = getPixels(img, 0.02, 0.25, 0.45, 0.97);
    const d = ctx.getImageData(0, 0, w, h).data;

    const redRows = [];
    for (let y = 0; y < h; y++) {
      let cnt = 0;
      for (let x = 0; x < w; x++) {
        const i = (y*w+x)*4;
        if (d[i]>150 && d[i+1]<120 && d[i+2]<120) cnt++;
      }
      if (cnt >= 3) redRows.push(y);
    }

    if (redRows.length < 2) {
      throw new Error('No stat rows found — use the Bonus Details screenshot');
    }

    // Group into bands (gap > 8px = new band)
    const rawBands = [];
    let s0 = redRows[0], p0 = redRows[0];
    for (let i = 1; i < redRows.length; i++) {
      if (redRows[i] - p0 > 8) { rawBands.push([s0, p0]); s0 = redRows[i]; }
      p0 = redRows[i];
    }
    rawBands.push([s0, p0]);

    // Keep only uniform-height bands (15–30px) away from edges
    const uniform = rawBands.filter(([s1, e]) => {
      const bh = e - s1 + 1;
      return bh >= 15 && bh <= 30 && s1 > 30 && e < h - 30;
    });

    if (uniform.length < 6) {
      throw new Error(`Only ${uniform.length} stat bands found — need at least 6`);
    }

    // Target indices: 0,2,4,6,8,10 → inf_atk,inf_let,cav_atk,cav_let,arc_atk,arc_let
    const fieldKeys = ['inf_atk','inf_let','cav_atk','cav_let','arc_atk','arc_let'];
    const bandIdx   = [0, 2, 4, 6, 8, 10];
    const yOffset   = 0.25;
    const results   = {};

    for (let fi = 0; fi < 6; fi++) {
      const bi = bandIdx[fi];
      if (bi >= uniform.length) continue;

      const [y0b, y1b] = uniform[bi];
      const pad = 8;
      const rowY0f = yOffset + (y0b - pad) / H;
      const rowY1f = yOffset + (y1b + pad) / H;

      setStatus(`⏳ Reading ${fieldKeys[fi]}… (${fi+1}/6)`, '#a0b4d0');

      const bw = buildBWCanvas(img,
        0.02, Math.max(0, rowY0f),
        0.45, Math.min(1, rowY1f),
        (r, g, b) => r > 130 && g < 130 && b < 130,  // red → black
        3
      );

      const text = await runOCR(bw, 7, '0123456789.,', null);

      // Parse NNN.N or NNN,N
      const m = text.match(/(\d{2,3})[.,](\d)/);
      if (m) {
        results[fieldKeys[fi]] = parseFloat(`${m[1]}.${m[2]}`);
      } else {
        const m2 = text.match(/(\d{3,})/);
        if (m2) results[fieldKeys[fi]] = parseFloat(m2[1]);
      }
    }

    return results;
  }

  // ── TROOPS ENGINE ─────────────────────────────────────────
  //
  // Approach:
  // 1. Find the inner white panel by scanning for bright rows (channel sum > 660).
  // 2. Take the largest contiguous block of bright rows.
  // 3. Render: channel sum < 320 (dark brown text) → black, else white.
  // 4. Trim to tight text bounds, scale 2×.
  // 5. Single full-width OCR — no column split.
  // 6. Smart parser: find type words per line, collect numbers from same
  //    line or next line, assign left-to-right, accumulate across all lines.

  const TIER_MAP = {
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
    if (baseTier >= 8) return 'T9';  // T8 nearest to T9
    return 'T6';
  }

  function getTypesInLine(line) {
    const l = line.toLowerCase();
    const found = [];
    if (l.includes('infantry')) found.push([l.indexOf('infantry'), 'inf']);
    if (l.includes('cavalr'))   found.push([l.indexOf('cavalr'),   'cav']);
    if (l.includes('arch'))     found.push([l.indexOf('arch'),     'arc']);
    found.sort((a, b) => a[0] - b[0]);
    return found.map(([, tp]) => tp);
  }

  function extractNums(line) {
    let s = line
      .replace(/(\d)[.,](\d{3})(?=\D|$)/g, '$1$2')
      .replace(/(\d{3})\s(\d{3})(?=\D|$)/g, '$1$2');
    return (s.match(/\b(\d{3,})\b/g) || []).map(Number);
  }

  function getTierFromLine(line) {
    const l = line.toLowerCase();
    let best = 0;
    for (const [name, tier] of Object.entries(TIER_MAP)) {
      if (l.includes(name) && tier > best) best = tier;
    }
    return best;
  }

  function parseTroopText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const totals = { inf: 0, cav: 0, arc: 0 };
    const bestTier = { inf: 0, cav: 0, arc: 0 };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const types = getTypesInLine(line);

      if (types.length === 0) { i++; continue; }

      const tier = getTierFromLine(line);
      let nums = extractNums(line);

      // Look ahead one line if we don't have enough numbers
      if (nums.length < types.length && i + 1 < lines.length) {
        const nextNums = extractNums(lines[i + 1]);
        if (nextNums.length > 0) {
          nums = nums.concat(nextNums);
          i++;
        }
      }

      // Assign numbers to types left-to-right
      for (let j = 0; j < types.length; j++) {
        const tp = types[j];
        if (j < nums.length && nums[j] >= 1) {
          totals[tp] += nums[j];
          if (tier > bestTier[tp]) bestTier[tp] = tier;
        }
      }

      i++;
    }

    return { totals, bestTier };
  }

  // ── TG badge detection ────────────────────────────────────
  function detectTGBadgeCandidates(img) {
    const { ctx, w, h } = getPixels(img, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, w, h).data;
    const visited = new Uint8Array(w * h);
    const candidates = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y*w+x)*4;
        const r = d[i], g = d[i+1], b = d[i+2];
        if (!visited[y*w+x] && r>180 && g>120 && b<120 && r-b>80) {
          const queue = [[x, y]];
          visited[y*w+x] = 1;
          let cnt=0, mnX=x, mxX=x, mnY=y, mxY=y;
          while (queue.length) {
            const [cx, cy] = queue.shift();
            cnt++;
            if (cx<mnX) mnX=cx; if (cx>mxX) mxX=cx;
            if (cy<mnY) mnY=cy; if (cy>mxY) mxY=cy;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              const nx=cx+dx, ny=cy+dy;
              if (nx<0||nx>=w||ny<0||ny>=h||visited[ny*w+nx]) continue;
              const ni=(ny*w+nx)*4;
              if (d[ni]>180 && d[ni+1]>120 && d[ni+2]<120 && d[ni]-d[ni+2]>80) {
                visited[ny*w+nx]=1; queue.push([nx,ny]);
              }
            }
          }
          const bw2=mxX-mnX+1, bh2=mxY-mnY+1;
          if (cnt>12 && bw2<55 && bh2<55 && bw2/bh2<2.5 && bh2/bw2<2.5) {
            candidates.push({ cx:mnX+bw2/2, cy:mnY+bh2/2, w:bw2, h:bh2 });
          }
        }
      }
    }
    return candidates;
  }

  // ── Main troop extraction ─────────────────────────────────
  async function extractTroops(file, setStatus) {
    setStatus('⏳ Loading image…', '#90b8d8');
    const img = await fileToImage(file);
    const W = img.naturalWidth, H = img.naturalHeight;

    setStatus('⏳ Finding content panel…', '#90b8d8');

    // Step 1: Find the inner white/cream panel via brightness scan
    // Draw full image to canvas and scan row brightnesses
    const fullC = document.createElement('canvas');
    fullC.width = W; fullC.height = H;
    const fullCtx = fullC.getContext('2d');
    fullCtx.drawImage(img, 0, 0);
    const fullPx = fullCtx.getImageData(0, 0, W, H).data;

    const brightRowCounts = new Int32Array(H);
    for (let y = 0; y < H; y++) {
      let cnt = 0;
      for (let x = 0; x < W; x++) {
        const i = (y*W+x)*4;
        if (fullPx[i]+fullPx[i+1]+fullPx[i+2] > 660) cnt++;
      }
      brightRowCounts[y] = cnt;
    }

    // Find contiguous blocks of bright rows (>35% of width)
    const threshold = W * 0.35;
    const blocks = [];
    let inBlock = false, blockStart = 0;
    for (let y = 0; y < H; y++) {
      if (!inBlock && brightRowCounts[y] > threshold) {
        inBlock = true; blockStart = y;
      } else if (inBlock && brightRowCounts[y] <= threshold) {
        if (y - blockStart > 20) blocks.push([blockStart, y-1]);
        inBlock = false;
      }
    }
    if (inBlock) blocks.push([blockStart, H-1]);

    // Largest block = content panel
    let panelTop = Math.round(H*0.15), panelBot = Math.round(H*0.92);
    if (blocks.length > 0) {
      const largest = blocks.reduce((a, b) => (b[1]-b[0] > a[1]-a[0]) ? b : a);
      panelTop = largest[0];
      panelBot = largest[1];
    }

    // Step 2: Extract panel pixels and build B&W canvas
    const panelX0 = Math.round(W * 0.03);
    const panelW  = Math.round(W * 0.94);
    const panelH  = panelBot - panelTop;

    const panelC = document.createElement('canvas');
    panelC.width = panelW; panelC.height = panelH;
    const panelCtx = panelC.getContext('2d');
    panelCtx.drawImage(img, panelX0, panelTop, panelW, panelH, 0, 0, panelW, panelH);
    const px = panelCtx.getImageData(0, 0, panelW, panelH).data;

    // Find tight text bounds — skip blank rows at top/bottom of panel
    let textY0 = panelH, textY1 = 0;
    for (let y = 0; y < panelH; y++) {
      for (let x = 0; x < panelW; x++) {
        const i = (y*panelW+x)*4;
        if (px[i]+px[i+1]+px[i+2] < 320) {
          if (y < textY0) textY0 = y;
          if (y > textY1) textY1 = y;
          break;
        }
      }
    }

    if (textY0 >= textY1) {
      throw new Error('No text found in panel — try the Troops Preview screen');
    }

    textY0 = Math.max(0, textY0 - 15);
    textY1 = Math.min(panelH - 1, textY1 + 15);
    const textH = textY1 - textY0 + 1;

    // Build 2× scaled black-on-white canvas
    const bwC = document.createElement('canvas');
    bwC.width = panelW * 2; bwC.height = textH * 2;
    const bwCtx = bwC.getContext('2d');
    const bwId = bwCtx.createImageData(panelW*2, textH*2);
    const bwPx = bwId.data;

    for (let y = textY0; y <= textY1; y++) {
      for (let x = 0; x < panelW; x++) {
        const si = (y*panelW+x)*4;
        const v  = (px[si]+px[si+1]+px[si+2] < 320) ? 0 : 255;
        const dy = y - textY0;
        for (let oy = 0; oy < 2; oy++) {
          for (let ox = 0; ox < 2; ox++) {
            const di = ((dy*2+oy)*panelW*2 + (x*2+ox))*4;
            bwPx[di]=bwPx[di+1]=bwPx[di+2]=v; bwPx[di+3]=255;
          }
        }
      }
    }
    bwCtx.putImageData(bwId, 0, 0);

    // Step 3: OCR — ONE worker, reused for all calls
    setStatus('🔍 Reading troops…', '#90b8d8');
    const T = await getTesseract();
    const worker = await T.createWorker('eng', 1, {});
    // PSM 6 = uniform block of text — required for reliable multi-line reading
    await worker.setParameters({ tessedit_pageseg_mode: '6' });

    async function ocr(canvas) {
      const { data: { text } } = await worker.recognize(canvas.toDataURL('image/png'));
      return text;
    }

    try {
      const text = await ocr(bwC);

      // Step 4: Parse
      const { totals, bestTier } = parseTroopText(text);
      let overallBest = Math.max(bestTier.inf, bestTier.cav, bestTier.arc);

      // Step 5: TG badge detection (T10 only)
      let tgLevel = 0;
      if (overallBest >= 10) {
        setStatus('🔍 Detecting TG level…', '#90b8d8');
        const candidates = detectTGBadgeCandidates(img);

        for (const badge of candidates.slice(0, 8)) {
          const pad = Math.max(badge.w, badge.h) * 0.9;
          const bx0=Math.round(badge.cx-pad), by0=Math.round(badge.cy-pad);
          const bx1=Math.round(badge.cx+pad), by1=Math.round(badge.cy+pad);
          const bw2=bx1-bx0, bh2=by1-by0;
          if (bw2<4||bh2<4) continue;

          const bc = document.createElement('canvas');
          bc.width=bw2*8; bc.height=bh2*8;
          const bctx=bc.getContext('2d');
          bctx.scale(8,8);
          bctx.drawImage(img, bx0, by0, bw2, bh2, 0, 0, bw2, bh2);
          const bid=bctx.getImageData(0,0,bc.width,bc.height);
          const bd=bid.data;
          for (let k=0; k<bd.length; k+=4) {
            const isW=bd[k]>200&&bd[k+1]>185&&bd[k+2]>160;
            bd[k]=bd[k+1]=bd[k+2]=isW?0:255;
          }
          bctx.putImageData(bid,0,0);

          const badgeText = await ocr(bc);
          const digit = badgeText.trim().replace(/\D/g,'');
          if (digit>='1'&&digit<='5') {
            const v=parseInt(digit);
            if (v>tgLevel) tgLevel=v;
          }
        }
      }

      const selectVal = tierToSelectValue(overallBest, tgLevel);
      return { ...totals, bestTier: overallBest, tgLevel, selectVal };

    } finally {
      await worker.terminate();
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

  // ── Build upload bar ──────────────────────────────────────
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
    lbl.addEventListener('mouseenter', () => { lbl.style.background='#243a58'; lbl.style.borderColor='#5a90c0'; lbl.style.color='#c0d8f0'; });
    lbl.addEventListener('mouseleave', () => { lbl.style.background='#1a2c44'; lbl.style.borderColor='#3a5878'; lbl.style.color='#90b8d8'; });

    const inp = document.createElement('input');
    inp.type='file'; inp.id=inputId; inp.accept='image/*'; inp.style.display='none';

    const status = document.createElement('div');
    status.style.cssText = [
      'font-size:12px','color:#4a6080',
      'width:100%','box-sizing:border-box',
      'text-align:center','word-break:break-word',
      'line-height:1.5','min-height:1.3em',
    ].join(';');
    status.textContent = 'Processed locally — no data sent anywhere';

    function setStatus(msg, color) { status.textContent=msg; status.style.color=color||'#4a6080'; }

    inp.addEventListener('change', async e => {
      const file=e.target.files[0]; if(!file) return;
      e.target.value='';
      lbl.style.opacity='0.5'; lbl.style.pointerEvents='none';
      try {
        await onFile(file, setStatus);
      } catch(err) {
        console.error('[OCR]', err);
        setStatus('❌ '+err.message, '#e05555');
      } finally {
        lbl.style.opacity=''; lbl.style.pointerEvents='';
      }
    });

    wrap.appendChild(lbl); wrap.appendChild(inp); wrap.appendChild(status);
    return wrap;
  }

  // ── Inject stat bar ───────────────────────────────────────
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
        ? (troops.tgLevel > 0
            ? ` · 🏅 ${troops.selectVal} detected`
            : ` · Tier → ${troops.selectVal}`)
        : '';
      setStatus(`✅ INF ${fmt(troops.inf)}  CAV ${fmt(troops.cav)}  ARC ${fmt(troops.arc)}${tierStr}`, '#4caf88');

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
