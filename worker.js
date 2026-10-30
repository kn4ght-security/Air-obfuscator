// runs the obfuscator in a Worker so a large file doesn't freeze the page
importScripts("obfuscate-core.js");

self.onmessage = function (e) {
  try {
    var bytes = new Uint8Array(e.data.buffer);
    var mode = e.data.mode || "plain";
    var result = self.ObfuscateCore.obfuscate(bytes, function (p, label) {
      self.postMessage({ type: "progress", progress: p, label: label });
    }, mode);
    self.postMessage({ type: "done", result: result });
  } catch (err) {
    self.postMessage({ type: "error", error: String((err && err.message) || err) });
  }
};
