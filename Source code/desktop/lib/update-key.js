// The public half of the key that signs every update (see updater.js and
// update-config.js). PUBLISH-UPDATE.command writes it here the first time
// it is run (the private half stays on the Mac that publishes updates).
// Empty means automatic updates are switched off in this build.
module.exports = {
  PUBLIC_KEYS: [
    "MCowBQYDK2VwAyEApReaUDf8rvjgBsvZjNwMVPLbKT3v/GGZmJbedejzTh8=",
  ],
};
