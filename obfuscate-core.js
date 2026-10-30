// port of the Luau VM test encoder: three XOR-style layers, shuffled chunk
// storage and a checksum guard. shared by worker.js (background) and app.js
// (fallback when a worker can't be created)

var MOD = 2147483647;

function checksumOf(bytes) {
  var checksum = 0;
  for (var i = 1; i <= bytes.length; i++) {
    var b = bytes[i - 1];
    checksum = (checksum + b * ((i % 251) + 1)) % MOD;
  }
  return checksum;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function encodeLayer(bytes, key, step) {
  var out = new Uint8Array(bytes.length * 2);
  for (var i = 1; i <= bytes.length; i++) {
    var b = (bytes[i - 1] + key + i * step) % 256;
    out[i * 2 - 2] = Math.floor(b / 94) + 33;
    out[i * 2 - 1] = (b % 94) + 33;
  }
  return out;
}

// chunk bytes are always 33-126 (printable ascii); only \ and " need escaping
function bytesToLuaString(bytes, start, end) {
  var s = '"';
  for (var i = start; i < end; i++) {
    var c = bytes[i];
    if (c === 92) s += "\\\\";
    else if (c === 34) s += '\\"';
    else s += String.fromCharCode(c);
  }
  return s + '"';
}

function uglyName(used) {
  var n;
  do {
    var s = "_";
    var len = randInt(6, 14);
    for (var i = 0; i < len; i++) s += String.fromCharCode(randInt(97, 122));
    s += randInt(10000000, 99999999);
    n = s;
  } while (used.has(n));
  used.add(n);
  return n;
}

// Fisher-Yates
function shuffledIndices(n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push(i);
  for (var i = n - 1; i > 0; i--) {
    var j = randInt(0, i);
    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// a handful of inert decoy locals (random name + random value), never
// referenced again, just to break up the parts a reader can skim in order
function junkLines(used, count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    var name = uglyName(used);
    if (Math.random() < 0.5) {
      out.push("local " + name + " = " + randInt(10000, 99999999));
    } else {
      var s = "";
      var len = randInt(4, 10);
      for (var k = 0; k < len; k++) s += String.fromCharCode(randInt(97, 122));
      out.push('local ' + name + ' = "' + s + '"');
    }
  }
  return out;
}

function obfuscate(srcBytes, report) {
  var keyOne = randInt(1, 255), stepOne = randInt(1, 255);
  var keyTwo = randInt(1, 255), stepTwo = randInt(1, 255);
  var keyThree = randInt(1, 255), stepThree = randInt(1, 255);

  report(0.05, "Encoding layer 1...");
  var stageOne = encodeLayer(srcBytes, keyOne, stepOne);
  report(0.25, "Encoding layer 2...");
  var stageTwo = encodeLayer(stageOne, keyTwo, stepTwo);
  report(0.4, "Encoding layer 3...");
  var stageThree = encodeLayer(stageTwo, keyThree, stepThree);

  report(0.55, "Splitting and shuffling chunks...");
  var boundaries = []; // [start, end) in logical (sequential) order
  var cursor = 0;
  while (cursor < stageThree.length) {
    var size = randInt(96, 220);
    var end = Math.min(cursor + size, stageThree.length);
    boundaries.push([cursor, end]);
    cursor = end;
  }
  var n = boundaries.length;
  var order = shuffledIndices(n); // order[k] = which logical chunk sits at physical slot k
  var chunkLiterals = new Array(n);
  var physicalSlotOfLogical = new Array(n); // inverse of `order`
  for (var k = 0; k < n; k++) {
    var logical = order[k];
    var b = boundaries[logical];
    chunkLiterals[k] = bytesToLuaString(stageThree, b[0], b[1]);
    physicalSlotOfLogical[logical] = k;
  }

  report(0.75, "Checksums & loader...");
  var used = new Set();
  var varChunks = uglyName(used);
  var varEncoded = uglyName(used);
  var varDecode = uglyName(used);
  var varInput = uglyName(used);
  var varKey = uglyName(used);
  var varStep = uglyName(used);
  var varExpected = uglyName(used);
  var varOut = uglyName(used);
  var varPc = uglyName(used);
  var varIdx = uglyName(used);
  var varByte = uglyName(used);
  var varDecoded = uglyName(used);
  var varCheck = uglyName(used);
  var varStageOne = uglyName(used);
  var varStageTwo = uglyName(used);
  var varSource = uglyName(used);
  var varLoader = uglyName(used);
  var varCompileError = uglyName(used);

  // varChunks[physicalSlot+1] in logical order, joined with .. so the stored
  // table order (shuffled) never matches the order bytes are actually used in
  var reassembleParts = [];
  for (var j = 0; j < n; j++) {
    reassembleParts.push(varChunks + "[" + (physicalSlotOfLogical[j] + 1) + "]");
  }
  var reassembleExpr = reassembleParts.join(" .. ");

  var checksumStageTwo = checksumOf(stageTwo);
  var checksumStageOne = checksumOf(stageOne);
  var checksumSrc = checksumOf(srcBytes);

  var lines = [
    "-- this file was protected by Air Obfuscator",
  ];
  lines = lines.concat(junkLines(used, randInt(2, 4)));
  lines.push(
    "local " + varChunks + " = {" + chunkLiterals.join(",") + "}",
    "local " + varEncoded + " = " + reassembleExpr,
    "local function " + varDecode + "(" + varInput + "," + varKey + "," + varStep + "," + varExpected + ")",
    "  local " + varOut + " = {}",
    "  local " + varCheck + " = 0",
    "  local " + varPc + " = 1",
    "  while " + varPc + " <= #" + varInput + " do",
    "    local " + varIdx + " = (" + varPc + " + 1) / 2",
    "    local " + varByte + " = (string.byte(" + varInput + "," + varPc + ") - 33) * 94 + string.byte(" + varInput + "," + varPc + " + 1) - 33",
    "    local " + varDecoded + " = (" + varByte + " - " + varKey + " - " + varStep + " * " + varIdx + ") % 256",
    "    " + varCheck + " = (" + varCheck + " + " + varDecoded + " * ((" + varIdx + " % 251) + 1)) % 2147483647",
    "    " + varOut + "[#" + varOut + " + 1] = string.char(" + varDecoded + ")",
    "    " + varPc + " = " + varPc + " + 2",
    "  end",
    "  if " + varCheck + " ~= " + varExpected + " then",
    "    print('[air] payload checksum mismatch; data may be corrupted or modified')",
    "    error('[air] integrity check failed', 0)",
    "  end",
    "  return table.concat(" + varOut + ")",
    "end"
  );
  lines = lines.concat(junkLines(used, randInt(1, 3)));
  lines.push(
    "local " + varStageTwo + " = " + varDecode + "(" + varEncoded + "," + keyThree + "," + stepThree + "," + checksumStageTwo + ")",
    "local " + varStageOne + " = " + varDecode + "(" + varStageTwo + "," + keyTwo + "," + stepTwo + "," + checksumStageOne + ")",
    "local " + varSource + " = " + varDecode + "(" + varStageOne + "," + keyOne + "," + stepOne + "," + checksumSrc + ")",
    "local " + varLoader + ", " + varCompileError + " = (loadstring or load)(" + varSource + ")",
    "if not " + varLoader + " then error('[air] compile failed: ' .. tostring(" + varCompileError + "), 0) end",
    varLoader + "()"
  );

  report(1, "Done");
  return lines.join("\n");
}

self.ObfuscateCore = { obfuscate: obfuscate };
