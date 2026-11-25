// Language picker (Google Translate). Sinhala and Tamil first, then every
// language Google offers. The choice is kept on this device. Google's script
// is only fetched once someone picks a language other than English, so the
// page stays light on old phones.
// The same file is used by the download page (printbridge-updates/lang.js).
(function () {
  var KEY = "printbridge-language";
  var FIRST = [["en", "English"], ["si", "සිංහල · Sinhala"], ["ta", "தமிழ் · Tamil"]];
  var box = document.getElementById("langPick");
  if (!box) return;

  var saved = "";
  try { saved = localStorage.getItem(KEY) || ""; } catch (e) {}

  // Clears Google's own googtrans cookie (this host and the parent domain).
  function clearCookie() {
    document.cookie = "googtrans=; path=/; max-age=0";
    var host = location.hostname;
    if (host.indexOf(".") > 0 && !/^[\d.]+$/.test(host)) {
      document.cookie = "googtrans=; path=/; domain=." + host + "; max-age=0";
      document.cookie = "googtrans=; path=/; domain=." + host.split(".").slice(-2).join(".") + "; max-age=0";
    }
  }

  var select = document.createElement("select");
  select.id = "langSelect";
  select.className = "notranslate";
  select.setAttribute("translate", "no");
  select.setAttribute("aria-label", "Language");
  FIRST.forEach(function (pair) { select.add(new Option(pair[1], pair[0])); });
  select.add(new Option("More languages...", "more"));

  var label = document.createElement("label");
  label.className = "lang-label notranslate";
  label.setAttribute("translate", "no");
  label.htmlFor = "langSelect";
  label.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/></svg>';
  box.appendChild(label);
  box.appendChild(select);

  var holder = document.createElement("div");
  holder.id = "google_translate_element";
  holder.hidden = true;
  box.appendChild(holder);

  var loading = null;
  function loadGoogle() {
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      window.googleTranslateElementInit = function () {
        new google.translate.TranslateElement({ pageLanguage: "en", autoDisplay: false }, "google_translate_element");
        var tries = 0;
        (function wait() {
          var combo = holder.querySelector("select");
          if (combo && combo.options.length > 1) return resolve(combo);
          if (++tries < 100) setTimeout(wait, 100); else resolve(null);
        })();
      };
      var s = document.createElement("script");
      s.src = "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // Add every other language Google offers, after the first three.
  function fillFrom(combo) {
    if (!combo || select.dataset.full) return;
    var more = select.querySelector('option[value="more"]');
    if (more) more.remove();
    var have = {};
    FIRST.forEach(function (p) { have[p[0]] = 1; });
    // A saved language was added as its bare code until now: take that out, so it
    // shows once, under its real name.
    var raw = saved && !have[saved] ? select.querySelector('option[value="' + saved + '"]') : null;
    if (raw) raw.remove();
    Array.prototype.forEach.call(combo.options, function (o) {
      if (o.value && !have[o.value]) select.add(new Option(o.textContent, o.value));
    });
    if (saved) select.value = saved;
    select.dataset.full = "1";
  }

  // A short note beside the picker (the page can't be translated without the internet).
  var note = null;
  function say(text) {
    if (!note) {
      note = document.createElement("span");
      note.className = "lang-note notranslate";
      note.setAttribute("translate", "no");
      note.setAttribute("role", "status");
      box.appendChild(note);
    }
    note.textContent = text;
  }

  function apply(lang) {
    try { localStorage.setItem(KEY, lang); } catch (e) {}
    if (lang === "en") { clearCookie(); location.reload(); return; }
    loadGoogle().then(function (combo) {
      fillFrom(combo);
      if (!combo) { say("Translation needs an internet connection."); return; }
      say("");
      combo.value = lang;
      combo.dispatchEvent(new Event("change"));
    });
  }

  select.onchange = function () {
    var lang = select.value;
    if (lang === "more") {
      select.value = saved || "en";
      select.disabled = true;
      loadGoogle().then(function (combo) {
        select.disabled = false;
        fillFrom(combo);
        if (!combo) alert("Could not load the language list. Check the internet connection and try again.");
        else if (select.showPicker) try { select.showPicker(); } catch (e) {}
      });
      return;
    }
    saved = lang;
    apply(lang);
  };

  // Google's widget stalls if the page opens with its cookie already set, so
  // start clean and apply the saved choice through the widget instead.
  clearCookie();
  if (saved && saved !== "en") {
    // Shown as its code until the list of languages arrives (then fillFrom gives it its real name).
    if (!select.querySelector('option[value="' + saved + '"]')) select.add(new Option(saved, saved));
    select.value = saved;
    apply(saved);
  }
})();
