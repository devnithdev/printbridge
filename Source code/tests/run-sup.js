process.argv[1] = require("path").join(__dirname, "..") + "/desktop/main.js";
require(require("path").join(__dirname, "..") + "/desktop/lib/supervisor").start(process.argv[2]);
