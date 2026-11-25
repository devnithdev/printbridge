// The printable sign. Its whole job is to turn "what's the address?" into
// "point your camera at this".

const $ = (id) => document.getElementById(id);

let addresses = [];
let nameUrl = null;
let current = null; // the address on the sign now

// The smaller sizes print a whole A4 sheet of the same label, to cut out.
const SHEETS = { card: 4, sticker: 12, mini: 30 };
const PRINT_TEXT = { wall: "Print this sign", card: "Print the desk cards", sticker: "Print the stickers", mini: "Print the stickers", trouble: "Print the help sign" };

(async function start() {
  $("printPoster").onclick = () => window.print();
  $("sizePick").onchange = showSize;

  let where = null;
  try {
    const response = await fetch("/api/where");
    where = await response.json();
  } catch (err) {
    where = null;
  }

  addresses = buildAddressList(where);

  if (!addresses.length) {
    $("pageMessage").hidden = false;
    $("pageMessage").className = "page-message warn";
    $("pageMessage").textContent =
      "This computer doesn't seem to be on a network right now, so there's no " +
      "address other devices could use. Connect it to the office Wi-Fi and reload.";
    $("posterAddress").textContent = "(not on a network)";
    current = null; // no address to put on a sign: never a "localhost" one that nobody else can reach
    return;
  }

  // If there is more than one network address (Wi-Fi and Ethernet, say),
  // let whoever prints the sign pick the right one.
  if (addresses.length > 1) {
    const picker = $("addressPick");
    picker.style.display = "";
    addresses.forEach((address, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = address.label;
      picker.appendChild(option);
    });
    picker.onchange = () => useAddress(addresses[Number(picker.value)]);
    $("addressNote").textContent =
      "This computer has more than one network address. Pick the one on the " +
      "same Wi-Fi as everybody else, then check the code works before printing.";
  }

  useAddress(addresses[0]);
})();

function buildAddressList(where) {
  const list = [];
  if (!where) return list;

  for (const url of where.addresses || []) {
    list.push({ url, label: url });
  }
  // Numbers always come first. If the computer didn't report any, but this
  // page was itself opened by number (http://192.168.x.x:3000), use that.
  if (!list.length && /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) && !location.hostname.startsWith("127.")) {
    const url = location.protocol + "//" + location.host;
    list.push({ url, label: url });
  }
  nameUrl = where.hostnameUrl || null;
  if (where.hostnameUrl) {
    list.push({ url: where.hostnameUrl, label: where.hostnameUrl + "  (name, not numbers)" });
  }
  return list;
}

