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

// render an integer as itself or as a small +,-,* expression that evaluates
// to the exact same value (never division, to avoid any float drift) — pure
// cosmetic noise over literals used for keys/steps/checksums/ids
function numExpr(n) {
  if (Math.abs(n) < 4 || Math.random() < 0.3) return String(n);
  var mode = randInt(0, 2);
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
  var d = randInt(2, 9);
  var q = Math.trunc(n / d);
  var rem = n - q * d;
  return "(" + q + " * " + d + (rem >= 0 ? " + " + rem : " - " + -rem) + ")";
}

// symbol set for decoy string junk; backslash/quote excluded since they'd
// need escaping and add nothing — everything else is fair game
var JUNK_SYMBOLS = "!@#$%^&*-_=+[]{};:,.<>?~";

function randomDistinctInts(count, min, max) {
  var set = new Set();
  while (set.size < count) set.add(randInt(min, max));
  return Array.from(set);
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

function renderVM(setup) {
  var used = setup.used;
  var varDecode = setup.varDecode;
  var steps = setup.steps;
  var varR = uglyName(used);       // register table
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
  out.push("local " + varR + " = {}");
  out.push(varR + "[1] = " + s0.srcName);
  out.push("local " + varProg + " = {");
  out.push("  {" + OP_DECODE + ",2,1," + numExpr(s0.key) + "," + numExpr(s0.step) + "," + numExpr(s0.expected) + "},");
  out.push("  {" + OP_DECODE + ",3,2," + numExpr(s1.key) + "," + numExpr(s1.step) + "," + numExpr(s1.expected) + "},");
  out.push("  {" + OP_DECODE + ",4,3," + numExpr(s2.key) + "," + numExpr(s2.step) + "," + numExpr(s2.expected) + "},");
  out.push("  {" + OP_LOAD + ",5,6,4},");
  out.push("  {" + OP_CHECK + ",5,6},");
  out.push("  {" + OP_CALL + ",5},");
  out.push("}");
  out.push("local " + varPc + " = 1");
  out.push("while " + varProg + "[" + varPc + "] do");
  out.push("  local " + varIns + " = " + varProg + "[" + varPc + "]");
  out.push("  local " + varOp + " = " + varIns + "[1]");
  out.push("  if " + varOp + " == " + numExpr(OP_DECODE) + " then");
  out.push("    " + varR + "[" + varIns + "[2]] = " + varDecode + "(" + varR + "[" + varIns + "[3]]," + varIns + "[4]," + varIns + "[5]," + varIns + "[6])");
  out.push("  elseif " + varOp + " == " + numExpr(OP_LOAD) + " then");
  out.push("    " + varR + "[" + varIns + "[2]], " + varR + "[" + varIns + "[3]] = (loadstring or load)(" + varR + "[" + varIns + "[4]])");
  out.push("  elseif " + varOp + " == " + numExpr(OP_CHECK) + " then");
  out.push("    if not " + varR + "[" + varIns + "[2]] then error('[air] compile failed: ' .. tostring(" + varR + "[" + varIns + "[3]]), 0) end");
  out.push("  elseif " + varOp + " == " + numExpr(OP_CALL) + " then");
  out.push("    " + varR + "[" + varIns + "[2]]()");
  out.push("  end");
  out.push("  " + varPc + " = " + varPc + " + 1");
  out.push("end");
  return out;
}

// mode: "plain" (default) | "cff" | "vm"
function obfuscate(srcBytes, report, mode) {
  mode = mode || "plain";
  report(0.05, "Encoding layer 1...");
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
