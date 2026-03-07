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

// ---------- Rally Build (RESPECT MANUAL FRACTIONS) ----------
function buildRally(fractions, rallySize, stock) {

  if (rallySize <= 0)
    return { inf: 0, cav: 0, arc: 0 };

  // Extract user fractions
  let fInf = fractions.fin;
  let fCav = fractions.fcav;
  let fArc = fractions.farc;

  // Compute ideal troop counts from fractions
  let idealInf = Math.round(fInf * rallySize);
  let idealCav = Math.round(fCav * rallySize);
  let idealArc = Math.round(fArc * rallySize);

  // Ensure we do not exceed available stock
  let inf = Math.min(stock.inf, idealInf);
  let cav = Math.min(stock.cav, idealCav);
  let arc = Math.min(stock.arc, idealArc);

  // Fix rounding deficit (under-filled rally)
  let used = inf + cav + arc;
  if (used < rallySize) {
    let deficit = rallySize - used;

    // Priority to the highest fraction type
    const order = [
      ["arc", fArc],
      ["cav", fCav],
      ["inf", fInf]
    ].sort((a, b) => b[1] - a[1]); // highest first

    for (const [type] of order) {
      if (deficit <= 0) break;
      let free = stock[type] - ({inf, cav, arc}[type]);
      if (free > 0) {
        const add = Math.min(free, deficit);
        if (type === "inf") inf += add;
        if (type === "cav") cav += add;
        if (type === "arc") arc += add;
        deficit -= add;
      }
    }
  }

  // ================================
  // ENFORCE GAME BOUND RULES
  // ================================
  const iMin = Math.ceil(INF_MIN_PCT * rallySize);
  const iMax = Math.floor(INF_MAX_PCT * rallySize);
  const cMin = Math.ceil(CAV_MIN_PCT * rallySize);

  // --- Enforce minimum infantry ---
  if (inf < iMin) {
    let need = iMin - inf;

    // Try swap from arc
    let fromArc = Math.min(arc, need);
    arc -= fromArc; inf += fromArc; need -= fromArc;

    // Try swap from cav
    if (need > 0) {
      let fromCav = Math.min(cav, need);
      cav -= fromCav; inf += fromCav; need -= fromCav;
    }
  }

  // --- Enforce maximum infantry ---
  if (inf > iMax) {
    let excess = inf - iMax;

    let toArc = Math.min(excess, stock.arc - arc);
    arc += toArc; inf -= toArc; excess -= toArc;

    if (excess > 0) {
      cav += excess;
      inf -= excess;
    }
  }

  // --- Enforce minimum cavalry ---
  if (cav < cMin) {
    let need = cMin - cav;
    let fromArc = Math.min(arc, need);
    arc -= fromArc; cav += fromArc;
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
    const infMinPer = Math.ceil(INF_MIN_PCT * cap);
    const infMaxPer = Math.floor(INF_MAX_PCT * cap);
    const cavMinPer = Math.ceil(CAV_MIN_PCT * cap);

    const infAlloc = Array(n).fill(0);
    const cavAlloc = Array(n).fill(0);
    const arcAlloc = Array(n).fill(0);

    // Step 1: Distribute archers first (max arc per march up to cap)
    const arcCaps = Array(n).fill(cap);
    const arcGive = fillRoundRobin(stock.arc, arcCaps);
    for (let i=0; i<n; i++) { arcAlloc[i] = arcGive[i]; stock.arc -= arcGive[i]; }

    // Step 2: Fill remaining space with cavalry (up to cap)
    const cavCaps = Array(n).fill(0).map((_,i) => Math.max(0, cap - arcAlloc[i]));
    const cavGive = fillRoundRobin(stock.cav, cavCaps);
    for (let i=0; i<n; i++) { cavAlloc[i] = cavGive[i]; stock.cav -= cavGive[i]; }

    // Step 3: Fill remaining space with infantry (up to infMax)
    const infCaps = Array(n).fill(0).map((_,i) => {
      const free = Math.max(0, cap - arcAlloc[i] - cavAlloc[i]);
      return Math.min(free, infMaxPer);
    });
    const infGive = fillRoundRobin(stock.inf, infCaps);
    for (let i=0; i<n; i++) { infAlloc[i] = infGive[i]; stock.inf -= infGive[i]; }

    // Step 4: Enforce minimum infantry per march (swap from arc first, then cav)
    for (let i=0; i<n; i++) {
      if (infAlloc[i] < infMinPer) {
        const need = infMinPer - infAlloc[i];
        const fromArc = Math.min(arcAlloc[i], need, stock.inf >= 0 ? need : 0);
        // swap: reduce arc, add inf (inf comes from stock if available)
        const fromArcAdj = Math.min(arcAlloc[i], need);
        arcAlloc[i] -= fromArcAdj; infAlloc[i] += fromArcAdj;
        const stillNeed = infMinPer - infAlloc[i];
        if (stillNeed > 0) {
          const fromCav = Math.min(cavAlloc[i], stillNeed);
          cavAlloc[i] -= fromCav; infAlloc[i] += fromCav;
        }
      }
    }

    // Step 5: Enforce minimum cavalry per march (swap from arc)
    for (let i=0; i<n; i++) {
      if (cavAlloc[i] < cavMinPer) {
        const need = cavMinPer - cavAlloc[i];
        const fromArc = Math.min(arcAlloc[i], need);
        arcAlloc[i] -= fromArc; cavAlloc[i] += fromArc;
      }
    }

    const packs = [];
    for (let i=0; i<n; i++) {
      packs.push({ inf: infAlloc[i], cav: cavAlloc[i], arc: arcAlloc[i] });
    }
    return { packs, leftover: { inf:stock.inf, cav:stock.cav, arc:stock.arc } };
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
        // NEW: manual override for JOIN marches
        result = buildJoinManually({ ...stock }, formations, cap, joinFractionsManual);
    } else {
        // existing logic
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

    // Composition field (shared)
    const compEl = getCompEl();
    if (compEl) {
      compEl.addEventListener("input", () => {
        compUserEdited = true;
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
    // Auto-compute on show (Option‑A = C)
    computeAll();
    inited = true;
  }

  // Expose
  window.OptionA = { init, computeAll };


})();
