// pdf.js is sent gzipped to browsers that can take it, and as it is to the rest.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), http = require("http"), assert = require("assert"), { spawn } = require("child_process");
let n = 0; const ok = (c, m) => { assert(c, m); n++; console.log("  ok -", m); };
const PORT = 3614, dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbpv-")), server = path.join(__dirname, "../server");
const web = spawn("node", ["server.js"], { cwd: server, env: Object.assign({}, process.env, { PORT, NO_DISCOVERY: "1", PRINT_DATA_DIR: dir + "/w", PRINT_UPLOAD_DIR: dir + "/u" }), stdio: "ignore" });
const get = (p, headers) => new Promise((resolve, reject) => {
  http.get({ port: PORT, path: p, headers }, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ res, body: Buffer.concat(c) })); }).on("error", reject);
});
(async () => {
  for (let i = 0; i < 50; i++) { try { await get("/api/office-printing"); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
  for (const file of ["pdf.min.js", "pdf.worker.min.js"]) {
    const real = fs.readFileSync(path.join(server, "public/vendor/pdfjs", file));
    const zipped = await get("/vendor/pdfjs/" + file, { "Accept-Encoding": "gzip" });
    ok(zipped.res.statusCode === 200 && zipped.res.headers["content-encoding"] === "gzip" && /javascript/.test(zipped.res.headers["content-type"]), file + " is sent gzipped as a script");
    ok(zlib.gunzipSync(zipped.body).equals(real) && zipped.body.length < real.length / 2, file + " unzips to the same file, under half the size");
    const again = await get("/vendor/pdfjs/" + file, { "Accept-Encoding": "gzip", "If-None-Match": zipped.res.headers.etag });
    ok(again.res.statusCode === 304, file + " isn't sent again when the browser already has it");
    const plain = await get("/vendor/pdfjs/" + file, { "Accept-Encoding": "identity" });
    ok(plain.res.statusCode === 200 && !plain.res.headers["content-encoding"] && plain.body.equals(real), file + " is sent as it is to a browser that can't unzip");
  }
  web.kill(); console.log(n + " checks passed"); process.exit(0);
})().catch((e) => { console.error(e); web.kill(); process.exit(1); });
