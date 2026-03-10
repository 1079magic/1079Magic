/* ============================================================
 Stat Screenshot OCR Widget  v3
 Injects two clearly visible upload bars:
   1) Above stat inputs (inf_atk area) → Bonus Details screenshot
   2) Above troop count inputs (stockInf area) → Troops Preview screenshot
============================================================ */

(function () {
  'use strict';

  const MODEL = 'claude-sonnet-4-20250514';

  // ── Call Claude vision ────────────────────────────────────
  async function callClaude(base64, mediaType, prompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data.content || []).map(c => c.text || '').join('').trim();
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  }

  // ── Fill a field + flash green ────────────────────────────
  function setField(id, val) {
    const el = document.getElementById(id);
    if (!el || val === undefined || val === null) return;
    el.value = Number.isInteger(val) ? String(val) : parseFloat(val).toFixed(1);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const prev = el.getAttribute('data-orig-style') || '';
    el.style.background = '#1a3a20';
    el.style.outline = '2px solid #2ecc71';
    setTimeout(() => {
      el.style.background = '';
      el.style.outline = '';
    }, 1600);
  }

  // ── Build an upload bar ───────────────────────────────────
  //  label      : visible text e.g. "📷 Import stats from screenshot"
  //  inputId    : unique <input> id
  //  statusId   : unique status span id
  //  onFile(b64, mime, setStatus) : async handler
  function makeUploadBar(label, inputId, statusId, onFile) {
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      margin:0 0 12px 0;
      padding:9px 13px;
      background:#0d1520;
      border:1px solid #2a3548;
      border-radius:8px;
    `;

    const btn = document.createElement('label');
    btn.htmlFor = inputId;
    btn.style.cssText = `
      display:inline-flex; align-items:center; gap:6px;
      padding:6px 13px;
      background:#1a2c44; border:1px solid #3a5878; border-radius:6px;
      color:#90b8d8; font-size:13px; font-weight:600;
      cursor:pointer; white-space:nowrap; user-select:none;
      transition:background .15s, border-color .15s;
    `;
    btn.textContent = label;
    btn.addEventListener('mouseenter', () => { btn.style.background='#243a58'; btn.style.borderColor='#5a90c0'; });
    btn.addEventListener('mouseleave', () => { btn.style.background='#1a2c44'; btn.style.borderColor='#3a5878'; });

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = inputId;
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';

    const status = document.createElement('span');
    status.id = statusId;
    status.style.cssText = 'font-size:12px; color:#5a7090; flex:1; min-width:0;';
    status.textContent = 'Tap to upload screenshot';

    function setStatus(msg, color) {
      status.textContent = msg;
      status.style.color = color || '#5a7090';
    }

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      setStatus('⏳ Reading…', '#a0b4d0');
      btn.style.opacity = '0.6';
      btn.style.pointerEvents = 'none';
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          await onFile(ev.target.result.split(',')[1], file.type || 'image/jpeg', setStatus);
        } catch(err) {
          console.error('[OCR]', err);
          setStatus('❌ ' + err.message, '#e05555');
        } finally {
          btn.style.opacity = '';
          btn.style.pointerEvents = '';
        }
      };
      reader.readAsDataURL(file);
    });

    wrap.appendChild(btn);
    wrap.appendChild(fileInput);
    wrap.appendChild(status);
    return wrap;
  }

  // ── 1. STATS upload bar ───────────────────────────────────
  function injectStatBar() {
    const anchor = document.getElementById('inf_atk');
    if (!anchor) { console.warn('[OCR] inf_atk not found'); return; }

    // Walk up until we find a parent that contains all 6 stat inputs
    let container = anchor.parentElement;
    while (container && !container.querySelector('#cav_atk')) {
      container = container.parentElement;
    }
    if (!container) { console.warn('[OCR] stat container not found'); return; }

    const bar = makeUploadBar(
      '📷 Import stats from screenshot',
      'ocrStatFile', 'ocrStatStatus',
      async (b64, mime, setStatus) => {
        setStatus('⏳ Extracting stats…', '#a0b4d0');
        const stats = await callClaude(b64, mime,
`This is a Kingshot "Bonus Details" screenshot with two columns of percentage values.
Extract from the LEFT column only (your own hero stats):
- inf_atk  = Infantry Attack
- inf_let  = Infantry Lethality
- cav_atk  = Cavalry Attack
- cav_let  = Cavalry Lethality
- arc_atk  = Archer Attack
- arc_let  = Archer Lethality

Return numeric values only, no % sign (e.g. 511.3 not "+511.3%").
Respond with ONLY raw JSON, no markdown, no explanation.
Example: {"inf_atk":511.3,"inf_let":300.5,"cav_atk":560.8,"cav_let":390.8,"arc_atk":570.2,"arc_let":566.7}`
        );
        ['inf_atk','inf_let','cav_atk','cav_let','arc_atk','arc_let'].forEach(k => setField(k, stats[k]));
        setStatus(
          `✅ Filled — INF ${stats.inf_atk}%/${stats.inf_let}%  CAV ${stats.cav_atk}%/${stats.cav_let}%  ARC ${stats.arc_atk}%/${stats.arc_let}%`,
          '#4caf88'
        );
        if (window.OptionA?.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
      }
    );

    container.insertBefore(bar, container.firstChild);
  }

  // ── 2. TROOPS upload bar ──────────────────────────────────
  function injectTroopBar() {
    const anchor = document.getElementById('stockInf');
    if (!anchor) { console.warn('[OCR] stockInf not found'); return; }

    let container = anchor.parentElement;
    while (container && !container.querySelector('#stockCav')) {
      container = container.parentElement;
    }
    if (!container) { console.warn('[OCR] troop container not found'); return; }

    const bar = makeUploadBar(
      '📷 Import troops from screenshot',
      'ocrTroopFile', 'ocrTroopStatus',
      async (b64, mime, setStatus) => {
        setStatus('⏳ Counting troops…', '#a0b4d0');
        const troops = await callClaude(b64, mime,
`This is a Kingshot "Troops Preview" screenshot.
Group ALL troops by their TYPE, regardless of specific name:
- Any troop with "Infantry" in the name → Infantry
- Any troop with "Cavalry" in the name → Cavalry  
- Any troop with "Archer" in the name → Archer
Sum totals for each type. Numbers may have commas (270,127) — return as plain integers.
Respond ONLY with raw JSON:
{"inf":<total>,"cav":<total>,"arc":<total>}
Example: {"inf":270127,"cav":226334,"arc":452823}`
        );
        setField('stockInf', Math.round(troops.inf));
        setField('stockCav', Math.round(troops.cav));
        setField('stockArc', Math.round(troops.arc));
        setStatus(
          `✅ Filled — INF ${troops.inf?.toLocaleString()}  CAV ${troops.cav?.toLocaleString()}  ARC ${troops.arc?.toLocaleString()}`,
          '#4caf88'
        );
        if (window.OptionA?.computeAll) setTimeout(() => window.OptionA.computeAll(),  150);
        if (window.Magic?.compute)      setTimeout(() => window.Magic.compute('magic12'), 200);
      }
    );

    container.insertBefore(bar, container.firstChild);
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    injectStatBar();
    injectTroopBar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
