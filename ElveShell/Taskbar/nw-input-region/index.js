// index.js
// simple wrapper around native binding

const bindings = require('bindings');
const native = bindings('x11_input_region'); // built addon name

module.exports = {
  /**
   * setPID(pid: number)
   */
  setPID(pid) {
    return native.setPID(pid);
  },

  /**
   * setInputRegion(rects: Array<{x,y,w,h}>)
   */
  setInputRegion(rects) {
    return native.setInputRegion(rects);
  },

  clearInputRegion() {
    return native.clearInputRegion();
  }
};
