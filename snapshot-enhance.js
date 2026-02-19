/**
 * snapshot-enhance.js — Unified snapshot enhancement for all platforms
 * 
 * Takes raw snapshot elements, returns agent-friendly output:
 * - Filters to interactive elements only
 * - Adds semantic page summary
 * - Compact text format for LLM consumption
 */

// Interactive roles/tags
const INTERACTIVE_ROLES = new Set([
  'Button', 'TextField', 'TextArea', 'CheckBox', 'RadioButton', 'ComboBox',
  'PopUpButton', 'Slider', 'Link', 'Tab', 'MenuItem', 'Switch', 'Stepper',
  'DisclosureTriangle', 'IncrementArrow', 'DecrementArrow',
  // Web
  'button', 'input', 'select', 'textarea', 'a', 'option',
  'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'link', 'menuitem',
]);

const INTERACTIVE_TAGS = new Set([
  'button', 'input', 'select', 'textarea', 'a', 'label',
]);

function isInteractive(el) {
  if (el.interactive === true) return true;
  if (INTERACTIVE_ROLES.has(el.role)) return true;
  if (INTERACTIVE_TAGS.has(el.tag)) return true;
  // Web: check for clickable attributes
  if (el.tag && (el.role === 'button' || el.role === 'link')) return true;
  return false;
}

const SIM_CHROME = new Set([
  'Action','Volume Up','Volume Down','Sleep/Wake','Ring/Silent','Home','Save Screen','Rotate',
]);

function enhance(elements, opts = {}) {
  const all = Array.isArray(elements) ? elements : Object.values(elements);
  let filtered = all.filter(isInteractive);
  // Strip Simulator chrome for iOS
  if (opts.platform === 'ios') {
    filtered = filtered.filter(e => !SIM_CHROME.has(e.label));
  }
  // Strip empty-label elements
  filtered = filtered.filter(e => e.label || e.value || e.tag);

  const interactive = filtered;
  // Compact text format: one line per element
  const lines = interactive.map(el => {
    const parts = [el.ref];
    // Prefer semantic role name
    const role = (el.tag === 'button' || el.tag === 'input') ? (el.tag + (el.role && el.role !== el.tag ? `[${el.role}]` : '')) : (el.role || el.tag || '?');
    parts.push(role);
    if (el.label) parts.push(`"${el.label.replace(/\n/g, ' ').slice(0, 60)}"`);
    if (el.value && el.value !== el.label) parts.push(`val="${el.value.slice(0, 40)}"`);
    return parts.join(' ');
  });

  // Semantic summary
  const roles = {};
  interactive.forEach(e => { const r = e.role || e.tag; roles[r] = (roles[r] || 0) + 1; });
  const roleSummary = Object.entries(roles).map(([r, c]) => `${c}×${r}`).join(', ');
  const named = interactive.filter(e => e.label || e.value).slice(0, 6);
  const keyItems = named.map(e => `"${(e.label || e.value || '').slice(0, 30)}"`).join(', ');

  return {
    total: all.length,
    interactive: interactive.length,
    summary: `${interactive.length} interactive elements (${roleSummary}). Key: ${keyItems}`,
    elements: interactive,
    text: lines.join('\n'),
  };
}

module.exports = { enhance, isInteractive };
