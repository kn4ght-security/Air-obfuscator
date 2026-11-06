// port of the Luau VM test encoder: three XOR-style layers, shuffled chunk
// storage, a checksum guard, plus optional control-flow flattening or a
// tiny bytecode VM for the final load/run sequence.
// shared by worker.js (background) and app.js (fallback when a worker can't be created)

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
    var r = Math.random();
    if (r < 0.4) {
      out.push("local " + name + " = " + numExpr(randInt(10000, 99999999)));
    } else if (r < 0.7) {
      // letters
      var s = "";
      var len = randInt(4, 10);
      for (var k = 0; k < len; k++) s += String.fromCharCode(randInt(97, 122));
      out.push('local ' + name + ' = "' + s + '"');
    } else {
      // mixed letters + symbols, pure noise, never read back
      var s2 = "";
      var len2 = randInt(5, 12);
      for (var k2 = 0; k2 < len2; k2++) {
        s2 += Math.random() < 0.5
          ? String.fromCharCode(randInt(97, 122))
          : JUNK_SYMBOLS[randInt(0, JUNK_SYMBOLS.length - 1)];
      }
      out.push('local ' + name + ' = "' + s2 + '"');
    }
  }
  return out;
}

// render an integer as itself or as an expression that evaluates to the
// exact same value — cosmetic noise over literals used for keys/steps/
// checksums/ids, and (via protectLiterals) the user's own number literals.
// 5 modes, 2 of them (zero-product / mul-div) catph-style anti-dump patterns:
// a bytecode constant dumper just sees a pile of unrelated-looking integers
// per obfuscated literal instead of one constant that equals the real value.
function numExpr(n) {
  if (Math.abs(n) < 4 || Math.random() < 0.3) return String(n);
  var mode = randInt(0, n > 0 ? 4 : 3);
  if (mode === 0) {
    var a = randInt(1, Math.min(9999, Math.abs(n) + 500));
    var b = n - a;
    return "(" + a + (b >= 0 ? " + " + b : " - " + -b) + ")";
  }
  if (mode === 1) {
    var a2 = n + randInt(1, 500);
    var b2 = a2 - n;
    return "(" + a2 + " - " + b2 + ")";
  }
  if (mode === 2) {
    var d = randInt(2, 9);
    var q = Math.trunc(n / d);
    var rem = n - q * d;
    return "(" + q + " * " + d + (rem >= 0 ? " + " + rem : " - " + -rem) + ")";
  }
  if (mode === 3) {
    // zero-product shield: (((A ^ B) + C) * 0) + n — A, B, C are random,
    // A^B+C is a large finite float computed at runtime, * 0 collapses it
    // to exactly 0 (IEEE-754: finite * 0 = 0), leaving n. A reader has to
    // evaluate the whole exponent subtree just to confirm it's inert.
    var A = randInt(100, 0xffff), B = randInt(2, 12), C = randInt(1, 0xffff);
    return "((((" + A + " ^ " + B + ") + " + C + ") * 0) + " + n + ")";
  }
  // mode 4 (n > 0 only): multiply/divide cancellation, n*K / K. K is kept
  // small enough relative to n that n*K stays well inside the 2^53 exact-
  // integer range for doubles, so the division has no rounding drift.
  var kMax = Math.max(2, Math.min(32, Math.floor(0xffffff / (n + 1))));
  var K = randInt(2, kMax);
  return "((" + n + " * " + K + ") / " + K + ")";
}

// symbol set for decoy string junk; backslash/quote excluded since they'd
// need escaping and add nothing — everything else is fair game
var JUNK_SYMBOLS = "!@#$%^&*-_=+[]{};:,.<>?~";

function randomDistinctInts(count, min, max) {
  var set = new Set();
  while (set.size < count) set.add(randInt(min, max));
  return Array.from(set);
}

// --- source-level pass: tokenize the actual Luau, encrypt string literals
// and turn integer literals into arithmetic (catph calls these EncryptStrings
// / NumbersToExpressions). Runs BEFORE the byte-level wrapping below, so the
// script's own literals are no longer sitting in the output in the clear —
// previously only the outer loader shell was obfuscated, not the source text
// the loader carries. Anything we're not fully sure how to rebuild exactly
// (escaped strings, hex/float numbers) is left untouched rather than risk
// corrupting the script.

