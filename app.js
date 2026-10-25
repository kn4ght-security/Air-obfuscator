(function () {
  var MAX_BYTES = 40 * 1024 * 1024;

  var drop = document.getElementById("drop");
  var fileInput = document.getElementById("file");
  var fileInfo = document.getElementById("fileInfo");
  var fileName = document.getElementById("fileName");
  var clearFileBtn = document.getElementById("clearFile");
  var codeBox = document.getElementById("code");
  var runBtn = document.getElementById("run");
  var resetBtn = document.getElementById("reset");
  var statusEl = document.getElementById("status");
  var bar = document.getElementById("bar");
  var barFill = document.getElementById("barFill");
  var outputPanel = document.getElementById("outputPanel");
  var output = document.getElementById("output");
  var copyBtn = document.getElementById("copy");
  var downloadBtn = document.getElementById("download");

  var pickedFile = null; // File object, takes priority over the textarea
  var worker = null;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function showBar(show) {
    bar.className = "bar" + (show ? " show" : "");
    if (!show) barFill.style.width = "0%";
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function pickFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setStatus("That file is " + fmtSize(file.size) + ". The limit is 40 MB.", "err");
      return;
    }
    pickedFile = file;
    fileName.textContent = file.name + " \u00b7 " + fmtSize(file.size);
    fileInfo.style.display = "flex";
    setStatus("");
  }

  drop.addEventListener("click", function () { fileInput.click(); });
  drop.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) pickFile(fileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add("drag"); });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove("drag"); });
  });
  drop.addEventListener("drop", function (e) {
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pickFile(f);
  });
  clearFileBtn.addEventListener("click", function () {
    pickedFile = null;
    fileInput.value = "";
    fileInfo.style.display = "none";
  });

  resetBtn.addEventListener("click", function () {
    pickedFile = null;
    fileInput.value = "";
    fileInfo.style.display = "none";
    codeBox.value = "";
    outputPanel.style.display = "none";
    setStatus("");
    showBar(false);
  });

  function getSourceBytes(cb) {
    if (pickedFile) {
      var reader = new FileReader();
      reader.onload = function () { cb(new Uint8Array(reader.result)); };
      reader.onerror = function () { setStatus("Could not read that file.", "err"); runBtn.disabled = false; };
      reader.readAsArrayBuffer(pickedFile);
      return;
    }
    var text = codeBox.value;
    if (!text.trim()) text = 'print("Hello, Luau!")';
    cb(new TextEncoder().encode(text));
  }

  runBtn.addEventListener("click", function () {
    runBtn.disabled = true;
    outputPanel.style.display = "none";
    showBar(true);
    setStatus("Reading source...");

    getSourceBytes(function (bytes) {
      if (bytes.byteLength > MAX_BYTES) {
        setStatus("That's " + fmtSize(bytes.byteLength) + ". The limit is 40 MB.", "err");
        runBtn.disabled = false;
        showBar(false);
        return;
      }
      if (worker) worker.terminate();
      worker = new Worker("worker.js");
      worker.onmessage = function (e) {
        var msg = e.data;
        if (msg.type === "progress") {
          barFill.style.width = Math.round(msg.progress * 100) + "%";
          setStatus(msg.label);
        } else if (msg.type === "done") {
          showBar(false);
          runBtn.disabled = false;
          setStatus("Obfuscated " + fmtSize(bytes.byteLength) + " of source.", "ok");
          output.textContent = msg.result;
          outputPanel.style.display = "block";
          outputPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else if (msg.type === "error") {
          showBar(false);
          runBtn.disabled = false;
          setStatus("Failed: " + msg.error, "err");
        }
      };
      worker.onerror = function (err) {
        showBar(false);
        runBtn.disabled = false;
        setStatus("Worker error: " + err.message, "err");
      };
      // transfer the buffer so a big file doesn't get copied twice
      var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      worker.postMessage({ buffer: buf }, [buf]);
    });
  });

  copyBtn.addEventListener("click", function () {
    var text = output.textContent;
    function done() {
      var old = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      setTimeout(function () { copyBtn.textContent = old; }, 1600);
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else {
      var t = document.createElement("textarea");
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      document.body.removeChild(t);
    }
  });

  downloadBtn.addEventListener("click", function () {
    var blob = new Blob([output.textContent], { type: "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var base = pickedFile ? pickedFile.name.replace(/\.lua$/i, "") : "script";
    a.href = url;
    a.download = base + ".obfuscated.lua";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });
})();
