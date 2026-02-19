#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const RUNS = path.join(__dirname, 'runs');

const dirs = fs.readdirSync(RUNS).filter(d => fs.existsSync(path.join(RUNS, d, 'record.json'))).sort().reverse();
const records = dirs.map(d => { try { return JSON.parse(fs.readFileSync(path.join(RUNS, d, 'record.json'), 'utf8')); } catch { return null; } }).filter(Boolean);

const icon = s => s === 'passed' ? '✓' : '✗';
const ms = v => v ? (v / 1000).toFixed(1) + 's' : '-';
const pColor = p => p === 'macos' ? '#f472b6' : p === 'web' ? '#60a5fa' : p === 'ios' ? '#fbbf24' : '#6ee7b7';
const passed = records.filter(r => r.status === 'passed').length;
const platforms = [...new Set(records.map(r => r.platform))];

const rows = records.map((r, ri) => {
  const sum = r.summary || {};
  const tags = Object.entries(sum.failureTags || {}).map(([k,v]) => `<span class="tag">${k}×${v}</span>`).join(' ');
  const retries = (r.steps || []).reduce((n, s) => n + (s.retries || 0), 0);
  const imgs = (r.steps || []).flatMap(s => (s.artifacts || []).filter(a => a.endsWith('.png')));
  const thumbs = imgs.slice(0, 3).map(a => `<img src="${r.runId}/artifacts/${a}" class="thumb" onclick="event.stopPropagation();this.classList.toggle('big')">`).join('');
  const resumed = r.resumedFrom ? ' <span class="badge">↩</span>' : '';
  // Step detail rows
  const stepRows = (r.steps || []).map(s => {
    const si = s.status === 'passed' ? '<span class="st-passed">✓</span>' : '<span class="st-failed">✗</span>';
    const dur = s.endMs && s.startMs ? ((s.endMs - s.startMs) / 1000).toFixed(1) + 's' : '-';
    const sImgs = (s.artifacts || []).filter(a => a.endsWith('.png')).map(a => `<img src="${r.runId}/artifacts/${a}" class="step-thumb" onclick="event.stopPropagation();this.classList.toggle('big')">`).join('');
    const fail = s.failureTag ? `<span class="tag">${s.failureTag}</span> ${s.failureMsg || ''}` : '';
    return `<tr class="detail d${ri}"><td></td><td colspan="4">${si} ${s.action}${s.retries ? ` <span class="badge">${s.retries}r</span>` : ''}</td><td>${dur}</td><td colspan="2">${fail}</td><td>${sImgs}</td></tr>`;
  }).join('\n');
  return `<tr class="${r.status} clickable" data-p="${r.platform}" onclick="toggle(${ri})">
<td class="st-${r.status}">${icon(r.status)}</td>
<td><code>${r.runId}</code>${resumed}</td>
<td><span class="plat" style="color:${pColor(r.platform)}">${r.platform}</span></td>
<td>${r.name}</td>
<td>${sum.passed}/${sum.total}</td>
<td>${ms(sum.totalMs)}</td>
<td>${retries || '-'}</td>
<td>${tags || '-'}</td>
<td class="td-thumb">${thumbs}</td></tr>\n${stepRows}`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-control · Runs</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0b;--bg2:#111113;--bg3:#1a1a1e;--border:#2a2a2e;--text:#e8e8ec;--text2:#8888a0;--accent:#6ee7b7;--mono:'JetBrains Mono',monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:var(--mono);font-size:13px;line-height:1.6;padding:32px 24px}
body::after{content:'';position:fixed;inset:0;background:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");pointer-events:none;z-index:9999}
.page{max-width:1100px;margin:0 auto}
h1{font-size:20px;font-weight:600;color:var(--accent);margin-bottom:4px;letter-spacing:-.5px}
.sub{color:var(--text2);font-size:12px;margin-bottom:24px}
.stats{display:flex;gap:12px;margin-bottom:20px}
.stat{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 16px;flex:1}
.stat b{font-size:20px;display:block;color:var(--accent)}
.stat span{color:var(--text2);font-size:11px;text-transform:uppercase;letter-spacing:1px}
.filters{display:flex;gap:6px;margin-bottom:16px}
.filters button{padding:5px 12px;border:1px solid var(--border);border-radius:6px;font-size:11px;cursor:pointer;background:transparent;color:var(--text2);font-family:var(--mono);transition:.15s}
.filters button:hover{border-color:var(--accent);color:var(--text)}
.filters button.on{background:var(--bg3);border-color:var(--accent);color:var(--accent)}
.wrap{border:1px solid var(--border);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:separate;border-spacing:0}
th{background:var(--bg3);padding:12px 16px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:2px;color:var(--text2);font-weight:500}
td{padding:10px 16px;border-top:1px solid var(--border);font-size:12px;white-space:nowrap}
tr:hover td{background:rgba(110,231,183,.02)}
code{font-size:11px}
.st-passed{color:#6ee7b7;font-weight:600}
.st-failed{color:#f87171;font-weight:600}
.plat{font-weight:500;font-size:11px}
.tag{background:var(--bg3);padding:1px 6px;border-radius:4px;font-size:10px;color:var(--text2)}
.badge{color:var(--accent);font-size:10px}
.td-thumb{padding:6px 16px}
.thumb{height:32px;border-radius:4px;cursor:pointer;margin-right:3px;transition:.2s;opacity:.7}
.thumb:hover{opacity:1}
.thumb.big{height:160px;opacity:1}
.clickable{cursor:pointer}
.clickable:hover td{background:rgba(110,231,183,.04)}
.detail{display:none}
.detail td{background:var(--bg2);font-size:11px;padding:6px 16px;border-top:1px solid rgba(42,42,46,.5)}
.step-thumb{height:24px;border-radius:3px;cursor:pointer;margin-right:3px;opacity:.7}
.step-thumb.big{height:140px;opacity:1}
</style></head><body>
<div class="page">
<h1>agent-control</h1>
<p class="sub">Run Records · ${records.length} runs</p>
<div class="stats">
<div class="stat"><b>${records.length}</b><span>Total</span></div>
<div class="stat"><b style="color:#6ee7b7">${passed}</b><span>Passed</span></div>
<div class="stat"><b style="color:#f87171">${records.length - passed}</b><span>Failed</span></div>
<div class="stat"><b>${platforms.length}</b><span>Platforms</span></div>
</div>
<div class="filters">
<button class="on" onclick="f('all',this)">all</button>
${platforms.map(p => `<button onclick="f('${p}',this)" style="color:${pColor(p)}">${p}</button>`).join('')}
<button onclick="f('passed',this)">✓ passed</button>
<button onclick="f('failed',this)">✗ failed</button>
</div>
<div class="wrap"><table>
<thead><tr><th></th><th>Run</th><th>Platform</th><th>Flow</th><th>Steps</th><th>Time</th><th>Retries</th><th>Failures</th><th>Screenshots</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</div>
<script>
function f(v,btn){
  document.querySelectorAll('.filters button').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  document.querySelectorAll('tbody tr').forEach(r=>{
    if(r.classList.contains('detail')){r.style.display='none';return;}
    r.style.display=(v==='all'||r.classList.contains(v)||r.dataset.p===v)?'':'none';
  });
}
function toggle(i){
  document.querySelectorAll('.d'+i).forEach(r=>r.style.display=r.style.display==='table-row'?'none':'table-row');
}
</script></body></html>`;

fs.writeFileSync(path.join(RUNS, 'index.html'), html);
console.log(`Written: runs/index.html (${records.length} runs)`);
