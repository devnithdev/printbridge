// The printable sign. Its whole job is to turn "what's the address?" into
// "point your camera at this".

const $ = (id) => document.getElementById(id);

let addresses = [];
let nameUrl = null;

(async function start() {
  $("printPoster").onclick = () => window.print();

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

function useAddress(address) {
  $("posterAddress").textContent = address.url.replace(/^https?:\/\//, "");
  drawQr(address.url);

  // The name (like clenol-pc-5.local:3000) is only a second line: Android
  // often can't find .local names, so the QR code and main line stay numbers.
  const alt = $("posterAltAddress");
  const name = addresses.find((a) => a.url === nameUrl);
  if (name && name.url !== address.url) {
    alt.textContent = "or " + name.url.replace(/^https?:\/\//, "");
    alt.hidden = false;
  } else {
    alt.hidden = true;
  }
}

function drawQr(text) {
  const box = $("qrBox");
  box.innerHTML = "";

  // Error-correction level M with an automatic type number: plenty of
  // tolerance for a sign that will get scuffed on an office wall.
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  // createSvgTag scales cleanly to whatever size the poster CSS asks for,
  // which matters because this gets printed, not just looked at.
  box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });

  const svg = box.querySelector("svg");
  if (svg) {
    svg.setAttribute("width", "280");
    svg.setAttribute("height", "280");
    svg.style.display = "block";
  }
}
