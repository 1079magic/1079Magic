/* ============================================================
 Stat Screenshot OCR Widget  v2
 Two upload buttons injected inline:
   1) 📷 next to stat inputs  → reads Bonus Details screenshot
      extracts the LEFT column % values (not always red)
      fills: inf_atk, inf_let, cav_atk, cav_let, arc_atk, arc_let
   2) 📷 next to troop count inputs → reads Troops Preview screenshot
      sums all infantry/cavalry/archer regardless of troop name
      fills: stockInf, stockCav, stockArc
 Uses Claude vision via /v1/messages.
============================================================ */

(function () {
  'use strict';

  const MODEL = 'claude-sonnet-4-20250514';

  // ── Shared helpers ────────────────────────────────────────

  function makeUploadBtn(id, title, onFile) {
    const label = document.createElement('label');
    label.htmlFor = id;
    label.title = title;
    label.style.cssText = `
      display:inline-flex; align-items:center; justify-content:center;
      width:28px; height:28px; min-width:28px;
      background:#1a2535; border:1px solid #3a4560; border-radius:6px;
      color:#7a9cc0; font-size:15px; cursor:pointer;
      transition:background .15s, border-color .15s, color .15s;
      vertical-align:middle; line-height:1;
    `;
    label.textContent = '📷';
    label.addEventListener('mouseenter', () => {
      label.style.background = '#243045';
      label.style.borderColor = '#5a8ac0';
      label.style.color = '#a0c4e8';
    });
    label.addEventListener('mouseleave', () => {
      label.style.background = '#1a2535';
      label.style.borderColor = '#3a4560';
      label.style.color = '#7a9cc0';
    });

    const input = document.createElement('input');
    input.type = 'file';
    input.id = id;
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      const reader = new FileReader();
      reader.onload = (ev) => {
        const b64 = ev.target.result.split(',')[1];
        onFile(b64, file.type || 'image/jpeg', label);
      };
      reader.readAsDataURL(file);
    });

    const wrap = document.createElement('span');
    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  function setLabelState(label, state) {
    // state: 'loading' | 'ok' | 'err' | 'idle'
    const states = {
      loading: { text: '⏳', color: '#a0b4d0', bg: '#1a2535', border: '#3a4560' },
      ok:      { text: '✅', color: '#4caf88', bg: '#0e2018', border: '#2ecc71' },
      err:     { text: '❌', color: '#e05555', bg: '#2a1010', border: '#e05555' },
      idle:    { text: '📷', color: '#7a9cc0', bg: '#1a2535', border: '#3a4560' },
    };
    const s = states[state] || states.idle;
    label.textContent = s.text;
    label.style.color = s.color;
    label.style.background = s.bg;
    label.style.borderColor = s.border;
    if (state === 'ok' || state === 'err') {
      setTimeout(() => setLabelState(label, 'idle'), 2500);
    }
  }

  function flashField(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const prev = el.style.cssText;
    el.style.background = '#1a3a20';
    el.style.borderColor = '#2ecc71';
    el.style.transition = 'background .3s, border-color .3s';
    setTimeout(() => { el.style.cssText = prev; }, 1400);
  }

  function setField(id, val) {
    const el = document.getElementById(id);
    if (!el || val === undefined || val === null) return false;
    el.value = typeof val === 'number' ? parseFloat(val).toFixed(1) : String(val);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    flashField(id);
    return true;
  }

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

  // ── 1. STAT UPLOAD (Bonus Details screenshot) ─────────────

  function injectStatUpload() {
    // Inject a 📷 button next to each stat row label
    // Stat pairs: (inf_atk + inf_let), (cav_atk + cav_let), (arc_atk + arc_let)
    // We inject ONE button that fills ALL 6 at once, placed next to inf_atk

    const anchor = document.getElementById('inf_atk');
    if (!anchor) return;

    // Walk up to find the containing row/cell
    // Insert button inline right after the input
    const btn = makeUploadBtn('statOcrFileInput', 'Upload Bonus Details screenshot to auto-fill all stats', async (b64, mime, label) => {
      setLabelState(label, 'loading');
      try {
        const stats = await callClaude(b64, mime, `This is a Kingshot "Bonus Details" screenshot.
Extract these 6 values from the LEFT column (your own stats, not the opponent's):
- inf_atk   = Infantry Attack
- inf_let   = Infantry Lethality
- cav_atk   = Cavalry Attack
- cav_let   = Cavalry Lethality
- arc_atk   = Archer Attack
- arc_let   = Archer Lethality

Numbers are percentages — extract the numeric value only (e.g. 511.3 not "+511.3%").
The left column is always YOUR stats. Ignore the right column entirely.
Respond with ONLY raw JSON, no markdown. Example:
{"inf_atk":511.3,"inf_let":300.5,"cav_atk":560.8,"cav_let":390.8,"arc_atk":570.2,"arc_let":566.7}`);

        ['inf_atk','inf_let','cav_atk','cav_let','arc_atk','arc_let'].forEach(k => setField(k, stats[k]));
        setLabelState(label, 'ok');

        if (window.OptionA?.computeAll) setTimeout(() => window.OptionA.computeAll(), 150);
      } catch(e) {
        console.error('[StatOCR]', e);
        setLabelState(label, 'err');
      }
    });

    btn.style.cssText = 'display:inline-block; margin-left:6px; vertical-align:middle;';

    // Insert after the inf_atk input field
    anchor.insertAdjacentElement('afterend', btn);
  }

  // ── 2. TROOP UPLOAD (Troops Preview screenshot) ───────────

  function injectTroopUpload() {
    const anchor = document.getElementById('stockInf');
    if (!anchor) return;

    const btn = makeUploadBtn('troopOcrFileInput', 'Upload Troops Preview screenshot to auto-fill troop counts', async (b64, mime, label) => {
      setLabelState(label, 'loading');
      try {
        const troops = await callClaude(b64, mime, `This is a Kingshot "Troops Preview" screenshot showing troop counts.
Group all troops by TYPE regardless of their specific name (e.g. "Apex Infantry", "Elite Infantry", "Supreme Infantry" are all Infantry; same logic for Cavalry and Archer).
Sum up the total count for each type.

Return ONLY raw JSON with these keys:
{"inf": <total infantry count>, "cav": <total cavalry count>, "arc": <total archer count>}

Numbers may be shown with commas (e.g. 270,127) — return as plain integers.
Example: {"inf":270127,"cav":226334,"arc":452823}`);

        setField('stockInf', Math.round(troops.inf));
        setField('stockCav', Math.round(troops.cav));
        setField('stockArc', Math.round(troops.arc));
        setLabelState(label, 'ok');

        // Trigger both engines
        if (window.OptionA?.computeAll)  setTimeout(() => window.OptionA.computeAll(),  150);
        if (window.Magic?.compute)       setTimeout(() => window.Magic.compute('magic12'), 200);
      } catch(e) {
        console.error('[TroopOCR]', e);
        setLabelState(label, 'err');
      }
    });

    btn.style.cssText = 'display:inline-block; margin-left:6px; vertical-align:middle;';
    anchor.insertAdjacentElement('afterend', btn);
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    injectStatUpload();
    injectTroopUpload();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
