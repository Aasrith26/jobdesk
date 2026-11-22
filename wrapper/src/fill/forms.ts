// In-page scripts: find the form's fields with their human labels, and set values the way a
// person typing would (native setters + input/change events, so React/Vue forms notice).
// The page's text never steers what the filler does - values come only from the answer bank
// and the application's own files.

export interface PageField {
  id: string
  /** The element's own HTML id, used to re-find it after a framework re-render drops our marker. */
  domId?: string
  tag: string
  type: string
  name: string
  label: string
  required: boolean
  visible: boolean
  options: string[]
  value: string
  checked?: boolean
  group?: string
}

export interface PageScan {
  url: string
  host: string
  fields: PageField[]
  captcha: boolean
  password: boolean
  submitLabel: string | null
  text: string
}

export const SCAN_SCRIPT = `(() => {
  const hiddenAncestor = el => { let p = el.parentElement; while (p && p !== document.body) { const ps = getComputedStyle(p); if (ps.display === 'none' || ps.visibility === 'hidden' || p.hidden) return true; p = p.parentElement } return false };
  // Real ATS forms hide the file input itself behind an "Attach" button: a file input counts as
  // visible when its surrounding field is visible, even if the input element is not.
  const vis = el => { if (el.type === 'file') return !hiddenAncestor(el); const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && !el.closest('[aria-hidden=true],[hidden]') };
  const questionOf = el => { const wrap = el.closest('fieldset, .application-question, .field, .form-group, .question, [class*=question], [role=radiogroup], [role=group]'); if (!wrap) return ''; if (wrap.tagName === 'FIELDSET' && wrap.querySelector('legend')) return clean(wrap.querySelector('legend').innerText); const t = wrap.querySelector('legend, .application-label, .text, [class*=label], label:not(:has(input))'); return t ? clean(t.innerText) : (wrap.getAttribute('aria-label') ? clean(wrap.getAttribute('aria-label')) : '') };
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  const labelFor = el => {
    if (el.labels && el.labels.length) return clean([...el.labels].map(l => l.innerText).join(' '));
    const al = el.getAttribute('aria-label'); if (al) return clean(al);
    const lb = el.getAttribute('aria-labelledby'); if (lb) return clean(lb.split(/\\s+/).map(i => (document.getElementById(i) || {}).innerText || '').join(' '));
    const fs = el.closest('fieldset'); if (fs && fs.querySelector('legend')) return clean(fs.querySelector('legend').innerText);
    const wrap = el.closest('.field, .application-question, .form-group, .question, li, [class*=field], [class*=question]');
    if (wrap) { const t = wrap.querySelector('label, .label, .text, .application-label, [class*=label]'); if (t) return clean(t.innerText); }
    return clean(el.getAttribute('placeholder') || el.name || el.id);
  };
  const els = [...document.querySelectorAll('input, textarea, select')].filter(e => !['hidden','submit','button','reset','image','search'].includes((e.type||'').toLowerCase()));
  let n = 0; const fields = []; const seenGroups = new Set();
  for (const el of els) {
    const type = (el.type || el.tagName).toLowerCase();
    if (type === 'radio') {
      const g = el.name || ('r' + n); if (seenGroups.has(g)) continue; seenGroups.add(g);
      const radios = [...document.querySelectorAll('input[type=radio]')].filter(r => r.name === el.name);
      radios.forEach(r => r.setAttribute('data-jd-group', g));
      const id = 'jd' + (n++); el.setAttribute('data-jd', id);
      const q = questionOf(el) || labelFor(el);
      fields.push({ id, tag: 'input', type: 'radio', name: el.name, label: q, required: radios.some(r => r.required), visible: radios.some(vis), options: radios.map(r => labelFor(r)), value: (radios.find(r => r.checked) ? labelFor(radios.find(r => r.checked)) : ''), group: g });
      continue;
    }
    const id = 'jd' + (n++); el.setAttribute('data-jd', id);
    const combo = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list';
    let label = labelFor(el);
    if (!label || label === el.name || /^(cards|question|field)\\[|^[a-f0-9-]{20,}$/i.test(label) || /^(type (your )?(response|answer|here)|your (answer|response)|enter (your )?(answer|response)|start typing|write here|answer here)\\b/i.test(label)) label = questionOf(el) || label;
    // File inputs are often labelled by their button ("Attach", "Upload"): use the field's question and id too.
    if (type === 'file' && /^(attach|upload|choose file|browse|select file|drop)/i.test(label)) label = [questionOf(el), el.id, el.name, label].filter(Boolean).join(' ');
    fields.push({ id, domId: el.id || undefined, tag: el.tagName.toLowerCase(), type: combo ? 'combobox' : type, name: el.name || '', label, required: !!el.required || el.getAttribute('aria-required') === 'true' || /\\*\\s*$/.test(labelFor(el)), visible: vis(el),
      options: el.tagName === 'SELECT' ? [...el.options].map(o => clean(o.text)).filter(Boolean) : [], value: type === 'file' ? [...(el.files||[])].map(f => f.name).join(', ') : (el.value || ''), checked: type === 'checkbox' ? el.checked : undefined });
  }
  const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]');
  const password = !!document.querySelector('input[type=password]');
  const btn = [...document.querySelectorAll('button, input[type=submit]')].find(b => /submit|apply|send application/i.test(b.innerText || b.value || '') && vis(b));
  return { url: location.href, host: location.hostname, fields, captcha, password, submitLabel: btn ? clean(btn.innerText || btn.value) : null, text: clean(document.body.innerText).slice(0, 4000) };
})()`

