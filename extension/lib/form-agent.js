/**
 * AI form agent — scans the registration modal, resolves values (rules + LLM),
 * and fills fields uniformly. Inspired by FormPilot's scan-then-fill pipeline.
 */

async function requestFieldAnswer(question, profile, eventTitle, fieldType, qType) {
  const response = await sendMessageWithAbort({
    type: "ANSWER_QUESTION",
    question,
    profile,
    eventTitle,
    fieldType,
    qType,
  });
  return response?.answer || null;
}

/** Ask the model to choose one option (by number) from a fixed list. Returns the chosen text or null. */
async function requestOptionChoice(question, optionTexts, profile, eventTitle) {
  if (!optionTexts?.length) return null;
  const response = await sendMessageWithAbort({
    type: "ANSWER_QUESTION",
    question,
    profile,
    eventTitle,
    fieldType: "select",
    qType: "__option_select__",
    options: optionTexts,
  });
  return response?.answer || null;
}

/**
 * Pick one option: confident keyword rule → LLM-constrained choice → deterministic fallback.
 * The LLM is only consulted when rules don't confidently match, and its reply is validated
 * back against the real options, so it can never invent an answer.
 */
async function chooseOptionSmart(options, label, profile, eventTitle, log) {
  if (!options?.length) return null;

  const confident = pickConfidentOption(options, label, profile);
  if (confident) return confident;

  const choice = await requestOptionChoice(label, options.map((o) => o.text), profile, eventTitle);
  if (choice) {
    const lc = choice.toLowerCase();
    const matched =
      options.find((o) => o.text.toLowerCase() === lc) ||
      options.find((o) => o.text.toLowerCase().includes(lc) || lc.includes(o.text.toLowerCase()));
    if (matched) {
      if (typeof log === "function") {
        log("fill", `AI chose "${trimStatus(matched.text, 36)}" for "${trimStatus(label, 40)}"`, "info");
      }
      return matched;
    }
  }

  return pickBestSelectOption(options, label, profile) || options[0] || null;
}

async function ensureDropdownOpen(activator, label, log) {
  if (dropdownHasVisibleOptions(activator, label)) return true;
  await openDropdownRobust(activator, log);
  await runAwareSleep(350);
  return dropdownHasVisibleOptions(activator, label);
}

async function clickOptionByText(text, activator, label, log) {
  await ensureDropdownOpen(activator, label, log);
  await runAwareSleep(200);

  const el = resolveOptionElement(text, activator, label);
  if (!el) {
    log("fill", `Option not found in DOM: "${trimStatus(text, 36)}"`, "warn");
    return false;
  }

  setAgentStatus(`Selecting: ${trimStatus(text, 36)}`);
  simulatePointerClick(el);
  await runAwareSleep(220);
  return true;
}

async function closeDropdown(activator, log) {
  const confirm = findClickable(["done", "apply", "confirm", "ok"]);
  if (confirm) {
    await agentClick(confirm, "Confirm selection…", log, "fill", { quick: true });
    await runAwareSleep(200);
    return;
  }
  if (isDropdownOverlayOpen()) {
    activator.focus?.();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await runAwareSleep(150);
  }
}

async function fillMultiSelectSequential(activator, label, profile, log) {
  const beforeSnap = snapshotInteractiveTexts();
  await ensureDropdownOpen(activator, label, log);
  await runAwareSleep(400);

  let options = collectDropdownOptions(activator, document, beforeSnap);
  if (!options.length) {
    options = collectFloatingListOptions(activator, document, label);
  }
  if (!options.length) {
    log("fill", "No options visible for multi-select", "warn", {
      discovery: describeDropdownDiscovery(activator),
    });
    return [];
  }

  const picks = pickMultipleSelectOptions(options, label, profile, 3);
  const texts = picks.length ? picks.map((p) => p.text) : [options[0].text];
  const answers = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    log("fill", `Multi-select ${i + 1}/${texts.length}: ${trimStatus(text, 40)}`, "info");

    if (i > 0 && !dropdownHasVisibleOptions(activator, label)) {
      log("fill", "Re-opening dropdown for next option…", "info");
      await openDropdownRobust(activator, log);
      await runAwareSleep(400);
    }

    const clicked = await clickOptionByText(text, activator, label, log);
    if (clicked) {
      answers.push(text);
    }

    await runAwareSleep(280);
  }

  await closeDropdown(activator, log);
  return answers;
}

async function openDropdownRobust(activator, log) {
  const input = findComboboxInput(activator);
  const clickTargets = [...new Set([input, activator, activator.parentElement, activator.closest("button")].filter(Boolean))];

  for (const target of clickTargets) {
    target.scrollIntoView({ block: "nearest" });
    target.focus?.();
    await runAwareSleep(80);
    simulatePointerClick(target);
    await runAwareSleep(350);

    if (dropdownHasVisibleOptions(activator, "")) return true;
    if (activator.getAttribute("aria-expanded") === "true") return true;
  }

  const focusEl = input || activator;
  focusEl.focus?.();
  for (const key of ["ArrowDown", " "]) {
    focusEl.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, code: key, keyCode: key === " " ? 32 : 40 })
    );
    await runAwareSleep(200);
    if (dropdownHasVisibleOptions(activator, "")) return true;
  }

  return false;
}