// The "Printer acting up?" sign in each language. The red notes on the printing
// page are in English, so the English words stay in quotes to match them.
const TROUBLE = {
  si: {
    head: "ප්‍රින්ටරයේ ගැටලුවක්ද?",
    tag: "කළ යුත්තේ මෙයයි.",
    steps: [
      "<strong>මුද්‍රණ පිටුව බලන්න.</strong> ප්‍රින්ටරයක් අසල රතු සටහනක් (“Paper jam”, “Out of paper”, “Switched off”) තිබේ නම්, ඇති වරද කුමක්දැයි එයින් කියවේ.",
      "<strong>ප්‍රින්ටරය ළඟින් පරීක්ෂා කරන්න:</strong> තැටියේ කඩදාසි තිබේද, කඩදාසි හිරවී නැද්ද, පියන් වසා ඇත්ද, දෝෂ එළියක් නොදැල්වෙනවාද, ප්‍රින්ටරය ක්‍රියාත්මකද.",
      "<strong>රැඳී සිටින මුද්‍රණ ආරක්ෂිතයි.</strong> ප්‍රින්ටරය හදා ගත් පසු ඒවා මුද්‍රණය වේ. මිනිත්තු 30කට වඩා හිරවී ඇති ඒවා ඉබේම අවලංගු වන නිසා, පැරණි පිටු පැය ගණනකට පසු එළියට නොඑයි. එවිට “නැවත එවන්න” (send it again) යන පණිවිඩය පෙනේ.",
      "<strong>හදිසිද?</strong> වෙනත් ප්‍රින්ටරයක මුද්‍රණය කරන්න: මුද්‍රණ පිටුවේ වෙනත් එකක් තෝරන්න.",
      "<strong>තවමත් විසඳී නැද්ද?</strong> මුද්‍රණ පිටුවේ <strong>Need help?</strong> ඔබන්න. පිටුව විවෘතව ඇති සියල්ලන්ටම එය දැනුම් දෙයි."
    ],
    foot: "වෙනස් අයගේ පිටු කිසිවිටෙකත් මිශ්‍ර නොවේ: එක් ප්‍රින්ටරයක් එක් මුද්‍රණයක් අවසන් කළ පසුවය ඊළඟ එක ආරම්භ කරන්නේ."
  },
  ta: {
    head: "பிரிண்டரில் பிரச்சினையா?",
    tag: "செய்ய வேண்டியது இதுதான்.",
    steps: [
      "<strong>அச்சிடும் பக்கத்தைப் பாருங்கள்.</strong> ஒரு பிரிண்டருக்கு அருகில் சிவப்புக் குறிப்பு (“Paper jam”, “Out of paper”, “Switched off”) இருந்தால், அதுவே என்ன பிரச்சினை என்று சொல்லும்.",
      "<strong>பிரிண்டரையே சோதியுங்கள்:</strong> தட்டில் காகிதம் உள்ளதா, காகிதம் சிக்கவில்லையா, மூடிகள் மூடப்பட்டுள்ளனவா, பிழை விளக்கு மின்னவில்லையா, பிரிண்டர் இயக்கத்தில் உள்ளதா.",
      "<strong>காத்திருக்கும் அச்சுகள் பாதுகாப்பாக உள்ளன.</strong> பிரிண்டர் சரியானதும் அவை அச்சாகும். 30 நிமிடங்களுக்கு மேல் சிக்கியிருப்பவை தாமாகவே ரத்தாகும்; அதனால் பழைய பக்கங்கள் பல மணி நேரம் கழித்து வராது. அப்போது “மீண்டும் அனுப்புங்கள்” (send it again) என்ற செய்தி தெரியும்.",
      "<strong>அவசரமா?</strong> வேறொரு பிரிண்டரில் அச்சிடுங்கள்: அச்சிடும் பக்கத்தில் வேறொன்றைத் தேர்ந்தெடுங்கள்.",
      "<strong>இன்னும் சரியாகவில்லையா?</strong> அச்சிடும் பக்கத்தில் <strong>Need help?</strong> ஐ அழுத்துங்கள். அந்தப் பக்கத்தைத் திறந்து வைத்திருக்கும் அனைவருக்கும் அது தெரிவிக்கும்."
    ],
    foot: "வெவ்வேறு நபர்களின் பக்கங்கள் ஒருபோதும் கலக்காது: ஒவ்வொரு பிரிண்டரும் ஒரு அச்சை முடித்த பிறகுதான் அடுத்ததைத் தொடங்கும்."
  }
};
const WALL = {
  si: {
    head: "ඔබේ දුරකථනයෙන් මුද්‍රණය කරන්න",
    tag: "යෙදුමක් අවශ්‍ය නැත. ගිණුමක් අවශ්‍ය නැත. ස්කෑන් කරන්න පමණයි.",
    scan: "ඔබේ කැමරාව මෙතැනට යොමු කරන්න",
    or: "නැතහොත් ඕනෑම බ්‍රවුසරයක මෙය ටයිප් කරන්න",
    steps: [
      "කේතය ස්කෑන් කරන්න (නැතහොත් ලිපිනය ටයිප් කරන්න).",
      "ඔබේ නම එක් වරක් ටයිප් කරන්න.",
      "ඔබට අවශ්‍ය ගොනුව හෝ ඡායාරූපය දමන්න.",
      "<strong>Print</strong> ඔබා, ගොස් එය ලබා ගන්න."
    ],
    foot: "කාර්යාලයේ Wi-Fi හි ඇති ඕනෑම දුරකථනයක, ටැබ්ලටයක හෝ ලැප්ටොපයක ක්‍රියා කරයි."
  },
  ta: {
    head: "உங்கள் தொலைபேசியிலிருந்து அச்சிடுங்கள்",
    tag: "செயலி வேண்டாம். கணக்கு வேண்டாம். ஸ்கேன் செய்தால் போதும்.",
    scan: "உங்கள் கேமராவை இங்கே காட்டுங்கள்",
    or: "அல்லது ஏதேனும் உலாவியில் இதைத் தட்டச்சு செய்யுங்கள்",
    steps: [
      "குறியீட்டை ஸ்கேன் செய்யுங்கள் (அல்லது முகவரியைத் தட்டச்சு செய்யுங்கள்).",
      "உங்கள் பெயரை ஒருமுறை தட்டச்சு செய்யுங்கள்.",
      "உங்களுக்கு வேண்டிய கோப்பு அல்லது புகைப்படத்தைச் சேர்க்கவும்.",
      "<strong>Print</strong> ஐ அழுத்தி, வந்து எடுத்துக்கொள்ளுங்கள்."
    ],
    foot: "அலுவலக Wi-Fi இல் உள்ள எந்த தொலைபேசி, டேப்லெட் அல்லது லேப்டாப்பிலும் வேலை செய்யும்."
  }
};
const SMALL = {
  en: { label: "Scan to print", or: "or" },
  si: { label: "මුද්‍රණයට ස්කෑන් කරන්න", or: "නැතහොත්" },
  ta: { label: "அச்சிட ஸ்கேன் செய்யுங்கள்", or: "அல்லது" }
};

