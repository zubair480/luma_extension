/**
 * Form field scanner — FormPilot-inspired label extraction for Luma registration modals.
 * Finds every fillable control with a stable ref (data-luma-fid).
 */

let _fidCounter = 0;

function nextFieldId() {
  _fidCounter += 1;
  return `lf${_fidCounter}`;
}

function ensureFieldId(el) {
  if (!el) return null;
  if (!el.getAttribute("data-luma-fid")) {
    el.setAttribute("data-luma-fid", nextFieldId());
  }
  return el.getAttribute("data-luma-fid");
}

function extractFieldLabel(el, doc = document) {
  if (!el) return "";

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.length > 2) return cleanLabel(ariaLabel);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (parts.length) return cleanLabel(parts.join(" "));
  }

  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${safeCssEscape(id)}"]`);
    if (label) return cleanLabel(label.textContent);
  }

  const wrapLabel = el.closest("label");
  if (wrapLabel && wrapLabel !== el) {
    const clone = wrapLabel.cloneNode(true);
    for (const n of clone.querySelectorAll("input, textarea, select, button")) n.remove();
    const t = cleanLabel(clone.textContent);
    if (t.length > 2) return t;
  }

  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.length > 2) return cleanLabel(placeholder);

  const q = getQuestionTextForElement(el, doc);
  if (q) return q;

  return getFieldLabel(el, doc);
}

function radioGroupChecked(el) {
  if (!el) return false;
  if (el.checked) return true;
  const name = el.getAttribute("name");
  if (!name) return el.checked;
  const scope = el.closest("form") || document;
  for (const r of scope.querySelectorAll(`input[type="radio"][name="${safeCssEscape(name)}"]`)) {
    if (r.checked) return true;
  }
  return false;
}

function radioOptionText(radio, doc = document) {
  const forLabel = radio.id ? doc.querySelector(`label[for="${safeCssEscape(radio.id)}"]`) : null;
  const wrap = radio.closest("label");
  const raw =
    forLabel?.textContent ||
    (wrap && wrap !== radio ? wrap.textContent : "") ||
    radio.getAttribute("aria-label") ||
    radio.value ||
    "";
  return cleanLabel(raw);
}

/** Group visible radios by name (or question) into one selectable field each. */
function collectRadioGroups(root, doc = document) {
  const groups = new Map();
  for (const radio of root.querySelectorAll('input[type="radio"]')) {
    if (!isVisible(radio)) continue;
    const key = radio.getAttribute("name") || getQuestionTextForElement(radio, doc) || "radio";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(radio);
  }

  const specs = [];
  for (const radios of groups.values()) {
    if (!radios.length) continue;
    const anchor = radios[0];
    const label = getQuestionTextForElement(anchor, doc) || getFieldLabel(anchor, doc);
    const options = radios
      .map((r) => ({ el: r, text: radioOptionText(r, doc) }))
      .filter((o) => o.text && o.text.length >= 1);
    if (!options.length) continue;
    specs.push({ el: anchor, kind: "radio", multi: false, radios: options, label });
  }
  return specs;
}

function fieldHasValue(el, kind) {
  if (!el) return true;
  if (kind === "checkbox") return el.checked;
  if (kind === "radio") return radioGroupChecked(el);
  if (kind === "select") {
    const opt = el.options?.[el.selectedIndex];
    return Boolean(el.value?.trim() && opt && !isPlaceholderOption(opt.text));
  }
  if (kind === "custom-select") {
    const t = (el.textContent || el.value || "").trim();
    return t && !isDropdownTriggerText(t) && !isPlaceholderOption(t);
  }
  if (kind === "multi-select") {
    return multiSelectHasSelection(el);
  }
  return Boolean((el.value || "").trim());
}

function detectCustomSelectTrigger(el, doc) {
  if (!el || !isVisible(el)) return null;
  if (!isInRegistrationField(el, doc)) return null;
  if (looksLikeDropdownTrigger(el, doc)) return el;
  return null;
}

function scanRegistrationFields(doc = document) {
  const root = getRegistrationModalRoot(doc) || getFormRoot(doc);
  if (!root) return [];

  // Never reset the counter: ids must stay unique across re-scans of the same form, because a
  // field that appears on a later round would otherwise reuse an id already held by another
  // element (and inherit its queued answer).
  const fields = [];
  const seen = new Set();

  const pushField = (spec) => {
    if (!spec.el || seen.has(spec.el)) return;
    seen.add(spec.el);
    ensureFieldId(spec.el);
    const label = spec.label || extractFieldLabel(spec.el, doc);
    fields.push({
      ...spec,
      fid: spec.el.getAttribute("data-luma-fid"),
      label,
      attrType: spec.kind === "text" || spec.kind === "textarea" ? classifyByInputAttributes(spec.el, label) : null,
      filled: fieldHasValue(spec.el, spec.kind),
    });
  };

  for (const el of root.querySelectorAll("input, textarea, select")) {
    if (!isVisible(el)) continue;
    const type = (el.getAttribute("type") || "text").toLowerCase();

    if (type === "hidden" || type === "submit" || type === "button" || type === "file") continue;

    if (type === "checkbox") {
      pushField({ el, kind: "checkbox", multi: false });
      continue;
    }
    if (type === "radio") continue;

    if (el.tagName === "SELECT") {
      pushField({ el, kind: "select" });
      continue;
    }

    // Search boxes and read-only triggers inside custom dropdowns are not text fields. They are
    // handled by the dropdown pass below; typing a profile answer into them was the main source
    // of wrong values in option fields.
    if (isCustomSelectInput(el)) continue;

    pushField({
      el,
      kind: el.tagName === "TEXTAREA" ? "textarea" : "text",
    });
  }

  for (const spec of collectRadioGroups(root, doc)) {
    pushField(spec);
  }

  for (const trigger of findCustomDropdownTriggers(doc)) {
    const label = getQuestionTextForElement(trigger, doc);
    if (isEventBodyCopy(label)) continue;
    const multi = isMultiSelectLabel(label) || isMultiSelectLabel(trigger.textContent);
    pushField({
      el: resolveDropdownActivator(trigger),
      kind: multi ? "multi-select" : "custom-select",
      multi,
      trigger,
      nativeSelect: findNativeSelectForTrigger(trigger, doc),
    });
  }

  return fields.filter((f) => f.label && f.label.length >= 3);
}

function getFieldByFid(fid, doc = document) {
  return doc.querySelector(`[data-luma-fid="${safeCssEscape(fid)}"]`);
}

function summarizeScan(fields) {
  const pending = fields.filter((f) => !f.filled);
  return {
    total: fields.length,
    pending: pending.length,
    labels: pending.slice(0, 8).map((f) => f.label.slice(0, 50)),
  };
}
