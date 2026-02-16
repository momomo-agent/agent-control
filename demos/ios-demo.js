#!/usr/bin/env node
/**
 * iOS demo — 在模拟器上操作并截图，输出 history.json
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = '/tmp/agent-control';
const HISTORY = path.join(DIR, 'history.json');
const UDID = '997EF5B7-39F7-4686-A6FA-ADFAC7347F1E';
fs.mkdirSync(DIR, { recursive: true });

const history = [];
function addStep(s) { history.push(s); fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2)); }

function screenshot() {
  const p = path.join(DIR, `step-${Date.now()}.png`);
  execSync(`xcrun simctl io ${UDID} screenshot "${p}" 2>/dev/null`);
  return p;
}

function snapshot() {
  try {
    const raw = execSync(`idb ui describe-all --udid ${UDID} 2>/dev/null`, { encoding: 'utf8' });
    const data = JSON.parse(raw);
    const els = data.filter(d => d.AXLabel || d.role === 'AXButton').map((d, i) => ({
      ref: `@e${i + 1}`,
      role: d.role?.replace('AX', '') || '?',
      label: d.AXLabel || '',
      frame: d.frame,
    }));
    return {
      count: els.length,
      elements: els,
      summary: els.map(e => `${e.ref} ${e.role} "${e.label}"`).join('\n'),
      semantic: `${els.length} elements. ` + els.filter(e => e.label).map(e => `"${e.label}"`).slice(0, 8).join(', '),
    };
  } catch { return { count: 0, elements: [], summary: '', semantic: 'No elements' }; }
}

function tap(x, y) {
  execSync(`idb ui tap ${x} ${y} --udid ${UDID} 2>/dev/null`);
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

(async () => {
  // Step 1: Observe current state
  console.log('Step 1: Observe lock screen...');
  const ss1 = screenshot();
  const tree1 = snapshot();
  addStep({
    type: 'observe', platform: 'ios', timestamp: new Date().toISOString(),
    goal: '在 iOS 模拟器上从锁屏进入日历 app',
    note: '当前是锁屏界面，可以看到日期、小组件和 app 快捷方式（照片、提醒事项、News、地图等）',
    screenshot: ss1, elementCount: tree1.count, elements: tree1.summary, semantic: tree1.semantic,
  });
  console.log(`  ✅ ${tree1.count} elements`);

  // Step 2: Tap on a widget to enter app
  console.log('Step 2: Tap calendar widget...');
  const beforeSS2 = screenshot();
  const beforeTree2 = snapshot();
  // Tap the date/calendar area at top
  tap(200, 200);
  sleep(2000);
  const afterSS2 = screenshot();
  const afterTree2 = snapshot();
  addStep({
    type: 'act-observe', platform: 'ios', timestamp: new Date().toISOString(),
    goal: '在 iOS 模拟器上从锁屏进入日历 app',
    action: 'tap 日期区域',
    note: '点击锁屏顶部的日期区域，尝试进入日历或通知中心',
    result: { ok: true, action: 'tap', x: 200, y: 200 },
    before: { screenshot: beforeSS2, elementCount: beforeTree2.count, elements: beforeTree2.summary, semantic: beforeTree2.semantic },
    after: { screenshot: afterSS2, elementCount: afterTree2.count, elements: afterTree2.summary, semantic: afterTree2.semantic },
    diff: afterTree2.count !== beforeTree2.count ? `元素数从 ${beforeTree2.count} 变为 ${afterTree2.count}` : 'UI unchanged',
  });
  console.log(`  ✅ before: ${beforeTree2.count} → after: ${afterTree2.count}`);

  // Step 3: Handle permission dialog if present
  const tree3 = snapshot();
  const hasDialog = tree3.elements.some(e => e.label.includes('允许') || e.label.includes('不允许'));
  if (hasDialog) {
    console.log('Step 3: Handle permission dialog...');
    const beforeSS3 = screenshot();
    // Find "使用App时允许" or "允许" button
    const allowBtn = tree3.elements.find(e => e.label === '使用App时允许' || e.label === '允许');
    if (allowBtn && allowBtn.frame) {
      const cx = allowBtn.frame.x + allowBtn.frame.width / 2;
      const cy = allowBtn.frame.y + allowBtn.frame.height / 2;
      tap(Math.round(cx), Math.round(cy));
      sleep(1500);
    }
    const afterSS3 = screenshot();
    const afterTree3 = snapshot();
    addStep({
      type: 'act-observe', platform: 'ios', timestamp: new Date().toISOString(),
      action: `tap "${allowBtn?.label || '允许'}"`,
      note: `系统弹出权限请求弹窗，点击"${allowBtn?.label || '允许'}"授权`,
      result: { ok: true, action: 'tap', label: allowBtn?.label },
      before: { screenshot: beforeSS3, elementCount: tree3.count, elements: tree3.summary, semantic: tree3.semantic },
      after: { screenshot: afterSS3, elementCount: afterTree3.count, elements: afterTree3.summary, semantic: afterTree3.semantic },
      diff: `权限弹窗消失`,
    });
    console.log(`  ✅ handled dialog`);

    // Check for second dialog
    const tree3b = snapshot();
    const hasDialog2 = tree3b.elements.some(e => e.label.includes('允许') || e.label.includes('不允许'));
    if (hasDialog2) {
      console.log('Step 3b: Handle second permission dialog...');
      const beforeSS3b = screenshot();
      const allowBtn2 = tree3b.elements.find(e => e.label === '允许');
      if (allowBtn2 && allowBtn2.frame) {
        tap(Math.round(allowBtn2.frame.x + allowBtn2.frame.width / 2), Math.round(allowBtn2.frame.y + allowBtn2.frame.height / 2));
        sleep(1500);
      }
      const afterSS3b = screenshot();
      const afterTree3b = snapshot();
      addStep({
        type: 'act-observe', platform: 'ios', timestamp: new Date().toISOString(),
        action: 'tap "允许"',
        note: '第二个权限弹窗（通知权限），点击允许',
        result: { ok: true, action: 'tap', label: '允许' },
        before: { screenshot: beforeSS3b, elementCount: tree3b.count, elements: tree3b.summary, semantic: tree3b.semantic },
        after: { screenshot: afterSS3b, elementCount: afterTree3b.count, elements: afterTree3b.summary, semantic: afterTree3b.semantic },
        diff: '通知权限弹窗消失',
      });
      console.log(`  ✅ handled second dialog`);
    }
  }

  // Final observe
  console.log('Final: Observe current state...');
  const ssF = screenshot();
  const treeF = snapshot();
  addStep({
    type: 'observe', platform: 'ios', timestamp: new Date().toISOString(),
    note: '所有弹窗处理完毕，当前界面状态',
    screenshot: ssF, elementCount: treeF.count, elements: treeF.summary, semantic: treeF.semantic,
  });
  console.log(`  ✅ ${treeF.count} elements`);

  console.log(`\nDone! ${history.length} steps recorded.`);
})();
