// Rewrites the version info (company, product name, description, version) and
// the icon of a Windows .exe, so OfficePrinting.exe says "PrintBridge - Devnith AE"
// in Task Manager and file properties instead of "Node.js".
//
//   node relabel-exe.js <input.exe> <output.exe> <icon.ico>
//
// build-windows.sh runs this on pkg's cached Windows base program before the
// build; pkg then packs the program into the relabelled copy.
const fs = require("fs");
const ResEdit = require("resedit");
const PE = require("pe-library");

const [src, out, ico] = process.argv.slice(2);
if (!src || !out || !ico) {
  console.error("usage: node relabel-exe.js <input.exe> <output.exe> <icon.ico>");
  process.exit(1);
}

const exe = PE.NtExecutable.from(fs.readFileSync(src));
const res = PE.NtExecutableResource.from(exe);

const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
const lang = { lang: 1033, codepage: 1200 };
for (const l of vi.getAllLanguagesForStringValues()) {
  for (const k of ["OriginalFilename", "InternalName"]) vi.removeStringValue(l, k);
}
vi.setStringValues(lang, {
  CompanyName: "Devnith AE",
  ProductName: "PrintBridge",
  FileDescription: "PrintBridge",
  LegalCopyright: "Copyright (C) 2026 Devnith AE",
  OriginalFilename: "OfficePrinting.exe",
  InternalName: "OfficePrinting",
  FileVersion: "4.2.2",
  ProductVersion: "4.2.2",
});
vi.setFileVersion(4, 1, 1, 0, 1033);
vi.setProductVersion(4, 1, 1, 0, 1033);
vi.outputToResourceEntries(res.entries);

const icon = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const id = groups.length ? groups[0].id : 1;
const lg = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lg, icon.icons.map((i) => i.data));

res.outputResource(exe);
fs.writeFileSync(out, Buffer.from(exe.generate()));
console.log("wrote", out);
