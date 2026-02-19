/**
 * retry.js — 失败分类 + 重试策略
 */

// 哪些 tag 可以重试，以及重试前的修复动作
const RETRY_POLICY = {
  TIMEOUT:      { retries: 2, delayMs: 2000, fix: 'wait' },
  NOT_READY:    { retries: 2, delayMs: 1000, fix: 'resnapshot' },
  NOT_FOUND:    { retries: 1, delayMs: 500,  fix: 'resnapshot' },
  FOCUS:        { retries: 1, delayMs: 500,  fix: 'refocus' },
  COORD_DRIFT:  { retries: 1, delayMs: 500,  fix: 'resnapshot' },
  DIALOG:       { retries: 1, delayMs: 1000, fix: 'dismiss' },
  // 不可重试
  PERMISSION:   null,
  ASSERT_FAIL:  { retries: 1, delayMs: 1000, fix: 'resnapshot' },
  DRIVER_ERROR: null,
  UNKNOWN:      null,
};

function canRetry(tag) {
  const p = RETRY_POLICY[tag];
  return p ? p.retries > 0 : false;
}

function getPolicy(tag) {
  return RETRY_POLICY[tag] || null;
}

module.exports = { RETRY_POLICY, canRetry, getPolicy };
