/**
 * snapshot-enhance.js — Unified snapshot enhancement for all platforms
 *
 * Outputs an indented accessibility tree (like agent-browser) when the data
 * is hierarchical, or a flat list when it's already flattened.
 */

// Interactive roles/tags — unified across all platforms
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

// Container roles worth showing in tree (even if not interactive)
const CONTAINER_ROLES = new Set([
  'Group', 'Window', 'Sheet', 'Dialog', 'Popover', 'Menu', 'MenuBar',
  'Toolbar', 'TabGroup', 'ScrollArea', 'SplitGroup', 'List', 'Table',
  'Outline', 'Browser', 'NavigationBar',
  // Web
  'navigation', 'main', 'header', 'footer', 'section', 'form', 'dialog',
  'nav', 'aside', 'article',
]);

const SIM_CHROME = new Set([
  'Action','Volume Up','Volume Down','Sleep/Wake','Ring/Silent','Home','Save Screen','Rotate',
]);

function isInteractive(el, opts) {
  if (el.interactive === true) return true;
  if (el.clickable === true) return true;
  if (INTERACTIVE_ROLES.has(el.role)) return true;
  if (INTERACTIVE_TAGS.has(el.tag)) return true;
  if (el.tag && (el.role === 'button' || el.role === 'link')) return true;
  if (opts?.platform === 'android' && (el.text || el.label)) return true;
  return false;
}

function isContainer(el) {
  return CONTAINER_ROLES.has(el.role) || CONTAINER_ROLES.has(el.tag);
}

function isMeaningful(el, opts) {
  if (isInteractive(el, opts)) return true;
  if (isContainer(el) && (el.label || el.title)) return true;
  if ((el.role === 'StaticText' || el.role === 'Heading' || /^h[1-6]$/.test(el.tag)) && (el.label || el.value || el.text)) return true;
  return false;
}

// Format a single element as a compact text token
function formatElement(el) {
  const role = (el.tag === 'button' || el.tag === 'input')
    ? (el.tag + (el.role && el.role !== el.tag ? `[${el.role}]` : ''))
    : (el.role || el.tag || '?');
  const lbl = el.label || el.text || '';
  const labelPart = lbl ? ` "${lbl.replace(/\n/g, ' ').slice(0, 60)}"` : '';
  const valPart = el.value && el.value !== lbl ? ` val="${el.value.slice(0, 40)}"` : '';
  const extras = [];
  if (el.placeholder) extras.push(`placeholder="${el.placeholder.slice(0, 40)}"`);
  if (el.type) extras.push(`type=${el.type}`);
  if (el.href) extras.push(`href="${el.href.slice(0, 60)}"`);
  if (el.disabled) extras.push('disabled');
  if (el.checked) extras.push('checked');
  if (el.selected) extras.push('selected');
  const extraPart = extras.length ? ' ' + extras.join(' ') : '';
  const refPart = el.ref ? ` [ref=${el.ref}]` : '';
  return `${role}${labelPart}${valPart}${extraPart}${refPart}`;
}

// Recursively build indented tree lines
function buildTree(elements, opts, depth = 0, lines = [], stats = { interactive: 0, total: 0 }) {
  const indent = '  '.repeat(depth);
  for (const el of elements) {
    stats.total++;
    const children = el.children || [];

    // Skip simulator chrome
    if (opts.platform === 'ios' && SIM_CHROME.has(el.label)) continue;

    const meaningful = isMeaningful(el, opts);
    const hasUsefulDescendants = children.some(c =>
      isMeaningful(c, opts) || (c.children && c.children.length > 0)
    );

    if (meaningful) {
      if (isInteractive(el, opts)) stats.interactive++;
      lines.push(`${indent}- ${formatElement(el)}`);
      if (children.length > 0) {
        buildTree(children, opts, depth + 1, lines, stats);
      }
    } else if (hasUsefulDescendants || (isContainer(el) && children.length > 0)) {
      // Show unlabeled container if it has useful children
      const role = el.role || el.tag || 'Group';
      const lbl = el.label || el.title || '';
      const labelPart = lbl ? ` "${lbl.slice(0, 40)}"` : '';
      lines.push(`${indent}- ${role}${labelPart}`);
      buildTree(children, opts, depth + 1, lines, stats);
    } else if (children.length > 0) {
      // Transparent pass-through: skip this node, recurse children at same depth
      buildTree(children, opts, depth, lines, stats);
    }
  }
  return { lines, stats };
}

// Flatten tree into array
function flattenTree(elements, result = []) {
  for (const el of elements) {
    result.push(el);
    if (el.children) flattenTree(el.children, result);
  }
  return result;
}

function enhance(elements, opts = {}) {
  const all = Array.isArray(elements) ? elements : Object.values(elements);

  // Detect if data is hierarchical (has children) or already flat
  const isTree = all.some(el => el.children && el.children.length > 0);

  if (isTree) {
    const { lines, stats } = buildTree(all, opts);

    // Summary
    const flat = flattenTree(all);
    const interactive = flat.filter(el => isInteractive(el, opts));
    if (opts.platform === 'ios') {
      // remove sim chrome from count
    }
    const roles = {};
    interactive.forEach(e => { const r = e.role || e.tag; roles[r] = (roles[r] || 0) + 1; });
    const roleSummary = Object.entries(roles).slice(0, 6).map(([r, c]) => `${c}\u00d7${r}`).join(', ');
    const named = interactive.filter(e => e.label || e.text).slice(0, 6);
    const keyItems = named.map(e => `"${(e.label || e.text || '').slice(0, 25)}"`).join(', ');
    const summary = `${stats.interactive} interactive elements (${roleSummary}). Key: ${keyItems}`;

    return {
      total: stats.total,
      interactive: stats.interactive,
      summary,
      elements: interactive,
      text: lines.join('\n'),
    };
  }

  // Flat mode (web driver, legacy)
  let filtered;
  if (opts.all) {
    filtered = all.filter(e => e.label || e.value || e.tag || e.text);
  } else {
    filtered = all.filter(el => isInteractive(el, opts));
  }
  if (opts.platform === 'ios') {
    filtered = filtered.filter(e => !SIM_CHROME.has(e.label));
  }
  filtered = filtered.filter(e => e.label || e.value || e.tag || e.text);

  const interactive = filtered;
  const lines = interactive.map(el => `- ${formatElement(el)}`);

  const roles = {};
  interactive.forEach(e => { const r = e.role || e.tag; roles[r] = (roles[r] || 0) + 1; });
  const roleSummary = Object.entries(roles).map(([r, c]) => `${c}\u00d7${r}`).join(', ');
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
