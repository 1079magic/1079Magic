/* ============================================================
 #1079 LoL App – Option‑A (updated for unified UI)
 Exposes: window.OptionA.init(), window.OptionA.computeAll()
 - Auto-compute on show (plot + optimizer)
 - Reads from shared inputs
 - Namespaced DOM ids to avoid collisions with Magic
============================================================ */

(function(){
  'use strict';

  // ---------- Global Composition Bounds ----------
  const INF_MIN_PCT = 0.075;
  const INF_MAX_PCT = 0.10;
  const CAV_MIN_PCT = 0.10;

  let inited = false;
  let lastBestTriplet = { fin: INF_MIN_PCT, fcav: CAV_MIN_PCT, farc: 1-INF_MIN_PCT-CAV_MIN_PCT };
  let compUserEdited = false;
  let compJoinUserEdited = false;

  // ---------- Composition Readback State ----------
  // Stores the last engine-computed fractions for call and join (used as fallback when field is cleared)
  let _lastEngineCallFractions = null;  // { fin, fcav, farc } — set after buildRally
  let _lastEngineJoinFractions = null;  // { fin, fcav, farc } — set after buildOptionAFormations (row #1)
  // Guard: true while readbackCompositionFields is writing to fields, so input listeners don't react
  let _readbackWriting = false;

  // ---------- Basic Helpers ----------
  function num(id) {
    const el = document.getElementById(id);
    if (!el) return 0;
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : 0;
  }
  function attackFactor(atk, leth) { return (1 + atk/100) * (1 + leth/100); }

  // MAGIC tiers: if T6 → 4.4/1.25; else 2.78/1.45
  function getArcherCoefByTier(tierRaw) {
    const t = String(tierRaw||'').toUpperCase();
    return (t === 'T6') ? (4.4/1.25) : (2.78/1.45);
  }

  // ---------- Composition Bounds ----------
  function enforceCompositionBounds(fin, fcav, farc) {
    let i = fin, c = fcav, a = farc;
    if (i < INF_MIN_PCT) i = INF_MIN_PCT;
    if (i > INF_MAX_PCT) i = INF_MAX_PCT;
    if (c < CAV_MIN_PCT) c = CAV_MIN_PCT;
    a = 1 - i - c;
    if (a < 0) {
      c = Math.max(CAV_MIN_PCT, 1 - i);
      a = 1 - i - c;
      if (a < 0) { a = 0; c = 1 - i; }
    }
    const S = i + c + a;
    if (S <= 0) return { fin: INF_MIN_PCT, fcav: CAV_MIN_PCT, farc: 1 - INF_MIN_PCT - CAV_MIN_PCT };
    return { fin: i/S, fcav: c/S, farc: a/S };
  }

  // ---------- Closed-form optimal fractions ----------
  function computeExactOptimalFractions(stats, tierRaw) {
    const Ainf = attackFactor(stats.inf_atk, stats.inf_let);
    const Acav = attackFactor(stats.cav_atk, stats.cav_let);
    const Aarc = attackFactor(stats.arc_atk, stats.arc_let);
    const KARC = getArcherCoefByTier(tierRaw);
    const alpha = Ainf / 1.12;
    const beta  = Acav;
    const gamma = KARC * Aarc;
    const a2 = alpha*alpha, b2 = beta*beta, g2 = gamma*gamma;
    const sum = a2 + b2 + g2;
    return { fin: a2/sum, fcav: b2/sum, farc: g2/sum };
  }

  // ---------- Plot Evaluation ----------
  function evaluateForPlot(fin, fcav, farc, stats, tierRaw) {
    const Ainf = attackFactor(stats.inf_atk, stats.inf_let);
    const Acav = attackFactor(stats.cav_atk, stats.cav_let);
    const Aarc = attackFactor(stats.arc_atk, stats.arc_let);
    const KARC = getArcherCoefByTier(tierRaw);
    const termInf = (1/1.45) * Ainf * Math.sqrt(fin);
    const termCav = Acav * Math.sqrt(fcav);
    const termArc = KARC * Aarc * Math.sqrt(farc);
    return termInf + termCav + termArc;
  }

  // ---------- Composition helpers ----------
  function roundFractionsTo100(fin, fcav, farc) {
    const S = fin+fcav+farc;
    if (S <= 0) return { i:0, c:0, a:100 };
    const nf = fin/S, nc = fcav/S;
    let i = Math.round(nf*100);
    let c = Math.round(nc*100);
    let a = 100 - i - c;
    if (a < 0) {
      a = 0;
      if (i + c > 100) {
        const over = i + c - 100;
        if (i >= c) i -= over; else c -= over;
      }
    }
    return { i, c, a };
  }
  function formatTriplet(fin, fcav, farc) {
    const {i,c,a} = roundFractionsTo100(fin,fcav,farc);
    return `${i}/${c}/${a}`;
  }

  // ---------- Format fractions to 1-decimal string (e.g. "8.5/12.3/79.2") ----------
  function formatTriplet1dp(fin, fcav, farc) {
    const S = fin + fcav + farc;
    if (S <= 0) return "0.0/0.0/100.0";
    const ip = (fin / S) * 100;
    const cp = (fcav / S) * 100;
    const ap = (farc / S) * 100;
    // Round to 1dp, then correct rounding error on the largest component
    let is = ip.toFixed(1);
    let cs = cp.toFixed(1);
    let as_ = ap.toFixed(1);
    // Ensure they sum to exactly 100.0
    const diff = (100 - parseFloat(is) - parseFloat(cs) - parseFloat(as_));
    if (Math.abs(diff) >= 0.05) {
      // absorb rounding error into archers (largest share usually)
      as_ = (parseFloat(as_) + diff).toFixed(1);
    }
    return `${is}/${cs}/${as_}`;
  }

  // ---------- Parse fractions from actual troop counts ----------
  function fractionsFromCounts(inf, cav, arc) {
    const total = inf + cav + arc;
    if (total <= 0) return { fin: INF_MIN_PCT, fcav: CAV_MIN_PCT, farc: 1 - INF_MIN_PCT - CAV_MIN_PCT };
    return { fin: inf / total, fcav: cav / total, farc: arc / total };
  }

  function parseCompToFractions(str) {
    if (typeof str !== "string") return null;
    const parts = str.replace(/%/g,"").trim()
      .split(/[,\s/]+/).map(s=>s.trim()).filter(Boolean).map(Number);
    if (parts.some(v=>!Number.isFinite(v) || v<0)) return null;
    if (parts.length === 0) return null;
    let i = parts[0] ?? 0;
    let c = parts[1] ?? 0;
    let a = parts.length >= 3 ? parts[2] : Math.max(0, 100 - (i+c));
    const sum = i+c+a;
    if (sum <= 0) return null;
    return { fin: i/sum, fcav: c/sum, farc: a/sum };
  }
  function getCompEl(){ return document.getElementById("compInput"); }
  function getCompHintEl(){ return document.getElementById("compHint"); }

  function setCompInputFromBest() {
    const el = getCompEl();
    if (!el) return;
    el.value = formatTriplet(lastBestTriplet.fin, lastBestTriplet.fcav, lastBestTriplet.farc);
    const hint = getCompHintEl();
    if (hint) hint.textContent = "Auto-filled from Best (bounded). Edit to override.";
  }
  function getFractionsForRally() {
    const el = getCompEl();
    const hint = getCompHintEl();

    // If field is empty → use last engine call fractions as fallback, or bestTriplet
    if (!el || el.value.trim() === '') {
      const fallback = _lastEngineCallFractions || lastBestTriplet;
      if (hint) hint.textContent = "Using engine default (field cleared).";
      return fallback;
    }

    if (!el) return lastBestTriplet;
    const parsed = parseCompToFractions(el.value);
    if (parsed) {
      const bounded = enforceCompositionBounds(parsed.fin,parsed.fcav,parsed.farc);
      const disp = formatTriplet(bounded.fin,bounded.fcav,bounded.farc);
      if (hint) {
        const orig = formatTriplet(parsed.fin,parsed.fcav,parsed.farc);
        hint.textContent = (orig !== disp)
          ? `Using (clamped): ${disp} · (Inf 7.5–10%, Cav ≥ 10%)`
          : `Using: ${disp}`;
      }
      return bounded;
    } else {
      if (hint) hint.textContent = "Invalid input → using Best (bounded).";
      return lastBestTriplet;
    }
  }
  function getJoinFractionsManual() {
    const el = document.getElementById("compInputJoin");
    const hint = document.getElementById("compHintJoin");
    if (!el) return null;

    // KEY FIX: Only honour manual override when the user has EXPLICITLY typed.
    // Engine-written readback values must NEVER be treated as manual overrides.
    // Doing so causes a feedback loop: readback writes "1/19/80" → next compute
    // parses it as manual → buildJoinManually runs on depleted stock → 100/0/0.
    if (!compJoinUserEdited) {
      return null; // always use arc-first engine when user has not typed
    }

    // If user cleared the field, reset flag and fall back to engine
    if (el.value.trim() === '') {
      compJoinUserEdited = false;
      if (hint) hint.textContent = "Using engine default (field cleared).";
      return null;
    }

    const parsed = parseCompToFractions(el.value);
    if (parsed) {
        const disp = formatTriplet(parsed.fin, parsed.fcav, parsed.farc);
        if (hint) hint.textContent = `Using: ${disp}`;
        return parsed;
    } else {
        if (hint) hint.textContent = `Invalid input → using engine logic`;
        return null;
    }
  }

  // ---------- COMPOSITION READBACK ENGINE ----------
  // Called at the very end of onOptimize() after all formations are built.
  // Reads actual troop counts from the built rally and first join pack,
  // converts to 1-decimal percentages, and writes back to the input fields
  // ONLY if the user has NOT manually edited them.
  // Uses _readbackWriting guard so the input listeners don't treat
  // programmatic writes as user edits (which would cause a feedback loop).
  function readbackCompositionFields(rally, joinPacks) {
    _readbackWriting = true;
    try {
      // --- CALL field ---
      const callEl = getCompEl();
      if (callEl) {
        const callTotal = (rally.inf || 0) + (rally.cav || 0) + (rally.arc || 0);
        if (callTotal > 0) {
          const frac = fractionsFromCounts(rally.inf, rally.cav, rally.arc);
          _lastEngineCallFractions = frac;
          if (!compUserEdited) {
            callEl.value = formatTriplet1dp(frac.fin, frac.fcav, frac.farc);
            const hint = getCompHintEl();
            if (hint) hint.textContent = "Auto-filled from actual rally formation (1 decimal).";
          }
          // Update bestReadout banner from ACTUAL call fractions (last in chain — display only)
          const actualDisp = compUserEdited
            ? callEl.value
            : formatTriplet1dp(frac.fin, frac.fcav, frac.farc);
          const bestReadoutEl = document.getElementById("bestReadout");
          if (bestReadoutEl) {
            bestReadoutEl.innerText =
              `Best Call Rally Composition ≈ ${actualDisp} (Inf/Cav/Arc) · [Inf 7.5–10%, Cav ≥ 10%].`;
          }
        }
      }

      // --- JOIN field ---
      // Only write back when the arc-first engine was used (compJoinUserEdited = false).
      // When user has typed a manual override, leave the join field alone.
      const joinEl = document.getElementById("compInputJoin");
      if (joinEl && joinPacks && joinPacks.length > 0 && !compJoinUserEdited) {
        const p0 = joinPacks[0];
        const joinTotal = (p0.inf || 0) + (p0.cav || 0) + (p0.arc || 0);
        if (joinTotal > 0) {
          const frac = fractionsFromCounts(p0.inf, p0.cav, p0.arc);
          _lastEngineJoinFractions = frac;
          joinEl.value = formatTriplet1dp(frac.fin, frac.fcav, frac.farc);
          const hint = document.getElementById("compHintJoin");
          if (hint) hint.textContent = "Auto-filled from Join #1 actual formation (1 decimal).";
        }
      }
    } finally {
      _readbackWriting = false;
    }
  }

  // ---------- Plot Rendering ----------
  function percentile(arr, p) {
    const a = [...arr].sort((x, y) => x - y);
    const idx = (a.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return a[lo];
    const w = idx - lo;
    return a[lo] * (1 - w) + a[hi] * w;
  }

  function computePlots() {
    const stats = {
      inf_atk: num("inf_atk"),
      inf_let: num("inf_let"),
      cav_atk: num("cav_atk"),
      cav_let: num("cav_let"),
      arc_atk: num("arc_atk"),
      arc_let: num("arc_let")
    };
    const tierRaw = document.getElementById("troopTier").value;

    const opt = computeExactOptimalFractions(stats, tierRaw);
    const bounded = enforceCompositionBounds(opt.fin, opt.fcav, opt.farc);
    lastBestTriplet = { fin: bounded.fin, fcav: bounded.fcav, farc: bounded.farc };
    if (!compUserEdited) setCompInputFromBest();

    const samples = [];
    const vals = [];
    const steps = 55;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const fin = i / steps;
        const fcav = j / steps;
        const farc = 1 - fin - fcav;
        const d = evaluateForPlot(fin, fcav, farc, stats, tierRaw);
        samples.push({ fin, fcav, farc, d });
        vals.push(d);
      }
    }
    const vmax = Math.max(...vals);
    const rel = vals.map(v => v / (vmax || 1));
    const vminClip = percentile(rel, 0.05);
    const vmaxClip = percentile(rel, 0.95);

    const fieldTrace = {
      type: "scatterternary",
      mode: "markers",
      a: samples.map(s => s.fin),
      b: samples.map(s => s.fcav),
      c: samples.map(s => s.farc),
      marker: {
        size: 3, opacity: 0.95,
        color: rel, colorscale: "Viridis",
        cmin: vminClip, cmax: vmaxClip,
        line: { width: 0 },
        colorbar: {
          thickness: 14, len: 0.6, tickformat: ".2f",
          x: 0.5, xanchor: "center", y: -0.15, yanchor: "top",
          orientation: "h",
        }
      },
      hovertemplate:
        "<b>Inf</b>: %{a:.2f}<br>" +
        "<b>Cav</b>: %{b:.2f}<br>" +
        "<b>Arc</b>: %{c:.2f}<br>" +
        "<b>Rel</b>: %{marker.color:.3f}<extra></extra>",
      name: "Surface"
    };

    const bestTrace = {
      type: "scatterternary",
      mode: "markers+text",
      a: [bounded.fin], b: [bounded.fcav], c: [bounded.farc],
      marker: { size: 12, color: "#10b981", line: { color: "white", width: 1.6 } },
      text: ["Best"], textposition: "top center",
      hovertemplate: "Best (bounded)<br>Inf: %{a:.2f}<br>Cav: %{b:.2f}<br>Arc: %{c:.2f}<extra></extra>",
      name: "Best"
    };

    const layout = {
      template: "plotly_dark",
      paper_bgcolor: "#1a1d24",
      plot_bgcolor: "#1a1d24",
      font: { color: "#e8eaed", size: 13 },
      margin: { l: 36, r: 40, b: 100, t: 52 },
      title: { text: "Optimal Troop Composition", x: 0.02, font: { size: 20 } },
      showlegend: false,
      ternary: {
        sum: 1,
        bgcolor: "#0f1116",
        domain: { x: [0.02, 0.96], y: [0.15, 0.98] },
        aaxis: { title: { text: "Infantry" }, min: 0, ticks: "outside", tickformat: ".1f", ticklen: 4, gridcolor: "#3A3F45" },
        baxis: { title: { text: "Cavalry" }, min: 0, ticks: "outside", tickformat: ".1f", ticklen: 4, gridcolor: "#3A3F45" },
        caxis: { title: { text: "Archery" }, min: 0, ticks: "outside", tickformat: ".1f", ticklen: 4, gridcolor: "#3A3F45" }
      }
    };

    Plotly.react("ternaryPlot", [fieldTrace, bestTrace], layout, { responsive: true, displayModeBar: false });

    const el = document.getElementById("ternaryPlot");
    if (!window.__ternaryResizeAttached) {
      const ro = new ResizeObserver(() => Plotly.Plots.resize(el));
      ro.observe(el);
      window.__ternaryResizeAttached = true;
    }

    document.getElementById("bestReadout").innerText =
      `Best Call Rally Composition ≈ ${formatTriplet(bounded.fin,bounded.fcav,bounded.farc)} (Inf/Cav/Arc) · [Inf 7.5–10%, Cav ≥ 10%].`;

    updateRecommendedDisplay();
  }

// ---------- Rally Build — allocates proportionally to fractions, then clamps to bounds ----------
// fractions = { fin, fcav, farc } from the plot/optimizer (the actual optimal ratios).
// Bounds: INF 7.5–10%, CAV ≥ 10%. Remaining space after placing inf+cav goes to archers.
// If archers run short, excess space is filled by cav first, then inf (up to 10%).
function buildRally(fractions, rallySize, stock) {

  if (rallySize <= 0)
    return { inf: 0, cav: 0, arc: 0 };

  const iMin = Math.ceil(INF_MIN_PCT * rallySize);
  const iMax = Math.floor(INF_MAX_PCT * rallySize);
  const cMin = Math.ceil(CAV_MIN_PCT * rallySize);

  // Step 1: Target amounts from optimizer fractions, clamped to bounds and stock.
  // Infantry: clamp to [iMin, iMax], also limited by stock
  let inf = Math.min(stock.inf, Math.max(iMin, Math.min(iMax, Math.round(fractions.fin * rallySize))));

  // Cavalry: at least cMin, target from fractions, limited by stock
  let cav = Math.min(stock.cav, Math.max(cMin, Math.round(fractions.fcav * rallySize)));

  // If inf + cav already exceed rally size (shouldn't happen with sane fractions but be safe)
  if (inf + cav > rallySize) {
    // Scale back cav first, keeping cMin
    cav = Math.max(cMin, rallySize - inf);
  }

  // Step 2: Fill remaining space with archers
  let arc = Math.min(stock.arc, Math.max(0, rallySize - inf - cav));
  let used = inf + cav + arc;

  // Step 3: If archers ran out before filling cap, top up with extra cavalry
  if (used < rallySize && stock.cav - cav > 0) {
    const add = Math.min(rallySize - used, stock.cav - cav);
    cav += add;
    used += add;
  }

  // Step 4: If still space, top up with extra infantry (up to iMax)
  if (used < rallySize && stock.inf - inf > 0) {
    const add = Math.min(rallySize - used, stock.inf - inf, Math.max(0, iMax - inf));
    inf += add;
    used += add;
  }

  // Deduct from stock
  stock.inf -= inf;
  stock.cav -= cav;
  stock.arc -= arc;

  return { inf, cav, arc };
}

  function buildJoinManually(stock, marchCount, cap, fractions) {
    const packs = [];

    for (let m = 0; m < marchCount; m++) {
        let i = Math.round(fractions.fin * cap);
        let c = Math.round(fractions.fcav * cap);
        let a = Math.round(fractions.farc * cap);

        i = Math.min(i, stock.inf);
        c = Math.min(c, stock.cav);
        a = Math.min(a, stock.arc);

        stock.inf -= i;
        stock.cav -= c;
        stock.arc -= a;

        packs.push({ inf: i, cav: c, arc: a });
    }

    return { packs, leftover: stock };
}

  // ---------- Round Robin ----------
  function fillRoundRobin(total, caps) {
    const n = caps.length;
    const out = Array(n).fill(0);
    let t = Math.max(0, Math.floor(total));
    let progress = true;
    while (t > 0 && progress) {
      progress = false;
      for (let i=0; i<n && t>0; i++) {
        if (out[i] < caps[i]) { out[i] += 1; t -= 1; progress = true; }
      }
    }
    return out;
  }

  // ---------- Option‑A March Builder (arc → cav → fill to cap → inf last) ----------
  function buildOptionAFormations(stock, formations, cap) {
    const n = Math.max(1, formations);
    // JOIN minimums: arc-first strategy, inf ≥ 1%, cav ≥ 3% (lower than CALL)
    const JOIN_INF_MIN = 0.01;
    const JOIN_CAV_MIN = 0.03;
    const infMinPer = Math.ceil(JOIN_INF_MIN * cap);
    const infMaxPer = Math.floor(INF_MAX_PCT * cap);
    const cavMinPer = Math.ceil(JOIN_CAV_MIN * cap);

    const infAlloc = Array(n).fill(0);
    const cavAlloc = Array(n).fill(0);
    const arcAlloc = Array(n).fill(0);

    // Step 1: Allocate MINIMUM infantry to every march first.
    const infMinCaps = Array(n).fill(infMinPer);
    const infMinGive = fillRoundRobin(Math.min(stock.inf, infMinPer * n), infMinCaps);
    for (let i=0; i<n; i++) { infAlloc[i] = infMinGive[i]; stock.inf -= infMinGive[i]; }

    // Step 2: Allocate MINIMUM cavalry to every march.
    const cavMinCaps = Array(n).fill(cavMinPer);
    const cavMinGive = fillRoundRobin(Math.min(stock.cav, cavMinPer * n), cavMinCaps);
    for (let i=0; i<n; i++) { cavAlloc[i] = cavMinGive[i]; stock.cav -= cavMinGive[i]; }

    // Step 3: Fill ALL remaining space with archers (maximise archer placement).
    const arcCaps = Array(n).fill(0).map((_,i) => Math.max(0, cap - infAlloc[i] - cavAlloc[i]));
    const arcGive = fillRoundRobin(stock.arc, arcCaps);
    for (let i=0; i<n; i++) { arcAlloc[i] = arcGive[i]; stock.arc -= arcGive[i]; }

    // Step 4: If archers ran out before filling cap, top up with extra cavalry.
    for (let i=0; i<n; i++) {
      const space = cap - infAlloc[i] - cavAlloc[i] - arcAlloc[i];
      if (space > 0 && stock.cav > 0) {
        const add = Math.min(space, stock.cav);
        cavAlloc[i] += add;
        stock.cav -= add;
      }
    }

    // Step 5: If still space (cav exhausted too), top up with extra infantry (up to infMax).
    for (let i=0; i<n; i++) {
      const space = cap - infAlloc[i] - cavAlloc[i] - arcAlloc[i];
      if (space > 0 && stock.inf > 0) {
        const maxExtraInf = Math.max(0, infMaxPer - infAlloc[i]);
        const add = Math.min(space, stock.inf, maxExtraInf);
        infAlloc[i] += add;
        stock.inf -= add;
      }
    }

    const packs = [];
    for (let i=0; i<n; i++) {
      packs.push({ inf: infAlloc[i], cav: cavAlloc[i], arc: arcAlloc[i] });
    }
    return { packs, leftover: { inf: stock.inf, cav: stock.cav, arc: stock.arc } };
  }

  // ---------- Recommended marches ----------
  function meetsTargetFill(fill) { return fill >= 0.822; }
  function computeRecommendationScore(fullCount, minFill, avgFill, leftover) {
    const totalLeft = leftover.inf + leftover.cav + leftover.arc;
    const cavPenalty = leftover.cav * 3;
    return ( fullCount * 1e9 + (minFill * 0.822) * 1e6 + avgFill * 1e3 - (totalLeft + cavPenalty) );
  }
  function simulateMarchCount(marchCount, fractions, rallySize, joinCap, stockOriginal) {
    const stockAfterRally = { ...stockOriginal };
    const rally = buildRally(fractions, rallySize, stockAfterRally);
    const result = buildOptionAFormations({ ...stockAfterRally }, marchCount, joinCap);
    const { packs, leftover } = result;
    const totals = packs.map(p => p.inf + p.cav + p.arc);
    const fills = totals.map(t => t / joinCap);
    const minFill = totals.length ? Math.min(...fills) : 0;
    const avgFill = totals.length ? fills.reduce((a,b)=>a+b, 0) / fills.length : 0;
    const fullCount = fills.filter(f => meetsTargetFill(f)).length;
    return { marchCount, minFill, avgFill, fullCount, leftover,
      score: computeRecommendationScore(fullCount, minFill, avgFill, leftover) };
  }
  function computeRecommendedMarches(maxMarches, fractions, rallySize, joinCap, stock) {
    const results = [];
    for (let n=1; n<=maxMarches; n++) { results.push(simulateMarchCount(n, fractions, rallySize, joinCap, stock)); }
    results.sort((a,b)=>b.score - a.score);
    return results[0];
  }

  function updateRecommendedDisplay() {
    const recommendedEl = document.getElementById("opt_recommendedDisplay");
    if (!recommendedEl) return;

    const fractions = getFractionsForRally();
    const rallySize = Math.max(0, Math.floor(num("rallySize")));
    const joinCap = Math.max(1, Math.floor(num("marchSize")));
    const maxMarches = Math.max(1, Math.floor(num("numFormations")));
    const stock = {
      inf: Math.max(0, Math.floor(num("stockInf"))),
      cav: Math.max(0, Math.floor(num("stockCav"))),
      arc: Math.max(0, Math.floor(num("stockArc")))
    };

    const best = computeRecommendedMarches(maxMarches, fractions, rallySize, joinCap, stock);
    const oldValue = window.__recommendedMarches;
    const newValue = best.marchCount;

    recommendedEl.textContent = `Best: ${newValue} marches (min fill ${(best.minFill*100).toFixed(1)}%)`;
    window.__recommendedMarches = newValue;
  }

  // ---------- Optimizer handler ----------
  function onOptimize() {
    const stats = {
      inf_atk: num("inf_atk"), inf_let: num("inf_let"),
      cav_atk: num("cav_atk"), cav_let: num("cav_let"),
      arc_atk: num("arc_atk"), arc_let: num("arc_let")
    };
    const tierRaw = document.getElementById("troopTier").value;

    const opt = computeExactOptimalFractions(stats, tierRaw);
    const bounded = enforceCompositionBounds(opt.fin,opt.fcav,opt.farc);
    lastBestTriplet = { fin: bounded.fin, fcav: bounded.fcav, farc: bounded.farc };

    const usedFractions = getFractionsForRally();
    const usedDisp = formatTriplet(usedFractions.fin,usedFractions.fcav,usedFractions.farc);
    const bestDisp = formatTriplet(bounded.fin,bounded.fcav,bounded.farc);

    const fracEl = document.getElementById("opt_fractionReadout");
    if (fracEl) fracEl.innerText = `Target fractions (bounded · Inf 7.5–10%, Cav ≥ 10%): ${usedDisp} · Best: ${bestDisp}`;

    const stock = {
      inf: Math.max(0, Math.floor(num("stockInf"))),
      cav: Math.max(0, Math.floor(num("stockCav"))),
      arc: Math.max(0, Math.floor(num("stockArc")))
    };
    const cap = Math.max(1, Math.floor(num("marchSize")));
    // Use recommended march count if in recommended mode, else user's input
    const formations = (window.__optARecommendedMode && window.__recommendedMarches)
      ? window.__recommendedMarches
      : Math.max(1, Math.floor(num("numFormations")));
    const rallySize = Math.max(0, Math.floor(num("rallySize")));

    const totalAvailBefore = stock.inf + stock.cav + stock.arc;
    const rally = buildRally(usedFractions, rallySize, stock);
    const rallyTotal = rally.inf + rally.cav + rally.arc;

    let joinFractionsManual = getJoinFractionsManual();

    let result;
    if (joinFractionsManual) {
        // manual override for JOIN marches
        result = buildJoinManually({ ...stock }, formations, cap, joinFractionsManual);
    } else {
        // existing arc-first engine logic
        result = buildOptionAFormations({ ...stock }, formations, cap);
    }

    const { packs, leftover } = result;

    // table
    let html = `<table><thead>
      <tr><th>Type</th><th>Infantry</th><th>Calvary</th><th>Archer</th><th>Total</th></tr>
    </thead><tbody>`;
    if (rallySize > 0) {
      html += `<tr style="background:#162031;">
        <td><strong>CALL</strong></td>
        <td>${rally.inf}</td>
        <td>${rally.cav}</td>
        <td>${rally.arc}</td>
        <td>${rallyTotal}</td>
      </tr>`;
    }
    packs.forEach((p, idx) => {
      const tot = p.inf + p.cav + p.arc;
      html += `<tr><td>#${idx+1}</td>
        <td>${p.inf}</td>
        <td>${p.cav}</td>
        <td>${p.arc}</td>
        <td>${tot}</td></tr>`;
    });
    html += `</tbody></table>`;
    const tableEl = document.getElementById("optTableWrap");
    if (tableEl) tableEl.innerHTML = html;

    // inventory readout
    const formedTroops = packs.reduce((s,p)=>s+p.inf+p.cav+p.arc, 0);
    const totalUsed = (totalAvailBefore - (leftover.inf+leftover.cav+leftover.arc));
    const msgParts = [];
    if (rallySize > 0) {
      msgParts.push(
        `Rally used → INF ${rally.inf.toLocaleString()}, ` +
        `CAV ${rally.cav.toLocaleString()}, ` +
        `ARC ${rally.arc.toLocaleString()} ` +
        `(total ${rallyTotal.toLocaleString()}).`
      );
    } else {
      msgParts.push(`Rally not built (set "Call rally size" to consume troops first).`);
    }
    msgParts.push(
      `Formations built: ${packs.length} × cap ${cap.toLocaleString()} ` +
      `(troops placed: ${formedTroops.toLocaleString()}).`
    );
    msgParts.push(
      `Leftover → INF ${leftover.inf.toLocaleString()}, ` +
      `CAV ${leftover.cav.toLocaleString()}, ARC ${leftover.arc.toLocaleString()}.`
    );
    msgParts.push(
      `Stock used: ${totalUsed.toLocaleString()} of ${totalAvailBefore.toLocaleString()}.`
    );
    const invEl = document.getElementById("opt_inventoryReadout");
    if (invEl) { invEl.style.whiteSpace = "pre-line"; invEl.innerText = msgParts.join("\n\n"); }

    updateRecommendedDisplay();

    // ── COMPOSITION READBACK ENGINE ──
    // This is the LAST step in the chain.
    // Reads actual built formations → writes 1-decimal % back to comp fields
    // (only when user has not manually edited those fields).
    readbackCompositionFields(rally, packs);
  }

  // ---------- Public API ----------
  function wireListeners(){
    // Plot button
    const btnPlot = document.getElementById("btnPlot");
    if (btnPlot) btnPlot.addEventListener("click", () => {
      window.__optARecommendedMode = false;
      const btn = document.getElementById("opt_btnUseRecommended");
      if (btn) { btn.textContent = "🔥Recommended"; btn.style.background = ""; }
      computePlots(); onOptimize();
    });

    // Optimize button
    const btnOpt = document.getElementById("btnOptimize");
    if (btnOpt) btnOpt.addEventListener("click", () => {
      window.__optARecommendedMode = false;
      const btn = document.getElementById("opt_btnUseRecommended");
      if (btn) { btn.textContent = "🔥Recommended"; btn.style.background = ""; }
      onOptimize();
    });

    // Composition field – Call
    const compEl = getCompEl();
    if (compEl) {
      compEl.addEventListener("input", () => {
        if (_readbackWriting) return; // ignore programmatic writes from readback engine
        if (compEl.value.trim() === '') {
          compUserEdited = false;
        } else {
          compUserEdited = true;
        }
        onOptimize();
      });
    }

    // Composition field – Join
    const compJoinEl = document.getElementById("compInputJoin");
    if (compJoinEl) {
      compJoinEl.addEventListener("input", () => {
        if (_readbackWriting) return; // ignore programmatic writes from readback engine
        if (compJoinEl.value.trim() === '') {
          compJoinUserEdited = false;
        } else {
          compJoinUserEdited = true;
        }
        onOptimize();
      });
    }

    // Use Best
    const btnBest = document.getElementById("opt_btnUseBest");
    if (btnBest) btnBest.addEventListener("click", () => {
      compUserEdited = false;
      setCompInputFromBest();
      onOptimize();
    });

  // Use Recommended (Option-A engine)
    const btnUseRecommended = document.getElementById("opt_btnUseRecommended");
    if (btnUseRecommended) {
      btnUseRecommended.addEventListener("click", () => {
        if (!window.__optARecommendedMode) {
          // Switch to recommended mode
          if (window.__recommendedMarches) {
            window.__optARecommendedMode = true;
            window.__optAUserMarchCount = document.getElementById("numFormations").value;
            btnUseRecommended.textContent = "✏️ Manual";
            btnUseRecommended.style.background = "#157347";
            // Run with recommended march count but keep user's input field unchanged
            const savedVal = document.getElementById("numFormations").value;
            document.getElementById("numFormations").value = window.__recommendedMarches;
            onOptimize();
            document.getElementById("numFormations").value = savedVal;
          }
        } else {
          // Switch back to manual mode
          window.__optARecommendedMode = false;
          btnUseRecommended.textContent = "🔥Recommended";
          btnUseRecommended.style.background = "";
          onOptimize();
        }
      });
    }
  }

  function computeAll(){
    // Validate inputs before computing
    if(window.Magic && window.Magic.validateInputs && !window.Magic.validateInputs()){
      console.warn("Validation failed in Option-A, aborting compute");
      return;
    }
    
    computePlots();
    onOptimize();
    updateRecommendedDisplay();
  }

  function init(){
    if (inited) return;
    wireListeners();
    // Auto-compute on show (Option‑A)
    computeAll();
    inited = true;
  }

  // Expose
  window.OptionA = { init, computeAll };


})();
