PRINTBRIDGE
===========

Print from any computer to any printer in the office. Everyone prints
from their own phone or computer by opening the printing page in a web
browser. No app, no account.


WHAT IS ON THIS COMPUTER
------------------------
PrintBridge runs quietly in the background. There is no window to keep
open. On the main computer and on computers that share a printer, it
starts by itself as soon as Windows starts - even after a power cut,
with nobody signed in. On a computer that only prints, it starts when
someone signs in.

Every computer finds the main computer by itself, and finds it again
if its address changes (after a power cut or a router restart, say).
Nobody needs to type the address in again.

In the Start menu, under "PrintBridge":

  PrintBridge           opens the printing page
  Check PrintBridge     shows whether everything is working, and
                         what to do if something isn't
  Restart PrintBridge   stops and starts it again (try this first if
                         something seems stuck)
  Read me               this file

There is also a "PrintBridge" shortcut on the desktop, which opens the
printing page.


HOW PEOPLE PRINT
----------------
From Excel, Word or any other program on this computer:
1. Print as usual (Ctrl+P) and choose the printer "PrintBridge".
   Everything in the program's Print window works: print a selection,
   landscape, fit to one page, its own preview.
2. The print page opens with a preview. Choose which office printer,
   and press Print.

From a phone, tablet or any computer:
1. Connect to the office Wi-Fi.
2. Open the address on the wall sign (or scan its code with a phone
   camera). It looks like  http://192.168.1.20:3000
3. Drop in a file. The preview shows every page: tick pages to print
   only those, choose portrait or landscape and the printer, press Print.

To print the wall sign, open the printing page on the main computer and
go to  http://localhost:3000/poster.html

If the printing page shows an error (404, or "can't connect") or the main
computer was given a new address: press "Refresh address" at the top of the
printing page. On the main computer it shows the address everyone should use
now (then print a new sign for the wall); on a phone or another computer it
looks for the main computer again, and offers a link if it finds it.

In Setup, on a printer or print-only computer, "Find again" searches the
network for the main computer again, without starting Setup over.


KEEP IN MIND
------------
- The main computer must be switched on for anyone to print, and each
  computer with a printer must be on for that printer to work.
- On the main computer, Setup asks how it should behave when its lid
  closes and when its battery gets critically low, and whether it
  should stay awake at all - with a recommended choice for each. By
  default it stays awake while switched on (the screen still turns off
  after 10 minutes).
- Anyone on the office network can print, and can manage printers on the
  printing page. That is fine on a private office network; don't use it
  on a shared or public network.


ADDING, CHANGING OR REMOVING
----------------------------
- Another computer with a printer: run the same PrintBridgeSetup.exe
  on it and choose "This computer shares a printer".
- A new main computer: run Setup on it, choose "This is the main
  computer" and tick "Make this the only main computer". Every other
  main computer on the network then stops running its printing page and
  shares its printers through the new one, by itself within about a
  minute (one that is switched off does so when it's next switched on).
  Nothing is deleted on them; Check PrintBridge on an old one says what
  happened. Older versions can't switch over by themselves - run Setup
  on them (choose "This computer shares a printer") or uninstall there.
  Print the new main computer's wall sign to replace the old ones.
- A computer without a printer that should print from Excel, Word and
  other programs: run it and choose "This computer only prints".
- Change this computer's role or name: run PrintBridgeSetup.exe again.
- Remove it: Settings > Apps > PrintBridge > Uninstall. That removes
  the program, the "PrintBridge" printer, its start-up setting,
  firewall rules and (unless you choose to keep it) the saved
  information - a tick box on the uninstall screen. If Setup was the
  one that installed LibreOffice, there is a second tick box for
  keeping that too; if LibreOffice was already on the computer before,
  it is always left alone. The older version's leftover files are
  always cleaned up. Power settings go back to how they were.
- Setup can always be run again, on top of an existing PrintBridge
  install (including one from an earlier version or under an earlier
  name), as an update: it finds what's already
  there - including a half-finished or leftover earlier setup - and
  takes over cleanly, without creating a duplicate printer or a second
  Start menu entry.
- Main computer's address: Setup offers "Give this computer a fixed
  address", so the wall sign's address keeps working after a power cut
  or a router restart. It suggests a free address high up on the
  network (.200 to .250) and changes it back to automatic by itself if
  the network stops working with it. Unticking it on a later Setup run,
  or uninstalling, makes the address automatic again. Reserving the
  address in the router as well rules out another device ever getting it.
- Updates install by themselves (from version 4.1.3 on). Every few
  hours each computer looks for a new version; when there is one, it
  downloads it, waits until nothing is printing, installs it with no
  questions (every setting stays as it is) and checks that it starts -
  if it doesn't, the previous version is put back. To look straight
  away, choose "Update PrintBridge now" in the Start menu. Check
  PrintBridge shows the version and how the last update went.


FOR WHOEVER LOOKS AFTER THIS
----------------------------
Program:        C:\Program Files\Office Printing
Saved data:     C:\ProgramData\Office Printing
                  settings.json      what this computer does, and its name
                  website\db.json    list of printers and computers
                  printer\config.json   this computer's connection
                  outbox\            printouts on their way to the print page
                  logs\              what happened, in plain text
                  install-record.json  what Setup added, so removing it
                                       takes away exactly that and no more
                  logs\updates.log    what automatic updates did
                  update-settings.json  {"automatic": false} switches
                                       automatic updates off on this computer
Updates:        C:\Program Files\Office Printing\updates (only
                administrators can change it). A new version is only
                installed if it is signed with PrintBridge's own update
                key. Task Scheduler tasks "Office Printing Update" and
                "Office Printing (start 1)" etc. are helpers for it.
The printing page uses port 3000. Other computers find the main
computer by asking the network (UDP port 39276), or by trying every
address if nothing answers, and find it again if its address changes.
Settings are saved with a backup copy, so a power cut while saving
can't wipe them. A Task Scheduler task named "Office Printing" starts
the background parts when Windows starts.


PrintBridge - ☕ by @devnithdev