/** JS expression that finds a field: our marker first, then its own id. */
export function findExpr(id: string, domId?: string): string {
  return `(document.querySelector('[data-jd="${id}"]') || ${domId ? `document.getElementById(${JSON.stringify(domId)})` : "null"})`
}

/** Set a text-like field or select. Returns the value the page now holds. */
export function setValueScript(id: string, value: string, domId?: string): string {
  return `(() => {
    const el = ${findExpr(id, domId)}; if (!el) return null;
    el.focus();
    if (el.tagName === 'SELECT') {
      const want = ${JSON.stringify(value)}.toLowerCase();
      const opt = [...el.options].find(o => o.text.trim().toLowerCase() === want) || [...el.options].find(o => o.text.trim().toLowerCase().includes(want));
      if (!opt) return null; el.value = opt.value;
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return el.tagName === 'SELECT' ? el.options[el.selectedIndex].text.trim() : el.value;
  })()`
}

export function setRadioScript(group: string, optionLabel: string): string {
  return `(() => {
    const clean = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const want = ${JSON.stringify(optionLabel)}.toLowerCase();
    const radios = [...document.querySelectorAll('input[type=radio][data-jd-group="${group}"]')];
    const lab = r => clean(r.labels && r.labels.length ? r.labels[0].innerText : r.value);
    const r = radios.find(x => lab(x) === want) || radios.find(x => lab(x).includes(want));
    if (!r) return null; r.click(); r.dispatchEvent(new Event('change', { bubbles: true })); return lab(r);
  })()`
}

export const CLICK_SUBMIT_SCRIPT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 };
  const btn = [...document.querySelectorAll('button, input[type=submit]')].find(b => /submit|apply|send application/i.test(b.innerText || b.value || '') && vis(b) && !b.disabled);
  if (!btn) return false; btn.click(); return true;
})()`

export const RESULT_SCRIPT = `(() => {
  const t = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim();
  const invalid = [...document.querySelectorAll('[aria-invalid=true], .error:not(:empty), .field-error:not(:empty), [class*=error-message]:not(:empty)')].filter(e => e.getBoundingClientRect().height > 0).map(e => (e.innerText || e.getAttribute('name') || '').trim()).filter(Boolean).slice(0, 5);
  return { url: location.href, host: location.hostname, text: t.slice(0, 2000), invalid };
})()`

export const CONFIRM_RE = /\b(thank(s| you) for (applying|your application|your interest)|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (submitted|applied)|your application is (in|complete))\b/i

/** Map the form's own option text onto a yes/no answer ("Yes, I am willing" -> "yes"). */
/**
 * Map an answer onto the form's own option text. Order matters: exact, then the option that
 * STARTS with the answer as a word ("India" -> "India +91", never "British Indian Ocean
 * Territory"), then a whole-word match. No match means null - never a guess.
 */
export function pickOption(options: string[], answer: string): string | null {
  const a = answer.trim().toLowerCase()
  if (!a) return null
  const clean = (o: string) => o.trim().toLowerCase()
  const exact = options.find((o) => clean(o) === a)
  if (exact) return exact
  const yes = /^(y|yes|true|ok|okay|sure|willing|i am|i do|i can)\b/.test(a)
  const no = /^(n|no|false|not|never|i am not|i do not|i don't)\b/.test(a)
  if (yes) return options.find((o) => /^yes\b/i.test(o.trim())) ?? null
  if (no) return options.find((o) => /^no\b/i.test(o.trim())) ?? null
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const starts = options.filter((o) => new RegExp(`^${esc}(\\b|\\s|$)`, "i").test(o.trim()))
  if (starts.length) return starts.sort((x, y) => x.length - y.length)[0]
  const word = options.filter((o) => new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(o))
  return word.length === 1 ? word[0] : null
}

export const DECLINE_RE = /prefer not|decline|don'?t wish|do not wish|not to (say|disclose|answer|self.?identify)|i don'?t want to answer|rather not/i
export const LEGAL_RE = /\b(i (hereby )?(certify|confirm|declare|attest|acknowledge|agree|consent|authori[sz]e|understand)|yes,? i (consent|agree)|terms (and|&) conditions|privacy (policy|notice)|background (check|verification)|true and (complete|accurate)|accurate (and|&) complete|e-?signature|electronic signature|gdpr|data processing|arbitrat\w*|agreement to|consent to)\b/i
export const VOLUNTARY_RE = /\b(voluntary|self[- ]identif|eeo|equal (employment )?opportunity|demographic|diversity (survey|questions?))\b/i
