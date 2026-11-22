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
  var protectionSel = document.getElementById("protection");

  var pickedFile = null; // File object, takes priority over the textarea
  var worker = null;
  var runBtnIdleText = runBtn.textContent;

  function setProcessing(on) {
    runBtn.disabled = on;
    runBtn.classList.toggle("loading", on);
    runBtn.textContent = on ? "Processing..." : runBtnIdleText;
  }

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

  // "drop" is a <label> wrapping the <input>, so a pointer click already
  // opens the file dialog natively; only keyboard activation needs help.
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
    setProcessing(false);
  });

  function getSourceBytes(cb) {
    if (pickedFile) {
      var reader = new FileReader();
      reader.onload = function () { cb(new Uint8Array(reader.result)); };
      reader.onerror = function () { setStatus("Could not read that file.", "err"); setProcessing(false); };
      reader.readAsArrayBuffer(pickedFile);
      return;
    }
    var text = codeBox.value;
    if (!text.trim()) text = 'print("Hello, Luau!")';
    cb(new TextEncoder().encode(text));
  }

  runBtn.addEventListener("click", function () {
    setProcessing(true);
    outputPanel.style.display = "none";
    showBar(true);
    setStatus("Reading source...");

    getSourceBytes(function (bytes) {
      if (bytes.byteLength > MAX_BYTES) {
        setStatus("That's " + fmtSize(bytes.byteLength) + ". The limit is 40 MB.", "err");
        setProcessing(false);
        showBar(false);
        return;
      }
      function scanMacros(src) {
        var ALL = [
          { key: "AR_OBFUSCATED",      label: "AR_OBFUSCATED",      desc: "Compile-time true flag" },
          { key: "AR_LINE",            label: "AR_LINE",             desc: "Inlined line number" },
          { key: "AR_ENCSTR",          label: "AR_ENCSTR(…)",        desc: "String pool encryption" },
          { key: "AR_ENCNUM",          label: "AR_ENCNUM(…)",        desc: "Number encoding" },
          { key: "AR_OPAQUE",          label: "AR_OPAQUE(…)",        desc: "Opaque predicate" },
          { key: "AR_CRASH",           label: "AR_CRASH()",          desc: "Hard crash injection" },
          { key: "AR_ANTIHOOK_SILENT", label: "AR_ANTIHOOK_SILENT()", desc: "Silent hook check" },
          { key: "AR_ANTIHOOK",        label: "AR_ANTIHOOK()",       desc: "Anti-hook guard" },
          { key: "AR_NO_VIRTUALIZE",   label: "AR_NO_VIRTUALIZE()",  desc: "Skip VM on function" },
          { key: "AR_VIRTUALIZE",      label: "AR_VIRTUALIZE()",     desc: "Force VM on function" },
          { key: "AR_JIT_MAX",         label: "AR_JIT_MAX()",        desc: "Max JIT tier" },
          { key: "AR_VM_MAX",          label: "AR_VM_MAX()",         desc: "Max VM protection" },
        ];
        var found = [];
        var text = src instanceof Uint8Array
          ? new TextDecoder().decode(src)
          : src;
        ALL.forEach(function(m) {
          var re = new RegExp("\\b" + m.key + "\\b");
          if (re.test(text)) found.push(m);
        });
        return found;
      }

      function renderMacroPins(macros) {
        var existing = document.getElementById("macroPins");
        if (existing) existing.remove();
        if (!macros.length) return;
        var wrap = document.createElement("div");
        wrap.id = "macroPins";
        var title = document.createElement("p");
        title.className = "macro-title";
        title.textContent = "Macros detected in source (" + macros.length + ")";
        wrap.appendChild(title);
        var row = document.createElement("div");
        row.className = "macro-row";
        macros.forEach(function(m) {
          var pin = document.createElement("span");
          pin.className = "macro-pin";
          pin.title = m.desc;
          pin.textContent = m.label;
          row.appendChild(pin);
        });
        wrap.appendChild(row);
        outputPanel.insertBefore(wrap, outputPanel.firstChild);
      }

      function finish(result) {
        showBar(false);
        setProcessing(false);
        setStatus("Obfuscated " + fmtSize(bytes.byteLength) + " of source.", "ok");
        output.textContent = result;
        outputPanel.style.display = "block";
        var macros = scanMacros(bytes);
        renderMacroPins(macros);
        outputPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      function fail(msg) {
        showBar(false);
        setProcessing(false);
        setStatus("Failed: " + msg, "err");
      }

      // runs on the main thread when a Worker can't be used (e.g. the page
      // was opened as a local file:// page, which some browsers block workers on)
      function runWithoutWorker(reason) {
        setStatus((reason ? reason + " \u2014 " : "") + "running without a background worker...");
        setTimeout(function () {
          try {
            var result = self.ObfuscateCore.obfuscate(bytes, function (p, label) {
              barFill.style.width = Math.round(p * 100) + "%";
            }, protectionSel.value);
            finish(result);
          } catch (err) {
            fail(String((err && err.message) || err));
          }
        }, 30);
      }

      var canUseWorker = typeof Worker !== "undefined" && window.location.protocol !== "file:";
      if (!canUseWorker) {
        runWithoutWorker(
          window.location.protocol === "file:"
            ? "Can't start a background worker from a local file"
            : "Background workers aren't available here"
        );
        return;
      }

      try {
        if (worker) worker.terminate();
        worker = new Worker("worker.js");
      } catch (err) {
        runWithoutWorker("Couldn't start a background worker");
        return;
      }

      worker.onmessage = function (e) {
        var msg = e.data;
        if (msg.type === "progress") {
          barFill.style.width = Math.round(msg.progress * 100) + "%";
          setStatus(msg.label);
        } else if (msg.type === "done") {
          finish(msg.result);
        } else if (msg.type === "error") {
          fail(msg.error);
        }
      };
      worker.onerror = function () {
        runWithoutWorker("Background worker failed to load");
      };
      // transfer the buffer so a big file doesn't get copied twice
      var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      worker.postMessage({ buffer: buf, mode: protectionSel.value }, [buf]);
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
