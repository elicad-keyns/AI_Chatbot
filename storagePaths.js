const path = require("node:path");

function getDataDir() {
  return process.env.DATA_DIR
    || process.env.RAILWAY_VOLUME_MOUNT_PATH
    || path.join(__dirname, "data");
}

function dataPath(fileName) {
  return path.join(getDataDir(), fileName);
}

module.exports = {
  dataPath,
  getDataDir
};
