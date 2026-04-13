/**
 * snapshot-enhance.js — Unified snapshot enhancement for all platforms
 * 
 * Takes raw snapshot elements, returns agent-friendly output:
 * - Filters to interactive elements only
 * - Adds semantic page summary
 * - Compact text format for LLM consumption
 */

// Interactive roles/tags — unified across all platforms (see driver-interface.md §3)
const INTERACTIVE_ROLES = new Set([
  'Button', 'TextField', 'TextArea', 'CheckBox', 'RadioButton', 'ComboBox',
  'PopUpButton', 'Slider', 'Link', 'Tab', 'MenuItem', 'MenuBarItem', 'MenuButton',
  'Switch', 'Stepper', 'Incrementor', 'IncrementArrow', 'DecrementArrow',
  'DisclosureTriangle', 'ColorWell', 'SegmentedControl',
  'Cell', 'Row',
  // Web HTML tags
  'button', 'input', 'select', 'textarea', 'a', 'option', 'label',
  // Web ARIA roles
  'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'link', 'menuitem',
]);

const INTERACTIVE_TAGS = new Set([
  'button', 'input', 'select', 'textarea', 'a', 'label',
]);

function isInteractive(el, opts) {
  if (el.interactive === true) return true;
  if (el.clickable === true) return true; // Android
  if (INTERACTIVE_ROLES.has(el.role)) return true;
  if (INTERACTIVE_TAGS.has(el.tag)) return true;
  if (el.tag && (el.role === 'button' || el.role === 'link')) return true;
  // Android: text/label-bearing elements are useful even if not interactive
  if (opts?.platform === 'android' && (el.text || el.label)) return true;
  return false;
}

const SIM_CHROME = new Set([
  'Action','Volume Up','Volume Down','Sleep/Wake','Ring/Silent','Home','Save Screen','Rotate',
]);

function enhance(elements, opts = {}) {
  const all = Array.isArray(elements) ? elements : Object.values(elements);
  let filtered = all.filter(el => isInteractive(el, opts));
  // Strip Simulator chrome for iOS
  if (opts.platform === 'ios') {
    filtered = filtered.filter(e => !SIM_CHROME.has(e.label));
  }
  // Strip empty-label elements (Android uses 'text' instead of 'label')
  filtered = filtered.filter(e => e.label || e.value || e.tag || e.text);

  const interactive = filtered;
  
  // agent-browser style: hierarchical with [ref=e1]
  const lines = interactive.map(el => {
    const role = (el.tag === 'button' || el.tag === 'input') ? (el.tag + (el.role && el.role !== el.tag ? `[${el.role}]` : '')) : (el.role || el.tag || '?');
    const lbl = el.label || el.text || '';
    const labelPart = lbl ? ` "${lbl.replace(/\n/g, ' ').slice(0, 60)}"` : '';
    const valPart = el.value && el.value !== lbl ? ` val="${el.value.slice(0, 40)}"` : '';
    // Extra attributes — compact inline hints
    const extras = [];
    if (el.placeholder) extras.push(`placeholder="${el.placeholder.slice(0, 40)}"`);
    if (el.type) extras.push(`type=${el.type}`);
    if (el.accept) extras.push(`accept="${el.accept}"`);
    if (el.href) extras.push(`href="${el.href.slice(0, 60)}"`);
    if (el.disabled) extras.push('disabled');
    if (el.checked) extras.push('checked');
    if (el.selected) extras.push('selected');
    if (el.required) extras.push('required');
    if (el.readOnly) extras.push('readonly');
    if (el.title) extras.push(`title="${el.title.slice(0, 40)}"`);
    const extraPart = extras.length ? ' ' + extras.join(' ') : '';
    return `- ${role}${labelPart}${valPart}${extraPart} [ref=${el.ref}]`;
  });

  // Semantic summary
  const roles = {};
  interactive.forEach(e => { const r = e.role || e.tag; roles[r] = (roles[r] || 0) + 1; });
  const roleSummary = Object.entries(roles).map(([r, c]) => `${c}×${r}`).join(', ');
  const named = interactive.filter(e => e.label || e.text || e.value).slice(0, 6);
  const keyItems = named.map(e => `"${(e.label || e.text || e.value || '').slice(0, 30)}"`).join(', ');

  return {
    total: all.length,
    interactive: interactive.length,
    summary: `${interactive.length} interactive elements (${roleSummary}). Key: ${keyItems}`,
    elements: interactive,
    text: lines.join('\n'),
  };
}

module.exports = { enhance, isInteractive };
