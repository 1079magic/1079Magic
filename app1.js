/* ============================================================
 #1079 LoL App – Magic Ratio (updated for unified UI)
 Exposes: window.Magic.init()
 - No auto-run
 - Reads from shared inputs
 - Renders into Magic panel containers
 WITH ARCHER PRIORITY LOGIC
============================================================ */

(function(){
  'use strict';

  // ------------------- Constants (unchanged) -------------------
  const WINDOWS = 5;
  const BEAR_TROOPS = 5000;
  const BEAR_DEF = 10;
  const BEAR_HP = 83.3333;
  const BEAR_DEF_PER_TROOP = (BEAR_HP * BEAR_DEF) / 100;
  const BEAR_ATK_BONUS = 0.25;
  const BASE_LETHALITY = 10;
  const SKILLMOD_INF = 1.0;
  const SKILLMOD_CAV = 1.0;
  const SKILLMOD_ARC = 1.10;

  const INF_MIN_PCT = 0.075;
  const INF_MAX_PCT = 0.10;
  const CAV_MIN_PCT = 0.10;

  const FILL_THRESHOLD = 0.923;
  const MIN_INF_PCT_MARCH = 0.05;

  // ── NEW: Recommendation gates ──
  const REC_FILL_GATE   = 0.85;   // march must be ≥ 85% full
  const REC_ARC_MIN_PCT = 0.10;   // archer share must be ≥ 10%
  const REC_MAX_SINGLE  = 0.80;   // no single troop type > 80%

  let TIERS = null;
  let inited = false;
  let armed = false;

  // ── NEW: toggle state for "Use Recommended" button ──
  let _originalMarches = null;  // null = user value active; string = saved while recommended shown

  // ------------------- Utilities -------------------
  function $(id){ return document.getElementById(id); }
  function nval(id){
    const el = $(id);
    if (!el) return 0;
    const v = (el.value ?? '').trim();
    if (v === '') return 0;
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : 0;
  }
  function sumTroops(o){ return (o.inf|0)+(o.cav|0)+(o.arc|0); }
  function cloneStock(s){
    return {
      inf: Math.max(0, s.inf|0),
      cav: Math.max(0, s.cav|0),
      arc: Math.max(0, s.arc|0)
    };
  }

  // Triplet helpers
  function parseTriplet(str){
    if(!str) return null;
    const arr = str.replace(/%/g,'').trim().split(/[,\s/]+/)
      .map(Number).filter(Number.isFinite);
    if(!arr.length) return null;
    let i = arr[0] ?? 0;
    let c = arr[1] ?? 0;
    let a = arr[2] ?? (100 - (i+c));
    const S = i+c+a;
    if (S <= 0) return null;
    return { i:i/S, c:c/S, a:a/S };
  }
  function toPctTriplet(fr){
    const S = (fr.i??0)+(fr.c??0)+(fr.a??0) || 1;
    const pi = Math.round((fr.i??0)/S*100);
    const pc = Math.round((fr.c??0)/S*100);
    const pa = 100 - pi - pc;
    return `${pi}/${pc}/${pa}`;
  }

  // ------------------- Damage Engine -------------------
  function perTroopAttack(baseAtk){
    return baseAtk * (1 + BEAR_ATK_BONUS) * (BASE_LETHALITY/100);
  }
  function computeFormationDamage(pack, tierKey){
    const t = TIERS?.tiers?.[tierKey];
    if(!t){
      return {finalScore:0, byType:{inf:0,cav:0,arc:0}, round10Total:0};
    }
    const nInf = pack.inf|0;
    const nCav = pack.cav|0;
    const nArc = pack.arc|0;
    const total = nInf+nCav+nArc;
    if(total <= 0){
      return {finalScore:0, byType:{inf:0,cav:0,arc:0}, round10Total:0};
    }
    const armyMin = Math.min(total, BEAR_TROOPS);
    const atkInf = perTroopAttack(t.inf[0]);
    const atkCav = perTroopAttack(t.cav[0]);
    const atkArc = perTroopAttack(t.arc[0]);
    const dInf = Math.sqrt(nInf*armyMin)*(atkInf/BEAR_DEF_PER_TROOP)/100*SKILLMOD_INF;
    const dCav = Math.sqrt(nCav*armyMin)*(atkCav/BEAR_DEF_PER_TROOP)/100*SKILLMOD_CAV;
    const dArc = Math.sqrt(nArc*armyMin)*(atkArc/BEAR_DEF_PER_TROOP)/100*SKILLMOD_ARC;
    const total0 = dInf+dCav+dArc;
    const total10 = total0*10;
    return {
      byType:{inf:dInf,cav:dCav,arc:dArc},
      round10Total:total10,
      finalScore:Math.ceil(total10)
    };
  }

  // ------------------- 1:1 Ratio Helpers -------------------
  function attackFactor(atk, let_){ return (1 + atk/100) * (1 + let_/100); }
  function originalArcherCoef(tierKey){ return (tierKey === 'T6') ? (4.4/1.25) : (2.78/1.45); }
  function computeExactOptimalFractions(stats, tierKey){
    let Ainf = attackFactor(stats.inf_atk, stats.inf_let);
    let Acav = attackFactor(stats.cav_atk, stats.cav_let);
    let Aarc = attackFactor(stats.arc_atk, stats.arc_let);
    Ainf = Math.max(Ainf, 1e-6);
    Acav = Math.max(Acav, 1e-6);
    Aarc = Math.max(Aarc, 1e-6);
    const KARC = originalArcherCoef(tierKey);
    const alpha = Ainf / 1.12;
    const beta = Acav;
    const gamma = KARC * Aarc;
    const a2 = alpha*alpha;
    const b2 = beta*beta;
    const g2 = gamma*gamma;
    const sum = a2 + b2 + g2;
    if (!isFinite(sum) || sum <= 0) return {fi:0.08, fc:0.12, fa:0.80};
    return { fi: a2/sum, fc: b2/sum, fa: g2/sum };
  }
  function enforceBounds(fr){
    let i = fr.fi, c = fr.fc, a = fr.fa;
    if(i < INF_MIN_PCT) i = INF_MIN_PCT;
    if(i > INF_MAX_PCT) i = INF_MAX_PCT;
    if(c < CAV_MIN_PCT) c = CAV_MIN_PCT;
    a = 1 - i - c;
    if(a < 0){
      c = Math.max(CAV_MIN_PCT, 1 - i);
      a = 1 - i - c;
      if(a < 0){ a = 0; c = 1 - i; }
    }
    const S = i+c+a;
    return { fi:i/S, fc:c/S, fa:a/S };
  }

  // ================ ARCHER PRIORITY LOGIC ================
  function allocateArchersToJoins(stock, X, joinCap, minInfPct, minCavPct) {
    const s = cloneStock(stock);
    const joins = [];
    
    for (let i = 0; i < X; i++) {
      if (joinCap <= 0) {
        joins.push({ inf: 0, cav: 0, arc: 0 });
        continue;
      }

      const minInf = Math.ceil(joinCap * minInfPct);
      const minCav = Math.ceil(joinCap * minCavPct);
      
      const p = {
        inf: Math.min(s.inf, minInf),
        cav: Math.min(s.cav, minCav),
        arc: 0
      };
      
      s.inf -= p.inf;
      s.cav -= p.cav;
      
      const remaining = joinCap - (p.inf + p.cav);
      p.arc = Math.min(s.arc, Math.max(0, remaining));
      s.arc -= p.arc;
      
      joins.push(p);
    }
    
    return { joins, leftover: s };
  }

  function allocateArchersToCall(stock, rallySize, infMin, infMax, cavMin) {
    const s = cloneStock(stock);
    
    if (rallySize <= 0) {
      return { rally: { inf: 0, cav: 0, arc: 0 }, leftover: s };
    }

    const minInf = Math.ceil(rallySize * infMin);
    const minCav = Math.ceil(rallySize * cavMin);

    let inf = Math.min(s.inf, minInf);
    s.inf -= inf;

    let cav = Math.min(s.cav, minCav);
    s.cav -= cav;

    let used = inf + cav;
    let space = rallySize - used;
    let arc = Math.min(s.arc, space);
    s.arc -= arc;
    used += arc;
    space = rallySize - used;

    if (space > 0) {
      const extraCav = Math.min(s.cav, space);
      cav += extraCav;
      s.cav -= extraCav;
      used += extraCav;
      space = rallySize - used;
    }

    if (space > 0) {
      const extraInf = Math.min(s.inf, space);
      inf += extraInf;
      s.inf -= extraInf;
    }

    return {
      rally: { inf, cav, arc },
      leftover: s
    };
  }

  function planArcherPriorityAlloc(stock0, rallySize, X, joinCap, infMin, infMax, cavMin) {
    const s = cloneStock(stock0);

    const phase1 = allocateArchersToJoins(s, X, joinCap, infMin, cavMin);
    const joins = phase1.joins;
    const remaining = phase1.leftover;

    const phase2 = allocateArchersToCall(remaining, rallySize, infMin, infMax, cavMin);
    const rally = phase2.rally;
    const finalLeftover = phase2.leftover;

    const totalUsed = sumTroops(rally) + joins.reduce((sum, p) => sum + sumTroops(p), 0);
    const TT = Math.max(1, totalUsed);
    
    const allTroops = { inf: 0, cav: 0, arc: 0 };
    allTroops.inf = rally.inf + joins.reduce((sum, p) => sum + p.inf, 0);
    allTroops.cav = rally.cav + joins.reduce((sum, p) => sum + p.cav, 0);
    allTroops.arc = rally.arc + joins.reduce((sum, p) => sum + p.arc, 0);

    const fractions = {
      i: allTroops.inf / TT,
      c: allTroops.cav / TT,
      a: allTroops.arc / TT
    };

    return {
      rally,
      packs: joins,
      leftover: finalLeftover,
      fractions,
      stats: {
        usedInf: allTroops.inf,
        usedCav: allTroops.cav,
        usedArc: allTroops.arc,
        arcReduction: stock0.arc - finalLeftover.arc
      }
    };
  }

  function improveArcherUtilization(rally, joins, leftover, joinCap, maxInfPct) {
    const lo = cloneStock(leftover);
    
    for (let i = 0; i < joins.length; i++) {
      const march = joins[i];
      const marchTotal = march.inf + march.cav + march.arc;
      
      if (marchTotal >= joinCap) continue;
      
      const space = joinCap - marchTotal;
      const canRemoveInf = march.inf - Math.ceil(joinCap * maxInfPct);
      
      if (canRemoveInf > 0 && lo.arc > 0) {
        const transfer = Math.min(canRemoveInf, lo.arc, space);
        march.inf -= transfer;
        march.arc += transfer;
        lo.arc -= transfer;
      }
    }

    return lo;
  }
  // ================ END ARCHER PRIORITY LOGIC ================

  // ------------------- Magic Ratio planning -------------------
  function coeffsByTier(tierKey){
    const t = TIERS?.tiers?.[tierKey];
    if(!t) return {inf:1, cav:1, arc:1};
    return {
      inf: perTroopAttack(t.inf[0]) / BEAR_DEF_PER_TROOP / 100 * SKILLMOD_INF,
      cav: perTroopAttack(t.cav[0]) / BEAR_DEF_PER_TROOP / 100 * SKILLMOD_CAV,
      arc: perTroopAttack(t.arc[0]) / BEAR_DEF_PER_TROOP / 100 * SKILLMOD_ARC
    };
  }
  function magicWeightsSquared(tierKey, mode){
    const K = coeffsByTier(tierKey);
    const mult = (mode === 'magic12') ? {inf:1, cav:1, arc:2} : {inf:1, cav:1, arc:1};
    return {
      wInf: (K.inf * mult.inf) ** 2,
      wCav: (K.cav * mult.cav) ** 2,
      wArc: (K.arc * mult.arc) ** 2
    };
  }
  function planMagicAlloc(mode, stockIn, rallySize, X, cap, tierKey){
    const s = cloneStock(stockIn);
    const R = Math.max(0, rallySize|0);
    const C = Math.max(0, cap|0);
    const Xn = Math.max(0, X|0);
    const T = R + Xn * C;

    const { wInf, wCav, wArc } = magicWeightsSquared(tierKey, mode);
    const sumW = Math.max(1e-9, wInf + wCav + wArc);
    const base = {
      inf: T * (wInf / sumW),
      cav: T * (wCav / sumW),
      arc: T * (wArc / sumW)
    };

    let target = {
      inf: Math.min(s.inf, Math.round(base.inf)),
      cav: Math.min(s.cav, Math.round(base.cav)),
      arc: Math.min(s.arc, Math.round(base.arc))
    };
    let used = target.inf + target.cav + target.arc;
    let deficit = T - used;

    const prio = [['arc', wArc], ['cav', wCav], ['inf', wInf]].sort((a,b)=>b[1]-a[1]);
    while (deficit > 0) {
      let progressed = false;
      for (const [k] of prio) {
        const free = s[k] - target[k];
        if (free <= 0) continue;
        const give = Math.min(free, deficit);
        target[k] += give;
        deficit -= give;
        progressed = true;
        if (deficit <= 0) break;
      }
      if (!progressed) break;
    }

    const TT = Math.max(1, target.inf + target.cav + target.arc);
    const frac = { i: target.inf/TT, c: target.cav/TT, a: target.arc/TT };

    const rally = {
      inf: Math.min(s.inf, Math.round(frac.i * R)),
      cav: Math.min(s.cav, Math.round(frac.c * R)),
      arc: 0
    };
    rally.arc = Math.min(s.arc, R - (rally.inf + rally.cav));
    s.inf -= rally.inf; s.cav -= rally.cav; s.arc -= rally.arc;

    const joins = [];
    for (let i = 0; i < Xn; i++) {
      if (C <= 0) { joins.push({inf:0,cav:0,arc:0}); continue; }
      const m = {
        inf: Math.min(s.inf, Math.round(frac.i * C)),
        cav: Math.min(s.cav, Math.round(frac.c * C)),
        arc: 0
      };
      m.arc = Math.min(s.arc, C - (m.inf + m.cav));
      s.inf -= m.inf; s.cav -= m.cav; s.arc -= m.arc;
      joins.push(m);
    }
    return { rally, packs: joins, leftover: s, fractions: frac };
  }

  // ================================================================
  // NEW RECOMMENDATION ENGINE
  // Uses the actual fractions from this run to simulate joins.
  // Gate 1: march headcount >= 85% of cap
  // Gate 2: troop quality:
  //   a) mostly infantry with no archers (arc===0 AND inf > cav)
  //   b) missing cavalry entirely (cav===0)
  //   c) archer share < 10%
  //   d) any single troop type > 80%
  // Returns: highest N (1..maxN) where ALL N marches pass both gates.
  // ================================================================
  function evaluateMarchQuality(p, cap) {
    const total = (p.inf|0) + (p.cav|0) + (p.arc|0);
    const failures = [];
    const fill = cap > 0 ? total / cap : 0;
    if (fill < REC_FILL_GATE) failures.push(`fill ${(fill*100).toFixed(0)}%<85%`);
    if (total > 0) {
      if (p.arc === 0 && p.inf > p.cav) failures.push('inf-only');
      if (p.cav === 0) failures.push('no-cav');
      const arcPct = p.arc / total;
      if (arcPct < REC_ARC_MIN_PCT) failures.push(`arc ${(arcPct*100).toFixed(0)}%<10%`);
      const infPct = p.inf / total;
      const cavPct = p.cav / total;
      if (infPct > REC_MAX_SINGLE) failures.push(`inf ${(infPct*100).toFixed(0)}%>80%`);
      if (cavPct > REC_MAX_SINGLE) failures.push(`cav ${(cavPct*100).toFixed(0)}%>80%`);
      if (arcPct > REC_MAX_SINGLE) failures.push(`arc ${(arcPct*100).toFixed(0)}%>80%`);
    }
    return { pass: failures.length === 0, failures };
  }

  // Simulate N join marches proportionally from fractions (same as actual run)
  function simulateJoinsForRec(stockAfterCall, n, cap, fractions) {
    const s = cloneStock(stockAfterCall);
    const fi = fractions.i ?? 0;
    const fc = fractions.c ?? 0;
    const W = Math.max(1e-9, fi + fc + (fractions.a ?? 0));
    const packs = [];
    for (let i = 0; i < n; i++) {
      if (cap <= 0) { packs.push({ inf:0, cav:0, arc:0 }); continue; }
      const tInf = Math.round((fi / W) * cap);
      const tCav = Math.round((fc / W) * cap);
      const p = {
        inf: Math.min(s.inf, tInf),
        cav: Math.min(s.cav, tCav),
        arc: 0
      };
      const rem = cap - p.inf - p.cav;
      p.arc = Math.min(s.arc, Math.max(0, rem));
      s.inf -= p.inf; s.cav -= p.cav; s.arc -= p.arc;
      packs.push(p);
    }
    return packs;
  }

  function recommendMarchCount(rally, stockAfterCall, fractions, maxN, cap) {
    let bestN = 0;
    const details = [];
    for (let n = 1; n <= Math.max(1, maxN|0); n++) {
      const packs = simulateJoinsForRec(stockAfterCall, n, cap, fractions);
      let allPass = true;
      const packResults = [];
      for (let i = 0; i < packs.length; i++) {
        const { pass, failures } = evaluateMarchQuality(packs[i], cap);
        packResults.push({ march: i + 1, pass, failures });
        if (!pass) allPass = false;
      }
      details.push({ n, allPass, packs: packResults });
      if (allPass) bestN = n;
    }
    return { bestN, details };
  }
  // ================================================================
  // END NEW RECOMMENDATION ENGINE
  // ================================================================

  // ── NEW: update the recommended display text and button state ──
  function updateRecommendedDisplay(recN, X) {
    // While in recommended mode (_originalMarches is set), freeze everything —
    // don't overwrite __recommendedMarches or the display text.
    if (_originalMarches !== null) return;

    if (recN > 0) {
      window.__recommendedMarches = recN;
      $("recommendedDisplay").textContent =
        `Best: ${recN} march${recN > 1 ? 'es' : ''} — all pass ≥85% fill + troop quality gates`;
    } else {
      window.__recommendedMarches = X;
      $("recommendedDisplay").textContent = `No marches pass quality gates — showing ${X} as entered`;
    }
    // NOTE: button state is managed exclusively by the button click handler.
    // Do NOT touch _originalMarches or button text/style here.
  }

  // Called only when user triggers a fresh compute via Magic Ratio / Recompute buttons
  // (not when the Recommended button triggers compute). Resets toggle state.
  function resetRecButtonState() {
    _originalMarches = null;
    const btn = $("btnUseRecommended");
    if (btn) {
      btn.textContent = "🔥 Recommended";
      btn.style.background = "";
    }
  }

  // ------------------- Recommendation support (OLD — kept for reference, no longer called) -------------------
  function meetsTargetFill(fill){ return fill >= FILL_THRESHOLD; }
  function evaluateMarchSet(packs, cap){
    const totals = packs.map(p => (p.inf + p.cav + p.arc));
    const fills = totals.map(t => cap > 0 ? (t / cap) : 0);
    const minFill = fills.length ? Math.min(...fills) : 0;
    const avgFill = fills.length ? (fills.reduce((a,b)=>a+b,0) / fills.length) : 0;
    const fullCount = fills.filter(f => meetsTargetFill(f)).length;
    return { minFill, avgFill, fullCount };
  }
  function buildJoinRallies(mode, stockIn, X, cap, tierKey, manualTriplet=null){
    const s = cloneStock(stockIn);
    const w = manualTriplet ? {inf:manualTriplet.i, cav:manualTriplet.c, arc:manualTriplet.a} : {inf:1, cav:1, arc:1};
    const W = Math.max(1e-9, w.inf + w.cav + w.arc);
    const packs = [];
    for (let i=0; i<X; i++){
      const tInf = Math.round((w.inf / W) * cap);
      const tCav = Math.round((w.cav / W) * cap);
      const p = {
        inf: Math.min(s.inf, tInf),
        cav: Math.min(s.cav, tCav),
        arc: 0
      };
      const rem = cap - (p.inf + p.cav);
      p.arc = Math.min(s.arc, rem);
      s.inf -= p.inf; s.cav -= p.cav; s.arc -= p.arc;
      packs.push(p);
    }
    return { packs, leftover: s };
  }

  // ------------------- Rendering -------------------
  function renderCallTable(r){
    $("callRallyTable").innerHTML = `
      <table>
        <thead>
          <tr><th>Type</th><th>Infantry</th><th>Cavalry</th><th>Archers</th><th>Total</th></tr>
        </thead>
        <tbody>
          <tr style="background:#162031;">
            <td><strong>CALL</strong></td>
            <td>${r.inf}</td>
            <td>${r.cav}</td>
            <td>${r.arc}</td>
            <td>${sumTroops(r)}</td>
          </tr>
        </tbody>
      </table>
    `;
  }
  function renderJoinTable(joins){
    let out = `
      <table>
        <thead>
          <tr><th>#</th><th>Infantry</th><th>Cavalry</th><th>Archers</th><th>Total</th></tr>
        </thead>
        <tbody>
    `;
    joins.forEach((p,i)=>{
      out += `
        <tr>
          <td>#${i+1}</td>
          <td>${p.inf}</td>
          <td>${p.cav}</td>
          <td>${p.arc}</td>
          <td>${sumTroops(p)}</td>
        </tr>
      `;
    });
    out += `</tbody></table>`;
    $("joinTableWrap").innerHTML = out;
  }
  function renderScoreboardCompact(rally, joins, tierKey){
    const callScore = computeFormationDamage(rally, tierKey).finalScore;
    let joinScore = 0; for(const p of joins){ joinScore += computeFormationDamage(p, tierKey).finalScore; }
    let out = `
      <table>
        <thead>
          <tr><th>Window</th><th>Call</th><th>Joins</th><th>Total</th></tr>
        </thead>
        <tbody>
    `;
    for(let w=1; w<=WINDOWS; w++){
      out += `
        <tr>
          <td>${w}</td>
          <td>${callScore}</td>
          <td>${joinScore}</td>
          <td>${callScore + joinScore}</td>
        </tr>
      `;
    }
    out += `</tbody></table>`;
    $("scoreboardTableWrap").innerHTML = out;
  }

  function renderFinalScoreboard(rally, joins, tierKey) {
    const callDmg  = computeFormationDamage(rally, tierKey);
    const callScore = callDmg.finalScore;

    let joinScore = 0;
    for (const p of joins) {
      joinScore += computeFormationDamage(p, tierKey).finalScore;
    }
    const totalScore = callScore + joinScore;

    const callTotal = Math.max(1, sumTroops(rally));
    const callFrac = {
      i: rally.inf / callTotal,
      c: rally.cav / callTotal,
      a: rally.arc / callTotal
    };

    let jInf = 0, jCav = 0, jArc = 0;
    for (const p of joins) { jInf += p.inf; jCav += p.cav; jArc += p.arc; }
    const joinTotal = Math.max(1, jInf + jCav + jArc);
    const joinFrac = {
      i: jInf / joinTotal,
      c: jCav / joinTotal,
      a: jArc / joinTotal
    };

    const callTrip = toPctTriplet(callFrac);
    const joinTrip = toPctTriplet(joinFrac);

    let html = `
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>CALL formation</th>
            <th>CALL score</th>
            <th>JOIN formation</th>
            <th>JOIN score</th>
            <th>Total score</th>
          </tr>
        </thead>
        <tbody>
    `;
    html += `
      <tr>
        <td>✅ Final</td>
        <td>${callTrip}</td>
        <td>${callScore.toLocaleString()}</td>
        <td>${joinTrip}</td>
        <td>${joinScore.toLocaleString()}</td>
        <td><strong>${totalScore.toLocaleString()}</strong></td>
      </tr>
    `;
    html += `</tbody></table>`;

    $("scoreboardTableWrap").innerHTML = html;
  }

  // Hybrid Post-fix (unchanged)
  function ensureMinInf(march, minInf, stockLeftover){
    if (march.inf >= minInf) return;
    let need = minInf - march.inf;
    if (stockLeftover.inf > 0) {
      const take = Math.min(stockLeftover.inf, need);
      march.inf += take; stockLeftover.inf -= take; need -= take;
    }
    if (need > 0) { const fromCav = Math.min(march.cav, need); march.cav -= fromCav; march.inf += fromCav; need -= fromCav; }
    if (need > 0) { const fromArc = Math.min(march.arc, need); march.arc -= fromArc; march.inf += fromArc; need -= fromArc; }
  }
  function adjustCallRallyCapsAndBias(rally, leftover, rallySize, opts = {}) {
    const minInf = Math.ceil(rallySize * MIN_INF_PCT_MARCH);
    const maxInf = Math.floor(rallySize * (opts.maxInfPct ?? 0.20));
    const maxCav = Math.floor(rallySize * (opts.maxCavPct ?? 0.30));

    if (rally.inf < minInf) {
      let need = minInf - rally.inf;
      if (leftover.inf > 0) {
        const take = Math.min(leftover.inf, need);
        rally.inf += take; leftover.inf -= take; need -= take;
      }
      if (need > 0) { const fromCav = Math.min(rally.cav, need); rally.cav -= fromCav; rally.inf += fromCav; need -= fromCav; }
      if (need > 0) { const fromArc = Math.min(rally.arc, need); rally.arc -= fromArc; rally.inf += fromArc; need -= fromArc; }
    }

    function swapIntoArc(fromKey, amount) {
      if (amount <= 0 || leftover.arc <= 0) return 0;
      const give = Math.min(amount, leftover.arc);
      rally[fromKey] -= give;
      rally.arc += give;
      leftover.arc -= give;
      leftover[fromKey] += give;
      return give;
    }

    if (rally.inf > maxInf) {
      let cut = rally.inf - maxInf;
      const arcTaken = swapIntoArc("inf", cut); cut -= arcTaken;
      if (cut > 0 && rally.cav < maxCav && leftover.cav > 0) {
        const cavRoom = maxCav - rally.cav;
        const give = Math.min(cut, cavRoom, leftover.cav);
        rally.inf -= give; rally.cav += give;
        leftover.cav -= give; leftover.inf += give; cut -= give;
      }
    }
    if (rally.cav > maxCav) {
      let cut = rally.cav - maxCav;
      const arcFromCav = swapIntoArc("cav", cut); cut -= arcFromCav;
      if (cut > 0 && rally.inf < minInf) {
        const room = minInf - rally.inf;
        const give = Math.min(cut, room);
        rally.cav -= give; rally.inf += give; leftover.cav += give; cut -= give;
      }
    }

    const biasPct = opts.arcBiasPct ?? 0.03;
    let want = Math.max(0, Math.ceil(rallySize * biasPct));
    if (want > 0 && leftover.arc > 0) {
      if (rally.inf > minInf) {
        const canReduceInf = rally.inf - minInf;
        const takeFromInf = Math.min(canReduceInf, want, leftover.arc);
        rally.inf -= takeFromInf; rally.arc += takeFromInf; leftover.arc -= takeFromInf; leftover.inf += takeFromInf; want -= takeFromInf;
      }
      if (want > 0 && rally.cav > 0 && leftover.arc > 0) {
        const takeFromCav = Math.min(rally.cav, want, leftover.arc);
        rally.cav -= takeFromCav; rally.arc += takeFromCav; leftover.arc -= takeFromCav; leftover.cav += takeFromCav; want -= takeFromCav;
      }
    }

    if (rally.inf < minInf) {
      const need = minInf - rally.inf;
      const fromArc = Math.min(rally.arc, need); rally.arc -= fromArc; rally.inf += fromArc;
      let still = need - fromArc;
      if (still > 0) { const fromCav = Math.min(rally.cav, still); rally.cav -= fromCav; rally.inf += fromCav; }
    }
  }
  function applyPriorityPostFix(rally, joins, leftover, rallySize, joinCap){
    const marches = [rally, ...joins];
    const mins = [Math.ceil(rallySize * MIN_INF_PCT_MARCH)];
    for (let i=0; i<joins.length; i++){ mins.push(Math.ceil(joinCap * MIN_INF_PCT_MARCH)); }

    for (let i=0; i<marches.length; i++){ ensureMinInf(marches[i], mins[i], leftover); }

    const types = ["arc", "cav"];
    for (const t of types){
      if (leftover[t] <= 0) continue;
      let progressed = true;
      while (leftover[t] > 0 && progressed) {
        progressed = false;
        for (let i=0; i<marches.length; i++){
          const m = marches[i];
          const minInf = mins[i];
          const before = m.inf + m.cav + m.arc;
          let excess = Math.max(0, m.inf - minInf);
          if (excess <= 0) continue;
          const give = Math.min(excess, leftover[t]);
          if (give <= 0) continue;
          m.inf -= give; m[t] += give; leftover[t] -= give; leftover.inf += give;
          const after = m.inf + m.cav + m.arc;
          if (after === before) progressed = true;
          if (leftover[t] <= 0) break;
        }
      }
    }
  }

  function deriveJoinFractions(joins){
    let I=0,C=0,A=0;
    for (const p of joins){ I+=p.inf; C+=p.cav; A+=p.arc; }
    const S = Math.max(1, I+C+A);
    return { i: I/S, c: C/S, a: A/S };
  }
  function* generateTriplets(bounds, stepPct){
    const step = Math.max(1, stepPct|0);
    for (let i=bounds.infMin; i<=bounds.infMax; i+=step){
      for (let c=bounds.cavMin; c<=bounds.cavMax; c+=step){
        const a = 100 - i - c;
        if (a < bounds.arcMin) continue;
        if (a > bounds.arcMax) continue;
        if (a < 0) continue;
        yield { i:i/100, c:c/100, a:a/100, label:`${i}/${c}/${a}` };
      }
    }
  }
  function simulateTriplet(tierKey, stock0, rallySize, X, joinCap, triplet){
    const cr = buildCallRally("ratio11", stock0, rallySize, tierKey, triplet);
    const jr = buildJoinRallies("ratio11", cr.stockAfter, X, joinCap, tierKey, triplet);
    const rally = cr.rally;
    const joins = jr.packs;
    const leftover = jr.leftover;
    const lo = { inf:leftover.inf, cav:leftover.cav, arc:leftover.arc };
    applyPriorityPostFix(rally, joins, lo, rallySize, joinCap);
    const callScore = computeFormationDamage(rally, tierKey).finalScore;
    let joinScore = 0; for (const p of joins) joinScore += computeFormationDamage(p, tierKey).finalScore;
    const usedCallFrac = (()=>{ const T = Math.max(1, rally.inf + rally.cav + rally.arc); return { i:rally.inf/T, c:rally.cav/T, a:rally.arc/T }; })();
    const usedJoinFrac = deriveJoinFractions(joins);
    return { call: rally, joins, leftover: lo, callScore, joinScore, totalScore: callScore + joinScore, usedCallFrac, usedJoinFrac };
  }
  function findTopSetups(tierKey, stock0, rallySize, X, joinCap, opts={}){
    const CAV_MIN_PCT_SWEEP = 10;
    const bounds = {
      infMin: Math.round(MIN_INF_PCT_MARCH*100),
      infMax: 40,
      cavMin: CAV_MIN_PCT_SWEEP,
      cavMax: 45,
      arcMin: 0,
      arcMax: 100
    };
    const stepPct = Math.min(Math.max(1, opts.stepPct || 1), 5);
    const results = [];
    for (const triplet of generateTriplets(bounds, stepPct)){
      const res = simulateTriplet(tierKey, cloneStock(stock0), rallySize, X, joinCap, triplet);
      results.push({ triplet, ...res });
    }
    results.sort((a,b) => b.totalScore - a.totalScore);
    return results.slice(0, 10);
  }

  // 1:1 simple builder
  function buildCallRally(mode, stock, rallySize, tierKey, manual){
    const s = cloneStock(stock);
    if(rallySize <= 0) return {rally:{inf:0, cav:0, arc:0}, stockAfter:s};
    const w = manual ? {inf:manual.i, cav:manual.c, arc:manual.a} : {inf:1, cav:1, arc:1};
    const W = Math.max(1e-9, w.inf + w.cav + w.arc);
    const t = rallySize;
    let idealInf = Math.round((w.inf / W) * t);
    let idealCav = Math.round((w.cav / W) * t);
    const r = {
      inf: Math.min(s.inf, idealInf),
      cav: Math.min(s.cav, idealCav),
      arc: 0
    };
    const remaining = t - (r.inf + r.cav);
    r.arc = Math.min(s.arc, remaining);
    s.inf -= r.inf; s.cav -= r.cav; s.arc -= r.arc;
    return { rally:r, stockAfter:s };
  }

  // ------------------- Compute flow -------------------
  function compute(mode){
    const tierKey = $("troopTier").value;
    const tier = TIERS?.tiers?.[tierKey];
    $("selectedTierNote").textContent = tier
      ? `Using tier ${tierKey} — Base ATK ${tier.inf[0]}/${tier.cav[0]}/${tier.arc[0]}`
      : "";

    const stock0 = {
      inf: nval("stockInf"),
      cav: nval("stockCav"),
      arc: nval("stockArc")
    };
    const rallySize = nval("rallySize");
    const joinCap = nval("marchSize");
    const X = nval("numFormations");
    const parsed = parseTriplet($("compInput").value);
    const manual = parsed ? parsed : null;

    let rally, joins, leftover, fractions;

    if (mode === "magic12") {
      const top10 = findTopSetups(tierKey, stock0, rallySize, X, joinCap, { stepPct: 1 });
      let rallyBest, joinsBest, leftoverBest;
      if (top10 && top10.length) {
        const best = top10[0];
        rallyBest = best.call; joinsBest = best.joins; leftoverBest = best.leftover;
        adjustCallRallyCapsAndBias(rallyBest, leftoverBest, rallySize, {
          maxInfPct: 0.20, maxCavPct: 0.30, arcBiasPct: 0.03
        });
        applyPriorityPostFix(rallyBest, joinsBest, leftoverBest, rallySize, joinCap);

        // Apply archer priority optimization AFTER existing logic
        const archerOptimized = planArcherPriorityAlloc(
          stock0, rallySize, X, joinCap, INF_MIN_PCT, INF_MAX_PCT, CAV_MIN_PCT
        );
        if (archerOptimized.leftover.arc < leftoverBest.arc) {
          rallyBest = archerOptimized.rally;
          joinsBest = archerOptimized.packs;
          leftoverBest = archerOptimized.leftover;
        }
        renderFinalScoreboard(rallyBest, joinsBest, tierKey);

      } else {
        const plan = planMagicAlloc("magic12", stock0, rallySize, X, joinCap, tierKey);
        rallyBest = plan.rally; joinsBest = plan.packs; leftoverBest = plan.leftover;
        adjustCallRallyCapsAndBias(rallyBest, leftoverBest, rallySize, {
          maxInfPct: 0.20, maxCavPct: 0.30, arcBiasPct: 0.03
        });
        applyPriorityPostFix(rallyBest, joinsBest, leftoverBest, rallySize, joinCap);

        const archerOptimized = planArcherPriorityAlloc(
          stock0, rallySize, X, joinCap, INF_MIN_PCT, INF_MAX_PCT, CAV_MIN_PCT
        );
        if (archerOptimized.leftover.arc < leftoverBest.arc) {
          rallyBest = archerOptimized.rally;
          joinsBest = archerOptimized.packs;
          leftoverBest = archerOptimized.leftover;
        }
        renderFinalScoreboard(rallyBest, joinsBest, tierKey);
      }
      rally = rallyBest; joins = joinsBest; leftover = leftoverBest;
      const tCall = Math.max(1, sumTroops(rally));
      fractions = { i:rally.inf/tCall, c:rally.cav/tCall, a:rally.arc/tCall };

    } else {
      // ratio11 mode
      let stats = {
        inf_atk:nval("inf_atk"),
        inf_let:nval("inf_let"),
        cav_atk:nval("cav_atk"),
        cav_let:nval("cav_let"),
        arc_atk:nval("arc_atk"),
        arc_let:nval("arc_let")
      };
      for (const k of ["inf_atk","inf_let","cav_atk","cav_let","arc_atk","arc_let"]) {
        if (!Number.isFinite(stats[k]) || stats[k] <= 0) stats[k] = 1;
      }
      let opt = computeExactOptimalFractions(stats, tierKey);
      opt = enforceBounds(opt);
      if (!isFinite(opt.fi) || !isFinite(opt.fc) || !isFinite(opt.fa)) {
        opt = { fi:0.08, fc:0.12, fa:0.80 };
      }
      const frac = { i: opt.fi, c: opt.fc, a: opt.fa };
      const useFrac = manual ? manual : frac;

      const cr = buildCallRally("ratio11", stock0, rallySize, tierKey, useFrac);
      const jr = buildJoinRallies("ratio11", cr.stockAfter, X, joinCap, tierKey, useFrac);
      rally = cr.rally; joins = jr.packs; leftover = jr.leftover;

      const archerOptimized = planArcherPriorityAlloc(
        stock0, rallySize, X, joinCap, INF_MIN_PCT, INF_MAX_PCT, CAV_MIN_PCT
      );
      if (archerOptimized.leftover.arc < leftover.arc) {
        rally = archerOptimized.rally;
        joins = archerOptimized.packs;
        leftover = archerOptimized.leftover;
        fractions = archerOptimized.fractions;
      } else {
        const tCall = Math.max(1, sumTroops(rally));
        fractions = { i:rally.inf/tCall, c:rally.cav/tCall, a:rally.arc/tCall };
      }
      renderFinalScoreboard(rally, joins, tierKey);
    }

    // ── NEW RECOMMENDATION ENGINE ──
    const stockAfterCall = {
      inf: Math.max(0, (stock0.inf|0) - (rally.inf|0)),
      cav: Math.max(0, (stock0.cav|0) - (rally.cav|0)),
      arc: Math.max(0, (stock0.arc|0) - (rally.arc|0))
    };
    const recResult = recommendMarchCount(rally, stockAfterCall, fractions, X, joinCap);
    updateRecommendedDisplay(recResult.bestN, X);

    // Display
    renderCallTable(rally);
    renderJoinTable(joins);
    $("fractionReadout").textContent = `Using: ${toPctTriplet(fractions)} (Inf/Cav/Arc)`;
    const formed = joins.reduce((s,p)=>s+sumTroops(p),0);
    const before = sumTroops(stock0);
    const used = sumTroops(rally) + formed;
    $("inventoryReadout").textContent =
      `Rally ${sumTroops(rally)} used → INF ${rally.inf}, CAV ${rally.cav}, ARC ${rally.arc}.
Formations built: ${joins.length} × ${joinCap} → ${formed} troops.
Leftover → INF ${leftover.inf}, CAV ${leftover.cav}, ARC ${leftover.arc}.
Stock used: ${used} / ${before}.`;

    $("hiddenLastMode").value = mode;
    $("hiddenBestFractions").value = toPctTriplet(fractions);
  }

  // ------------------- Public API -------------------
  async function init(){
    if (inited) return;
    if (!TIERS){
      try {
        const res = await fetch("tiers.json", {cache:"no-store"});
        TIERS = await res.json();
      } catch(e){
        console.error("tiers.json failed", e);
        if (location.protocol === "file:") {
          alert("Running from file:// blocks fetch of tiers.json.\nStart a local server or use Netlify.\nUsing a minimal inline fallback for testing.");
          TIERS = {
            tiers: {
              "T6":      { "inf": [243, 730],  "cav": [730, 243],  "arc": [974,183] },
              "T9":      { "inf": [400,1200], "cav": [1200,400], "arc": [1600,300] },
              "T10":     { "inf": [472,1416], "cav": [1416,470], "arc": [1888,354] },
              "T10.TG1": { "inf": [491,1473], "cav": [1473,491], "arc": [1964,368] },
              "T10.TG2": { "inf": [515,1546], "cav": [1546,515], "arc": [2062,387] },
              "T10.TG3": { "inf": [541,1624], "cav": [1624,541], "arc": [2165,402] },
              "T10.TG4": { "inf": [568,1705], "cav": [1705,568], "arc": [2273,426] },
              "T10.TG5": { "inf": [597,1790], "cav": [1790,597], "arc": [2387,448] }
            }
          };
        } else {
          TIERS = { tiers:{} };
        }
      }
    }

    $("btnMagic12")?.addEventListener("click", () => { resetRecButtonState(); compute("magic12"); });
    $("btnRecompute")?.addEventListener("click", () => {
      resetRecButtonState();
      const mode = $("hiddenLastMode")?.value || "magic12";
      compute(mode);
    });

    // ── "Use Recommended" button — single click applies, second click restores ──
    $("btnUseRecommended")?.addEventListener("click", () => {
      const btn = $("btnUseRecommended");

      if (_originalMarches === null) {
        // First click: capture recN NOW before any compute can overwrite it,
        // save original march count, apply recommended, flip to ✏️ Manual
        const recN = window.__recommendedMarches;
        if (!recN) return;
        _originalMarches = $("numFormations").value;
        $("numFormations").value = recN;
        if (btn) {
          btn.textContent = "✏️ Manual";
          btn.style.background = "#157347";
        }
        const mode = $("hiddenLastMode")?.value || "magic12";
        Promise.resolve().then(() => compute(mode));
      } else {
        // Second click: restore original value, reset button
        $("numFormations").value = _originalMarches;
        _originalMarches = null;
        if (btn) {
          btn.textContent = "🔥 Recommended";
          btn.style.background = "";
        }
        const mode = $("hiddenLastMode")?.value || "magic12";
        Promise.resolve().then(() => compute(mode));
      }
    });

    $("compInput")?.addEventListener("input", () => {
      const p = parseTriplet($("compInput").value);
      $("compHint").textContent = p ? `Manual override: ${toPctTriplet(p)}` : `Invalid or empty → auto fractions`;
    });

    inited = true;
    compute("magic12");
  }

  // Expose
  window.Magic = { init, compute, validateInputs: () => true };

})();