async function fillNativeSelectMulti(select, label, profile, log) {
  const options = [...select.options].map((o) => ({
    el: o,
    text: o.textContent.trim(),
    value: o.value,
  }));
  const picks = pickMultipleSelectOptions(options, label, profile, select.multiple ? 3 : 1);
  if (!picks.length) return null;

  if (select.multiple) {
    for (const opt of select.options) {
      opt.selected = picks.some((p) => p.value === opt.value);
    }
  } else if (picks[0]) {
    select.value = picks[0].value;
  }
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  const answer = picks.map((p) => p.text).join(", ");
  log("fill", `Native select: ${answer}`, "info");
  return { question: label, answer };
}

async function fillMultiSelectKeyboard(activator, label, profile, multi, log) {
  const input = findComboboxInput(activator) || activator;
  await ensureDropdownOpen(activator, label, log);
  input.focus?.();
  await runAwareSleep(150);

  const prefs = profileCategoryPrefs(profile);
  const picked = [];
  const pickedTexts = new Set();
  const maxPicks = multi ? 2 : 1;

  for (let step = 0; step < 18; step++) {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, keyCode: 40, code: "ArrowDown" })
    );
    await runAwareSleep(100);

    const activeId = input.getAttribute("aria-activedescendant");
    let activeEl = activeId ? document.getElementById(activeId) : null;
    if (!activeEl) {
      activeEl = document.querySelector(
        '[data-highlighted], [aria-selected="true"], [data-state="checked"], [data-active-item]'
      );
    }
    if (!activeEl || activeEl === input) activeEl = document.activeElement;
    if (!activeEl || activeEl === input) continue;

    if (typeof setCursorPosition === "function" && typeof elementCenter === "function") {
      const { x, y, rect } = elementCenter(activeEl);
      if (rect.width > 0 || rect.height > 0) setCursorPosition(x, y);
    }

    const text = cleanLabel(activeEl.getAttribute("aria-label") || activeEl.textContent);
    if (!isLikelySelectOptionText(text, label)) continue;

    for (const pref of prefs) {
      if (!text.toLowerCase().includes(pref) || pickedTexts.has(text.toLowerCase())) continue;

      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, code: "Space", keyCode: 32 })
      );
      await runAwareSleep(150);

      picked.push(text);
      pickedTexts.add(text.toLowerCase());
      log("fill", `Keyboard selected: ${trimStatus(text, 36)}`, "info");
      break;
    }

    if (picked.length >= maxPicks) break;
  }

  await closeDropdown(activator, log);
  return picked;
}

async function fillTextFieldAgent(field, profile, eventTitle, log) {
  const label = field.label;
  const qType = classifyQuestion(label);
  let value = answerForQuestion(label, profile);

  if (!value && (needsSmartAnswer(qType, label) || qType === "custom")) {
    value = await requestFieldAnswer(
      label,
      profile,
      eventTitle,
      field.kind === "textarea" ? "textarea" : "text",
      qType
    );
  }

  if (!value) return null;

  await setNativeValueVisual(field.el, value, label);
  return { question: label, answer: value, fromLlm: qType === "custom" };
}

async function fillSelectFieldAgent(field, profile, eventTitle, log) {
  const label = field.label;
  const options = [...field.el.options].map((o) => ({
    el: o,
    text: o.textContent.trim(),
    value: o.value,
  }));

  const pick = await chooseOptionSmart(options, label, profile, eventTitle, log);
  if (!pick) return null;

  field.el.value = pick.value;
  field.el.dispatchEvent(new Event("change", { bubbles: true }));
  log("fill", `Agent select: ${trimStatus(pick.text, 40)}`, "info");
  return { question: label, answer: pick.text };
}