function tokenizeLua(src) {
  var tokens = [];
  var i = 0, len = src.length;
  var isDigit = function (c) { return c >= "0" && c <= "9"; };
  var isHex = function (c) { return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"); };
  var isNameStart = function (c) { return c === "_" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z"); };
  var isNameChar = function (c) { return isNameStart(c) || isDigit(c); };

  function longBracketLevel(at) {
    // src[at] === '['; returns level (count of '=') if this is a long-bracket
    // opener, else -1
    var j = at + 1, eq = 0;
    while (src[j] === "=") { eq++; j++; }
    if (src[j] === "[") return eq;
    return -1;
  }
  function readLongBracket(at, level) {
    // at points at the opening '['; returns end index just past the closer
    var j = at + 2 + level;
    if (src[j] === "\n") j++; // Lua skips a leading newline
    var closer = "]" + new Array(level + 1).join("=") + "]";
    var close = src.indexOf(closer, j);
    if (close === -1) return len;
    return close + closer.length;
  }

  while (i < len) {
    var c = src[i];

    if (c === "-" && src[i + 1] === "-") {
      var start = i;
      i += 2;
      if (src[i] === "[") {
        var lvl = longBracketLevel(i);
        if (lvl >= 0) { i = readLongBracket(i, lvl); tokens.push({ t: "other", s: start, e: i }); continue; }
      }
      while (i < len && src[i] !== "\n") i++;
      tokens.push({ t: "other", s: start, e: i });
      continue;
    }

    if (c === "[" ) {
      var lvl2 = longBracketLevel(i);
      if (lvl2 >= 0) {
        var s2 = i;
        i = readLongBracket(i, lvl2);
        tokens.push({ t: "other", s: s2, e: i }); // long strings left alone (rare, risky to rewrite)
        continue;
      }
    }

    if (c === '"' || c === "'") {
      var quote = c, s3 = i, hasEscape = false;
      i++;
      while (i < len && src[i] !== quote) {
        if (src[i] === "\\") { hasEscape = true; i += 2; continue; }
        if (src[i] === "\n") break; // unterminated on this line; bail out as plain text
        i++;
      }
      i++; // consume closing quote (or just stop if unterminated)
      tokens.push({ t: hasEscape ? "other" : "string", s: s3, e: i, inner: [s3 + 1, i - 1] });
      continue;
    }

    if (isDigit(c)) {
      var s4 = i;
      var isHexNum = c === "0" && (src[i + 1] === "x" || src[i + 1] === "X");
      if (isHexNum) {
        i += 2;
        while (i < len && isHex(src[i])) i++;
      } else {
        while (i < len && isDigit(src[i])) i++;
        if (src[i] === "." ) { i++; while (i < len && isDigit(src[i])) i++; }
        if (src[i] === "e" || src[i] === "E") {
          i++;
          if (src[i] === "+" || src[i] === "-") i++;
          while (i < len && isDigit(src[i])) i++;
        }
      }
      var text = src.slice(s4, i);
      var isPlainInt = !isHexNum && /^[0-9]+$/.test(text);
      tokens.push({ t: isPlainInt ? "number" : "other", s: s4, e: i, val: isPlainInt ? parseInt(text, 10) : null });
      continue;
    }

    if (isNameStart(c)) {
      var s5 = i;
      i++;
      while (i < len && isNameChar(src[i])) i++;
      tokens.push({ t: "other", s: s5, e: i });
      continue;
    }

    tokens.push({ t: "other", s: i, e: i + 1 });
    i++;
  }
  return tokens;
}

function luaStringEncodeCall(decoderName, text) {
  var key = randInt(1, 255);
  var parts = [String(key)];
  for (var i = 0; i < text.length; i++) {
    parts.push(String((text.charCodeAt(i) + key) % 256));
  }
  return decoderName + "({" + parts.join(",") + "})";
}

// encrypts eligible string literals and turns integer literals into
// equivalent arithmetic, directly in the Luau source text
function protectLiterals(src, used) {
  var tokens = tokenizeLua(src);
  var decoderName = uglyName(used);
  var out = [];
  var last = 0;
  var touchedString = false;

  for (var k = 0; k < tokens.length; k++) {
    var tok = tokens[k];
    if (tok.t === "string") {
      var text = src.slice(tok.inner[0], tok.inner[1]);
      // skip empty strings and anything that isn't plain ASCII content —
      // keeps the rebuild exact without needing a full escape decoder
      if (text.length > 0 && /^[\x20-\x7e]*$/.test(text)) {
        out.push(src.slice(last, tok.s));
        out.push(luaStringEncodeCall(decoderName, text));
        last = tok.e;
        touchedString = true;
      }
    } else if (tok.t === "number") {
      out.push(src.slice(last, tok.s));
      out.push(numExpr(tok.val));
      last = tok.e;
    }
  }
  out.push(src.slice(last));

  var body = out.join("");
  if (!touchedString) return body; // no decoder needed if nothing used it

  var decoderDef =
    "local function " + decoderName + "(t)\n" +
    "\tlocal k = t[1]\n" +
    "\tlocal r = {}\n" +
    "\tfor i = 2, #t do\n" +
    "\t\tr[i - 1] = string.char((t[i] - k) % 256)\n" +
    "\tend\n" +
    "\treturn table.concat(r)\n" +
    "end\n";
  return decoderDef + body;
}

// --- runtime anti-tamper prelude --------------------------------------------
// A layer on top of the existing checksum guard (which only catches corrupted
// *bytes*). This verifies the handful of functions the decoder itself leans
// on — pcall/error/table.unpack — still behave the way Lua defines them,
// before any decoding happens. If something upstream has patched pcall to
// swallow errors, or error() to not actually raise, the checksum check could
// be bypassed entirely; this catches that class of tamper instead.
// Deliberately NOT included: anything that fingerprints debuggers/hookers
// (hooked-function scans, getregistry probing, physics-FPS checks, request
// stack-depth probing) — this only asserts the script's own dependencies are
// intact, it doesn't try to detect or punish someone inspecting the script.

function buildAntiTamperPrelude(used) {
  var pcallName = uglyName(used);
  var errName = uglyName(used);
  var selName = uglyName(used);
  var unpackName = uglyName(used);
  var validName = uglyName(used);
  var trials = randInt(10, 18);

  return [
    "local " + pcallName + " = pcall",
    "local " + errName + " = error",
    "local " + selName + " = select",
    "local " + unpackName + " = table.unpack or unpack",
    "do",
    "  local " + validName + " = true",
    "  for _i = 1, " + numExpr(trials) + " do",
    "    local _shouldErr = (_i % 2 == 0)",
    "    local _msg = 'air_at_' .. _i",
    "    local _arr = { " + pcallName + "(function()",
    "      if _shouldErr then " + errName + "(_msg, 0) end",
    "      return " + unpackName + "({ _i, _i * 2, _i * 3 })",
    "    end) }",
    "    local _n = " + selName + "('#', " + unpackName + "(_arr))",
    "    if _shouldErr then",
    "      " + validName + " = " + validName + " and (_arr[1] == false) and (_arr[2] == _msg) and (_n == 2)",
    "    else",
    "      " + validName + " = " + validName + " and (_arr[1] == true) and (_arr[2] == _i) and (_arr[3] == _i * 2) and (_arr[4] == _i * 3) and (_n == 4)",
    "    end",
    "  end",
    "  if (0 / 0) == (0 / 0) then " + validName + " = false end",
    "  if not " + validName + " then",
    "    " + errName + "('[air] runtime integrity check failed', 0)",
    "  end",
    "end",
  ];
}

// --- shared: chunk table + decode function ---------------------------------

function buildDataSetup(srcBytes) {
  var keyOne = randInt(1, 255), stepOne = randInt(1, 255);
  var keyTwo = randInt(1, 255), stepTwo = randInt(1, 255);
  var keyThree = randInt(1, 255), stepThree = randInt(1, 255);

  var stageOne = encodeLayer(srcBytes, keyOne, stepOne);
  var stageTwo = encodeLayer(stageOne, keyTwo, stepTwo);
  var stageThree = encodeLayer(stageTwo, keyThree, stepThree);

  var boundaries = [];
  var cursor = 0;
  while (cursor < stageThree.length) {
    var size = randInt(96, 220);
    var end = Math.min(cursor + size, stageThree.length);
    boundaries.push([cursor, end]);
    cursor = end;
  }
  var n = boundaries.length;
  var order = shuffledIndices(n);
  var chunkLiterals = new Array(n);
  var physicalSlotOfLogical = new Array(n);
  for (var k = 0; k < n; k++) {
    var logical = order[k];
    var b = boundaries[logical];
    chunkLiterals[k] = bytesToLuaString(stageThree, b[0], b[1]);
    physicalSlotOfLogical[logical] = k;
  }

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

  var reassembleParts = [];
  for (var j = 0; j < n; j++) {
    reassembleParts.push(varChunks + "[" + (physicalSlotOfLogical[j] + 1) + "]");
  }
  var reassembleExpr = reassembleParts.join(" .. ");

  var lines = ["-- this file was protected by Air Obfuscator"];
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

  // the 3 decode calls (outer -> inner) + load + run, as an ordered step list
  // consumed by whichever renderer (plain / cff / vm) is selected
  var steps = [
    { kind: "decode", key: keyThree, step: stepThree, expected: checksumOf(stageTwo), srcName: varEncoded },
    { kind: "decode", key: keyTwo, step: stepTwo, expected: checksumOf(stageOne), srcName: null },
    { kind: "decode", key: keyOne, step: stepOne, expected: checksumOf(srcBytes), srcName: null },
    { kind: "load" },
    { kind: "check" },
    { kind: "call" },
  ];

  var atLines = buildAntiTamperPrelude(used);
  lines.splice.apply(lines, [1, 0].concat(atLines));

  return { lines: lines, used: used, varDecode: varDecode, steps: steps };
}

// --- renderer: plain (straight-line, as before) -----------------------------

function renderPlain(setup) {
  var used = setup.used;
  var varDecode = setup.varDecode;
  var steps = setup.steps;
  var varStageTwo = uglyName(used);
  var varStageOne = uglyName(used);
  var varSource = uglyName(used);
  var varLoader = uglyName(used);
  var varErr = uglyName(used);

  var s0 = steps[0], s1 = steps[1], s2 = steps[2];
  var out = [];
  out.push("local " + varStageTwo + " = " + varDecode + "(" + s0.srcName + "," + numExpr(s0.key) + "," + numExpr(s0.step) + "," + numExpr(s0.expected) + ")");
  out.push("local " + varStageOne + " = " + varDecode + "(" + varStageTwo + "," + numExpr(s1.key) + "," + numExpr(s1.step) + "," + numExpr(s1.expected) + ")");
  out.push("local " + varSource + " = " + varDecode + "(" + varStageOne + "," + numExpr(s2.key) + "," + numExpr(s2.step) + "," + numExpr(s2.expected) + ")");
  out.push("local " + varLoader + ", " + varErr + " = (loadstring or load)(" + varSource + ")");
  out.push("if not " + varLoader + " then error('[air] compile failed: ' .. tostring(" + varErr + "), 0) end");
  out.push(varLoader + "()");
  return out;
}

// --- renderer: CFF (control-flow flattening) --------------------------------
// the same 6 steps, but driven by a state variable through a dispatch loop;
// the if/elseif branches are written out in a shuffled order in the source,
// so reading the file top to bottom does not show the real execution order.

function renderCFF(setup) {
  var used = setup.used;
  var varDecode = setup.varDecode;
  var steps = setup.steps;
  var varStageTwo = uglyName(used);
  var varStageOne = uglyName(used);
  var varSource = uglyName(used);
  var varLoader = uglyName(used);
  var varErr = uglyName(used);
  var varState = uglyName(used);

  var s0 = steps[0], s1 = steps[1], s2 = steps[2];
  // locals declared in one state must still be visible in later states, so
  // hoist them above the loop and assign (not `local`) inside each branch
  var hoisted = [varStageTwo, varStageOne, varSource, varLoader, varErr];
  var bodies = [
    "    " + varStageTwo + " = " + varDecode + "(" + s0.srcName + "," + numExpr(s0.key) + "," + numExpr(s0.step) + "," + numExpr(s0.expected) + ")",
    "    " + varStageOne + " = " + varDecode + "(" + varStageTwo + "," + numExpr(s1.key) + "," + numExpr(s1.step) + "," + numExpr(s1.expected) + ")",
    "    " + varSource + " = " + varDecode + "(" + varStageOne + "," + numExpr(s2.key) + "," + numExpr(s2.step) + "," + numExpr(s2.expected) + ")",
    "    " + varLoader + ", " + varErr + " = (loadstring or load)(" + varSource + ")",
    "    if not " + varLoader + " then error('[air] compile failed: ' .. tostring(" + varErr + "), 0) end",
    "    " + varLoader + "()",
  ];

  var n = bodies.length;
  var stateIds = randomDistinctInts(n, 1000, 999999); // state id per logical step, in order
  var order = shuffledIndices(n); // emission order of the if/elseif branches in the source

  var out = [];
  out.push("local " + hoisted.join(", "));
  out.push("local " + varState + " = " + numExpr(stateIds[0]));
  out.push("while " + varState + " ~= 0 do");
  for (var k = 0; k < n; k++) {
    var logical = order[k];
    var nextState = logical + 1 < n ? stateIds[logical + 1] : 0;
    out.push((k === 0 ? "  if " : "  elseif ") + varState + " == " + numExpr(stateIds[logical]) + " then");
    out.push(bodies[logical]);
    out.push("    " + varState + " = " + numExpr(nextState));
  }
  out.push("  end");
  out.push("end");
  return out;
}

// --- renderer: VM (tiny bytecode interpreter) -------------------------------
// the 6 steps become instructions in a program table, run by a small
// register-machine interpreter; opcode numbers are randomized per build.

// VM renderer — a small register-based interpreter in the same shape as a
// real bytecode VM: named instruction fields (op/a/b/c/d/e, not positional
// indices), a register file, and an ISA name table. It only ever runs our
// own fixed 6-instruction loader program (reassemble -> decode x3 -> load ->
// call); it does not compile or virtualize the user's actual script.
function renderVM(setup) {
  var used = setup.used;
  var varDecode = setup.varDecode;
  var steps = setup.steps;
  var varISA = uglyName(used);     // opcode name table (ISA.NAME equivalent)
  var varR = uglyName(used);       // register file
  var varProg = uglyName(used);    // program (instruction list)
  var varPc = uglyName(used);      // program counter
  var varIns = uglyName(used);     // current instruction
  var varOp = uglyName(used);      // current opcode

  var opIds = randomDistinctInts(4, 10, 250);
  var OP_DECODE = opIds[0], OP_LOAD = opIds[1], OP_CHECK = opIds[2], OP_CALL = opIds[3];

  // fixed register roles: 1=encoded(stageThree) 2=stageTwo 3=stageOne
  // 4=source 5=loaderFn 6=err
  var s0 = steps[0], s1 = steps[1], s2 = steps[2];
  var out = [];
  out.push("local " + varISA + " = {[" + OP_DECODE + "]='DECODE',[" + OP_LOAD + "]='LOADSTRING',[" + OP_CHECK + "]='CHECK',[" + OP_CALL + "]='CALL'}");
  out.push("local " + varR + " = {}");
  out.push(varR + "[1] = " + s0.srcName);
  out.push("local " + varProg + " = {");
  out.push("  {op=" + OP_DECODE + ",a=2,b=1,c=" + numExpr(s0.key) + ",d=" + numExpr(s0.step) + ",e=" + numExpr(s0.expected) + "},");
  out.push("  {op=" + OP_DECODE + ",a=3,b=2,c=" + numExpr(s1.key) + ",d=" + numExpr(s1.step) + ",e=" + numExpr(s1.expected) + "},");
  out.push("  {op=" + OP_DECODE + ",a=4,b=3,c=" + numExpr(s2.key) + ",d=" + numExpr(s2.step) + ",e=" + numExpr(s2.expected) + "},");
  out.push("  {op=" + OP_LOAD + ",a=5,b=6,c=4},");
  out.push("  {op=" + OP_CHECK + ",a=5,b=6},");
  out.push("  {op=" + OP_CALL + ",a=5},");
  out.push("}");
  out.push("local " + varPc + " = 1");
  out.push("while " + varProg + "[" + varPc + "] do");
  out.push("  local " + varIns + " = " + varProg + "[" + varPc + "]");
  out.push("  local " + varOp + " = " + varIns + ".op");
  out.push("  if " + varOp + " == " + numExpr(OP_DECODE) + " then");
  out.push("    " + varR + "[" + varIns + ".a] = " + varDecode + "(" + varR + "[" + varIns + ".b]," + varIns + ".c," + varIns + ".d," + varIns + ".e)");
  out.push("  elseif " + varOp + " == " + numExpr(OP_LOAD) + " then");
  out.push("    " + varR + "[" + varIns + ".a], " + varR + "[" + varIns + ".b] = (loadstring or load)(" + varR + "[" + varIns + ".c])");
  out.push("  elseif " + varOp + " == " + numExpr(OP_CHECK) + " then");
  out.push("    if not " + varR + "[" + varIns + ".a] then error('[air] compile failed (' .. tostring(" + varISA + "[" + varOp + "]) .. '): ' .. tostring(" + varR + "[" + varIns + ".b]), 0) end");
  out.push("  elseif " + varOp + " == " + numExpr(OP_CALL) + " then");
  out.push("    " + varR + "[" + varIns + ".a]()");
  out.push("  else");
  out.push("    error('[air] unimplemented opcode ' .. tostring(" + varOp + "))");
  out.push("  end");
  out.push("  " + varPc + " = " + varPc + " + 1");
  out.push("end");
  return out;
}

// --- renderer: VM v2 (two-stage byte encoder + shuffled chunks) ------------
// Uses Uint8Array bytes throughout so UTF-8 Luau source is preserved. This
// replaces only the VM mode; plain and CFF retain their existing pipeline.
function renderVM2(srcBytes, report) {
  var keyOne = randInt(1, 255), stepOne = randInt(1, 255);
  var keyTwo = randInt(1, 255), stepTwo = randInt(1, 255);
  var stageOne = encodeLayer(srcBytes, keyOne, stepOne);
  var stageTwo = encodeLayer(stageOne, keyTwo, stepTwo);

  var minChunk = 48, maxChunk = 160;
  var chunks = [], cursor = 0;
  while (cursor < stageTwo.length) {
    var size = randInt(minChunk, maxChunk);
    var end = Math.min(cursor + size, stageTwo.length);
    chunks.push(stageTwo.slice(cursor, end));
    cursor = end;
  }

  var order = shuffledIndices(chunks.length);
  var physicalSlotOfLogical = new Array(chunks.length);
  var literals = [];
  for (var i = 0; i < order.length; i++) {
    var logical = order[i];
    physicalSlotOfLogical[logical] = i + 1;
    literals.push(bytesToLuaString(chunks[logical], 0, chunks[logical].length));
  }

  var used = new Set();
  var vChunks = uglyName(used), vOrder = uglyName(used);
  var vEncoded = uglyName(used), vDecode = uglyName(used);
  var vInput = uglyName(used), vKey = uglyName(used), vStep = uglyName(used);
  var vExpected = uglyName(used), vOut = uglyName(used);
  var vPc = uglyName(used), vIdx = uglyName(used), vByte = uglyName(used);
  var vDecoded = uglyName(used), vCheck = uglyName(used);
  var vStageOne = uglyName(used), vSource = uglyName(used);
  var vLoader = uglyName(used), vErr = uglyName(used);
  var tag = uglyName(used);

  var orderEntries = [];
  for (var oi = 0; oi < physicalSlotOfLogical.length; oi++) {
    orderEntries.push("[" + (oi + 1) + "]=" + physicalSlotOfLogical[oi]);
  }

  var out = ["-- protected by Air Obfuscator | VM Encode v2"];
  out = out.concat(buildAntiTamperPrelude(used));
  // Inert noise is kept separate from the decoder and never affects execution.
  out = out.concat(junkLines(used, randInt(12, 20)));
  for (var dt = 0, dtn = randInt(1, 3); dt < dtn; dt++) {
    var tableName = uglyName(used), entries = [];
    for (var de = 0, den = randInt(3, 8); de < den; de++) {
      var junk = "";
      for (var jc = 0, jcn = randInt(8, 24); jc < jcn; jc++) junk += String.fromCharCode(randInt(33, 126));
      // Keep generated literals valid even when the random text contains quotes.
      junk = junk.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      entries.push('"' + junk + '"');
    }
    out.push("local " + tableName + " = {" + entries.join(",") + "}");
  }

  out.push("local " + vChunks + " = {" + literals.join(",") + "}");
  out.push("local " + vOrder + " = {" + orderEntries.join(",") + "}");
  var assemble = [];
  for (var ai = 0; ai < physicalSlotOfLogical.length; ai++) {
    assemble.push(vChunks + "[" + vOrder + "[" + (ai + 1) + "]]");
  }
  out.push("local " + vEncoded + " = table.concat({" + assemble.join(",") + "})");
  out.push("local function " + vDecode + "(" + vInput + "," + vKey + "," + vStep + "," + vExpected + ")");
  out.push("  local " + vOut + " = {} local " + vCheck + " = 0 local " + vPc + " = 1");
  out.push("  while " + vPc + " <= #" + vInput + " do");
  out.push("    local " + vIdx + " = (" + vPc + " + 1) / 2");
  out.push("    local " + vByte + " = (string.byte(" + vInput + "," + vPc + ") - 33) * 94 + string.byte(" + vInput + "," + vPc + " + 1) - 33");
  out.push("    local " + vDecoded + " = (" + vByte + " - " + vKey + " - " + vStep + " * " + vIdx + ") % 256");
  out.push("    " + vCheck + " = (" + vCheck + " + " + vDecoded + " * ((" + vIdx + " % 251) + 1)) % 2147483647");
  out.push("    " + vOut + "[#" + vOut + " + 1] = string.char(" + vDecoded + ")");
  out.push("    " + vPc + " = " + vPc + " + 2");
  out.push("  end");
  out.push("  if " + vCheck + " ~= " + vExpected + " then error('[air] " + tag + " payload integrity check failed', 0) end");
  out.push("  return table.concat(" + vOut + ")");
  out.push("end");

  // Decoys are syntactically valid but intentionally unrelated to the payload.
  for (var df = 0, dfn = randInt(2, 3); df < dfn; df++) {
    var fn = uglyName(used), a = uglyName(used), b = uglyName(used), c = uglyName(used);
    out.push("local function " + fn + "(" + a + "," + b + ") local " + c + " = {} for _i=1,#" + a + ",3 do " + c + "[#" + c + "+1] = string.byte(" + a + ",_i) end return #" + c + " end");
  }

  out.push("local " + vStageOne + " = " + vDecode + "(" + vEncoded + "," + keyTwo + "," + stepTwo + "," + checksumOf(stageOne) + ")");
  out.push("local " + vSource + " = " + vDecode + "(" + vStageOne + "," + keyOne + "," + stepOne + "," + checksumOf(srcBytes) + ")");
  out.push("if #" + vSource + " ~= " + srcBytes.length + " then error('[air] decoded source length mismatch', 0) end");
  out.push("local " + vLoader + ", " + vErr + " = (loadstring or load)(" + vSource + ")");
  out.push("if not " + vLoader + " then error('[air] compile failed: ' .. tostring(" + vErr + "), 0) end");
  out.push("return " + vLoader + "()");
  if (report) report(0.9, "Building two-stage VM decoder...");
  return out.join("\n");
}

// mode: "plain" (default) | "cff" | "vm"
function obfuscate(srcBytes, report, mode) {
  mode = mode || "plain";

  report(0.02, "Encrypting strings and numbers...");
  var srcText = new TextDecoder().decode(srcBytes);
  var protectedUsed = new Set();
  var protectedText = protectLiterals(srcText, protectedUsed);
  srcBytes = new TextEncoder().encode(protectedText);

  if (mode === "vm") {
    report(0.1, "Encoding layer 1...");
    report(0.3, "Encoding layer 2...");
    report(0.55, "Splitting and shuffling chunks...");
    var vmResult = renderVM2(srcBytes, report);
    report(1, "Done");
    return vmResult;
  }
  report(0.1, "Encoding layer 1...");
  report(0.25, "Encoding layer 2...");
  report(0.4, "Encoding layer 3...");
  var setup = buildDataSetup(srcBytes);

  report(0.6, "Splitting and shuffling chunks...");
  report(0.75, mode === "cff" ? "Flattening control flow..." : mode === "vm" ? "Building bytecode VM..." : "Writing loader...");

  var tail;
  if (mode === "cff") tail = renderCFF(setup);
  else if (mode === "vm") tail = renderVM(setup);
  else tail = renderPlain(setup);

  var lines = setup.lines.concat(junkLines(setup.used, randInt(1, 3))).concat(tail);
  report(1, "Done");
  return lines.join("\n");
}

self.ObfuscateCore = { obfuscate: obfuscate };