// One language for every sign. English is whatever the page itself says, kept
// the first time so it can be put back.
const ENGLISH = {};
function fillSign(prefix, text, ids) {
  for (const k in ids) {
    const key = prefix + k;
    if (!(key in ENGLISH)) ENGLISH[key] = $(ids[k]).innerHTML;
    $(ids[k]).innerHTML = text ? text[k] : ENGLISH[key];
  }
  if (!("steps" + prefix in ENGLISH)) ENGLISH["steps" + prefix] = $(prefix + "Steps").innerHTML;
  $(prefix + "Steps").innerHTML = text ? text.steps.map((s) => "<li>" + s + "</li>").join("") : ENGLISH["steps" + prefix];
}

function signLanguage() { return $("troubleLang").value; }

function showLanguage() {
  const code = signLanguage();
  fillSign("t", TROUBLE[code], { head: "tHead", tag: "tTag", foot: "tFoot" });
  fillSign("w", WALL[code], { head: "wHead", tag: "wTag", scan: "wScan", or: "wOr", foot: "wFoot" });
  $("trouble").lang = code;
  $("poster").lang = code;
  showSize();
  if (current) useAddress(current);
}
$("troubleLang").addEventListener("change", showLanguage);

function showSize() {
  const size = $("sizePick").value;
  $("poster").hidden = size !== "wall";
  $("trouble").hidden = size !== "trouble";
  $("labels").hidden = size === "wall" || size === "trouble";
  $("printPoster").textContent = PRINT_TEXT[size];
  const box = $("labels");
  box.className = "labels " + size;
  box.innerHTML = "";
  if (size === "wall" || size === "trouble" || !current) return;
  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = '<span class="l-brand notranslate" translate="no">PRINTBRIDGE</span><p class="l-title"></p>' + qrSvg(current.url) + '<p class="l-addr"></p>';
  label.querySelector(".l-title").textContent = SMALL[signLanguage()].label;
  label.querySelector(".l-addr").textContent = current.url.replace(/^https?:\/\//, "");
  for (let i = 0; i < SHEETS[size]; i++) box.appendChild(label.cloneNode(true));
}

function useAddress(address) {
  current = address;
  $("posterAddress").textContent = address.url.replace(/^https?:\/\//, "");
  drawQr(address.url);
  showSize();

  // The name (like clenol-pc-5.local:3000) is only a second line: Android
  // often can't find .local names, so the QR code and main line stay numbers.
  const alt = $("posterAltAddress");
  const name = addresses.find((a) => a.url === nameUrl);
  if (name && name.url !== address.url) {
    alt.textContent = SMALL[signLanguage()].or + " " + name.url.replace(/^https?:\/\//, "");
    alt.hidden = false;
  } else {
    alt.hidden = true;
  }
}

// Error-correction level M with an automatic type number: plenty of
// tolerance for a sign that will get scuffed on an office wall.
// createSvgTag scales cleanly to whatever size the CSS asks for, which
// matters because this gets printed, not just looked at.
function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
}

function drawQr(text) {
  const box = $("qrBox");
  box.innerHTML = qrSvg(text);

  const svg = box.querySelector("svg");
  if (svg) {
    svg.setAttribute("width", "280");
    svg.setAttribute("height", "280");
    svg.style.display = "block";
  }
}
