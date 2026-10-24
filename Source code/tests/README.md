# Tests for 4.1.3 (power cuts, finding the main computer, startup, automatic updates)

Run from this folder with Node.js 16 or newer, after `npm install` in `../agent`
(for `ws`). Each prints its checks and "N checks passed". They use stand-in
websites (`fake-web.js`) on spare ports, so nothing else needs to be running.

    node t1-durable.js      settings survive a file wiped by a power cut (backup copy)
    node t2-find.js         the main computer answers the network question; old way still works
    node t3-store.js        the printer list and the website's id survive a power cut
    node t4-agent.js        printer computer: dead typed address, address change, wiped connection
    node t5-supervisor.js   startup task + sign-in split, restart request, take-over
    node t6-client.js       computer that only prints: prints straight away after the main computer moved
    node t8-refresh.js      "Refresh address" button: the website lists its addresses afresh, restarts its answering, can be recognised from an old address
    node t9-takeover.js     "Make this the only main computer": other main computers step down for a newer claim they have checked, never for an unconfirmed one
    node t10-updates.js     automatic updates: only a signed version with a matching installer is installed, only when nothing is printing; one that doesn't start is undone; publish-update.js makes releases the computers accept
    node t11-fixip.js       "keep this computer's address the same": reading Windows/macOS network settings, choosing a free address, refusing bad ones
    node t12-remote.js      printing from anywhere: pairing, codes (only fingerprints kept), files locked in the browser and unlocked only at the office, limits, approval, switching off, the office being off

These run on Linux/macOS. The Windows-only parts (the Task Scheduler task,
the installer) are covered by the test checklist in the 4.1.0 hand-over note.
t4, t5 and t6 need a real network card: on a machine with only
loopback (some virtual machines) the network question can't be sent and
t4-t6 fail for that reason alone.