async function fillRadioAgent(field, profile, eventTitle, log) {
  const radios = field.radios || [];
  if (!radios.length) return null;
  if (radios.some((r) => r.el.checked)) return null;

  const options = radios.map((r) => ({ el: r.el, text: r.text, value: r.el.value }));
  const label = field.label;
  const pick = await chooseOptionSmart(options, label, profile, eventTitle, log);
  if (!pick) return null;

  const clickTarget =
    pick.el.closest("label") ||
    (pick.el.id ? document.querySelector(`label[for="${safeCssEscape(pick.el.id)}"]`) : null) ||
    pick.el;

  setAgentStatus(`Selecting: ${trimStatus(pick.text, 36)}`);
  await agentClick(clickTarget, `Choosing: ${trimStatus(pick.text, 32)}`, log, "fill");
  if (!pick.el.checked) {
    pick.el.checked = true;
    pick.el.dispatchEvent(new Event("click", { bubbles: true }));
    pick.el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await runAwareSleep(200);
  log("fill", `Radio: ${trimStatus(pick.text, 40)}`, "info");
  return { question: label, answer: pick.text };
}

async function fillCheckboxAgent(field, profile, log) {
  if (field.el.checked) return null;
  const label = field.label.toLowerCase();
  // Only accept what's required to register. Leave optional data-sharing / marketing /
  // photo / recording boxes unchecked.
  const isRequiredConsent =
    /terms|conditions|code of conduct|rules|liability|waiver|privacy policy|\bpolicy\b|agree|accept|consent/i.test(label);
  const isOptional =
    /third.?part|sponsor|\bshare\b|data.?shar|marketing|newsletter|promo|updates|subscribe|photo|recording|opt.?in|contact info/i.test(label);
  if (!isRequiredConsent || isOptional) {
    if (isOptional) log("fill", `Left optional consent unchecked: ${trimStatus(field.label, 60)}`, "info");
    return null;
  }

  await agentClick(field.el, "Accepting terms…", log, "fill");
  field.el.checked = true;
  field.el.dispatchEvent(new Event("change", { bubbles: true }));
  return { question: field.label, answer: "checked" };
}

async function fillCustomSelectAgent(field, profile, eventTitle, log) {
  const activator = field.el;
  const label = field.label;
  const multi = field.multi;

  if (multiSelectHasSelection(activator)) {
    log("fill", `Multi-select already has selection for "${trimStatus(label, 40)}"`, "info");
    return null;
  }

  const nativeSelect = field.nativeSelect || findNativeSelectForTrigger(activator);
  if (nativeSelect) {
    const result = await fillNativeSelectMulti(nativeSelect, label, profile, log);
    if (result) return result;
  }

  let answers = [];

  if (multi) {
    answers = await fillMultiSelectSequential(activator, label, profile, log);
  } else {
    await ensureDropdownOpen(activator, label, log);
    await runAwareSleep(400);
    const options = collectDropdownOptions(activator, document, snapshotInteractiveTexts());
    const pick = await chooseOptionSmart(options, label, profile, eventTitle, log);
    if (pick) {
      await clickOptionByText(pick.text, activator, label, log);
      answers = [pick.text];
      await closeDropdown(activator, log);
    }
  }

  if (!answers.length) {
    log("fill", `Trying keyboard fallback for "${trimStatus(label, 40)}"`, "warn");
    answers = await fillMultiSelectKeyboard(activator, label, profile, multi, log);
  }

  if (!answers.length) {
    log("fill", `Agent: no options for "${trimStatus(label, 40)}" (${describeDropdownDiscovery(activator)})`, "warn");
    return null;
  }

  log("fill", `Agent picked: ${answers.join(", ")}`, "info");
  return { question: label, answer: answers.join(", ") };
}

async function fillOneFieldAgent(field, profile, eventTitle, log) {
  if (field.filled || fieldHasValue(field.el, field.kind)) return null;

  switch (field.kind) {
    case "text":
    case "textarea":
      return fillTextFieldAgent(field, profile, eventTitle, log);
    case "select":
      return fillSelectFieldAgent(field, profile, eventTitle, log);
    case "radio":
      return fillRadioAgent(field, profile, eventTitle, log);
    case "checkbox":
      return fillCheckboxAgent(field, profile, log);
    case "custom-select":
    case "multi-select":
      return fillCustomSelectAgent(field, profile, eventTitle, log);
    default:
      return null;
  }
}

/**
 * Primary fill pipeline: scan → fill each pending field → re-scan until stable.
 */
async function runFormAgent(profile, eventTitle, log = () => {}) {
  const answers = [];
  let filledCount = 0;

  for (let round = 0; round < 4; round++) {
    await throwIfAborted();
    const fields = scanRegistrationFields();
    const summary = summarizeScan(fields);
    log("fill", `Agent scan: ${summary.pending}/${summary.total} pending`, "info", summary);

    if (!summary.pending) break;

    for (const field of fields.filter((f) => !f.filled && !fieldHasValue(f.el, f.kind))) {
      await throwIfAborted();
      const result = await fillOneFieldAgent(field, profile, eventTitle, log);
      if (result) {
        answers.push(result);
        filledCount += 1;
      } else if (field.kind === "multi-select" && multiSelectHasSelection(field.el)) {
        log("fill", `Multi-select satisfied: ${trimStatus(field.label, 40)}`, "info");
        filledCount += 1;
      }
      await runAwareSleep(200);
    }

    await runAwareSleep(300);
  }

  await fillConsentCheckboxes(log);
  clearHighlight();
  return { filled: filledCount, newAnswers: answers };
}
