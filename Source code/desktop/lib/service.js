// Windows only: the startup task.
//
// Older versions started only when someone signed in to Windows. After a
// power cut the computers came back on but sat at the sign-in screen, so
// the printing website and printer sharing stayed off until somebody signed
// in - and the computers that only print reported that the main computer
// "didn't answer".
//
// This task makes Windows start the background parts (the printing website
// on the main computer, printer sharing on computers with printers) as soon
// as Windows itself starts, under Windows' own system account, with nobody
// signed in. It is a plain Task Scheduler task named "Office Printing" (the
// internal name, like the folders and the firewall rules), set to:
//   - start at boot, and again if it ever stops with an error (every
//     minute, without limit),
//   - keep running for ever (Task Scheduler stops tasks after 3 days by
//     default), and on battery too,
//   - never start a second copy.
// The part that takes printouts from the "PrintBridge" printer still starts
// at sign-in (it opens the print page in that person's browser) - see
// supervisor.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("./paths");
const { run } = require("./win");

const SCHTASKS = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "schtasks.exe");

const xmlText = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function taskXml(exePath) {
  const B = require("./brand");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xmlText(B.NAME)}</Author>
    <Description>${xmlText("Starts " + B.NAME + "'s printing website and printer sharing when Windows starts, before anyone signs in, so printing comes back by itself after a power cut. " + B.CREDIT)}</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <LogonType>ServiceAccount</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${xmlText(exePath)}"</Command>
      <Arguments>service</Arguments>
      <WorkingDirectory>${xmlText(path.dirname(exePath))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

async function exists() {
  if (!P.IS_WINDOWS) return false;
  const r = await run(SCHTASKS, ["/Query", "/TN", P.TASK_NAME]);
  return r.ok;
}

// Adds (or replaces) the task. Needs administrator rights (Setup has them).
async function install() {
  if (!P.IS_WINDOWS) return { ok: false, message: "The startup task is only for Windows." };
  const file = path.join(os.tmpdir(), "office-printing-task-" + process.pid + ".xml");
  // Task Scheduler reads the file as UTF-16 (any folder name survives).
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(process.execPath), "utf16le")]));
  const r = await run(SCHTASKS, ["/Create", "/TN", P.TASK_NAME, "/XML", file, "/F"]);
  try { fs.rmSync(file, { force: true }); } catch (err) { /* temp folder */ }
  const ok = r.ok && (await exists());
  if (ok) P.updateRecord({ startupTask: true });
  return ok
    ? { ok: true, message: "Printing now starts by itself when Windows starts, before anyone signs in." }
    : { ok: false, message: "Couldn't add the startup task (" + ((r.stderr || r.stdout).trim().split(/\r?\n/).pop() || "Task Scheduler didn't answer") + "). " +
        "Printing still starts when someone signs in, as before." };
}

// Stops and removes the task (uninstalling, or this computer now only prints).
async function remove() {
  if (!P.IS_WINDOWS) return { ok: true, message: "" };
  if (await exists()) {
    await run(SCHTASKS, ["/End", "/TN", P.TASK_NAME]);
    await run(SCHTASKS, ["/Delete", "/TN", P.TASK_NAME, "/F"]);
  }
  // And the helper tasks automatic updates make (see updater.js and
  // startForSignedInUsers below), if there are any.
  for (const name of [P.TASK_NAME + " Update", P.TASK_NAME + " (start 1)", P.TASK_NAME + " (start 2)", P.TASK_NAME + " (start 3)", P.TASK_NAME + " (start 4)"]) {
    await run(SCHTASKS, ["/Delete", "/TN", name, "/F"]);
  }
  const gone = !(await exists());
  if (gone && P.readRecord().startupTask) P.updateRecord({ startupTask: false });
  return gone ? { ok: true, message: "Removed the startup task." } : { ok: false, message: "Couldn't remove the startup task." };
}

// Starts it now (after installing, rather than waiting for the next restart).
async function startNow() {
  if (!P.IS_WINDOWS) return false;
  const r = await run(SCHTASKS, ["/Run", "/TN", P.TASK_NAME]);
  return r.ok;
}

// Starts the sign-in part (printouts from the "PrintBridge" printer) for
// everyone signed in to this computer, as them, in their own session.
// Used after an automatic update: the installer stops every copy of the
// program, and the system account that runs it can't simply start a
// program on someone's screen (it would run invisibly, as the system). A
// one-off task for that person, set to run only while they are signed in,
// does it properly. Nobody signed in: nothing to do (it starts at the next
// sign-in, as always).
async function startForSignedInUsers(exePath) {
  if (!P.IS_WINDOWS) return 0;
  exePath = exePath || process.execPath;
  const { powershell } = require("./win");
  const r = await powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\" | ForEach-Object { " +
    "$o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; if ($o.User) { $o.Domain + '\\' + $o.User } } | Sort-Object -Unique");
  const people = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[^\\]+\\[^\\]+$/.test(l)).slice(0, 4);
  let started = 0;
  for (let i = 0; i < people.length; i++) {
    const name = P.TASK_NAME + " (start " + (i + 1) + ")";
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlText("Starts " + require("./brand").NAME + " for someone signed in, after an automatic update. Does nothing otherwise.")}</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlText(people[i])}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${xmlText(exePath)}"</Command>
      <WorkingDirectory>${xmlText(path.dirname(exePath))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
    const file = path.join(os.tmpdir(), "office-printing-start-" + process.pid + "-" + i + ".xml");
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
    const made = await run(SCHTASKS, ["/Create", "/TN", name, "/XML", file, "/F"]);
    try { fs.rmSync(file, { force: true }); } catch (err) { /* temp folder */ }
    if (made.ok && (await run(SCHTASKS, ["/Run", "/TN", name])).ok) started++;
  }
  return started;
}

module.exports = { install, remove, startNow, exists, taskXml, startForSignedInUsers };
