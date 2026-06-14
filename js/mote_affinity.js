// ============ GREY VECTOR — MOTE AFFINITY ============
// Mote 是 V-07 的情感錨。它的「親密度」是隱藏數值,影響 Mote 的行為與
// 後期 decoded dialogue 解鎖。預設 50,範圍 0-100。
//   ag.moteAffinity   int 0-100  → Mote 對 V-07 的信任度
//   ag.cycleNum       int        → 當前 cycle 編號(預設 347)
//   ag.seedIntegrity  int 0-100  → V-07 當前 Seed 完整度(預設 87)
//
// Classic-script. Declares globally:
//   getMoteAffinity() · bumpMoteAffinity(delta)
//   getCycleNum() · bumpCycleNum()
//   getSeedIntegrity() · setSeedIntegrity(v)
//
// External deps: localStorage · AG.set

function getMoteAffinity() {
  try { const n = parseInt(localStorage.getItem('ag.moteAffinity') || '50', 10);
        return isFinite(n) ? Math.max(0, Math.min(100, n)) : 50; }
  catch (e) { return 50; }
}
function bumpMoteAffinity(delta) {
  const cur = getMoteAffinity();
  const next = Math.max(0, Math.min(100, cur + delta));
  try { localStorage.setItem('ag.moteAffinity', String(next)); } catch (e) {}
  // Refresh start-screen chip if visible
  const chip = document.getElementById('moteChip');
  if (chip) chip.textContent = `MOTE ${next}%`;
  return next;
}
function getCycleNum() {
  try { const n = parseInt(localStorage.getItem('ag.cycleNum') || '347', 10);
        return isFinite(n) ? n : 347; }
  catch (e) { return 347; }
}
function bumpCycleNum() {
  const n = getCycleNum() + 1;
  try { localStorage.setItem('ag.cycleNum', String(n)); } catch (e) {}
  const chip = document.getElementById('cycleChip');
  if (chip) chip.textContent = `CYCLE #${n}`;
  return n;
}
// 184r — removed dead getSeedIntegrity()/setSeedIntegrity() (zero call sites;
// the SEED-integrity HUD readout was cut, leaving these orphaned).
