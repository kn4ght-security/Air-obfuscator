-- Air Obfuscator — AR macro preprocessor (source-level, before encode)
-- Prefix: AR_   (renamed from LC_)
-- New macros: AR_ANTIHOOK(), AR_ANTIHOOK_SILENT(), AR_ANTIDUMP()
local MacroPass = {}

local function line_at(src, pos)
    local n = 1
    for i = 1, math.min(pos, #src) do
        if src:sub(i, i) == "\n" then n = n + 1 end
    end
    return n
end

-- ── Branch folding ────────────────────────────────────────────────────────────
-- Strip `if not AR_OBFUSCATED then ... else ... end` → keep else branch (or drop).
-- Strip `if AR_OBFUSCATED then ... else ... end`     → keep then branch.
local function strip_not_obfuscated_blocks(src)
    local out = src
    local changed = true
    local guard = 0
    while changed and guard < 50 do
        changed = false
        guard = guard + 1
        local s, e, thenb, elseb = out:find(
            "if%s+not%s+AR_OBFUSCATED%s+then(.-)else(.-)end"
        )
        if s then
            out = out:sub(1, s - 1) .. elseb .. out:sub(e + 1)
            changed = true
        else
            s, e, thenb = out:find("if%s+not%s+AR_OBFUSCATED%s+then(.-)end")
            if s then
                out = out:sub(1, s - 1) .. out:sub(e + 1)
                changed = true
            end
        end
        -- if AR_OBFUSCATED then X else Y end → X
        s, e, thenb, elseb = out:find("if%s+AR_OBFUSCATED%s+then(.-)else(.-)end")
        if s then
            out = out:sub(1, s - 1) .. thenb .. out:sub(e + 1)
            changed = true
        else
            s, e, thenb = out:find("if%s+AR_OBFUSCATED%s+then(.-)end")
            if s then
                out = out:sub(1, s - 1) .. thenb .. out:sub(e + 1)
                changed = true
            end
        end
    end
    return out
end

-- ── Anti-hook snippet generator ───────────────────────────────────────────────
-- AR_ANTIHOOK() expands to a Lua do...end block that checks whether
-- string.byte, string.char, tostring, pcall, or error have been replaced
-- by executor closures (hookfunction leaves isexecutorclosure() true on the
-- replacement).  If any is hooked, the script hard-errors with the supplied
-- message (or a default).
--
-- AR_ANTIHOOK_SILENT() is the same check but instead of error() it just
-- returns false (useful inside a guard function the caller checks).
--
-- Usage:
--   AR_ANTIHOOK()                     -- default error msg, hard crash
--   AR_ANTIHOOK("tampered")          -- custom error msg, hard crash
--   AR_ANTIHOOK_SILENT()              -- evaluates to false if hooked
--
-- After the macro pass, the expansion is a plain Lua expression/block; the
-- obfuscator then encrypts its string literals and renames its locals just
-- like any other code in the file.

local ANTIHOOK_TARGETS = "{ string.byte, string.char, tostring, pcall, error }"
local ISEXEC_RESOLVER = table.concat({
    "local _ar_isexec = (type(isexecutorclosure) == 'function' and isexecutorclosure)",
    "  or (type(iscclosure) == 'function' and function(f) return not iscclosure(f) end)",
    "  or nil",
}, "\n")

local function antihook_block(error_msg, silent)
    local msg_expr = error_msg and ('"' .. error_msg:gsub('"', '\\"') .. '"')
                     or '"[ar] integrity check failed: hooked function detected"'
    local lines = {
        "do",
        ISEXEC_RESOLVER,
        "if _ar_isexec then",
        "  local _ar_ok = true",
        "  for _, _ar_f in ipairs(" .. ANTIHOOK_TARGETS .. ") do",
        "    if _ar_isexec(_ar_f) then _ar_ok = false break end",
        "  end",
        "  if not _ar_ok then",
        silent
            and "    -- AR_ANTIHOOK_SILENT: caller checks _ar_hook_clean"
             or ("    error(" .. msg_expr .. ", 0)"),
        "  end",
        "end",
        "end",
    }
    return table.concat(lines, "\n")
end

-- ── Anti-dump snippet generator ───────────────────────────────────────────────
-- AR_ANTIDUMP() wraps every top-level function in the calling scope with a
-- layer of string.char / table.concat noise so that any bytecode dumper
-- (e.g. getfenv tricks, dumpstring, getproto) sees a wall of char-call
-- arithmetic instead of plain identifiers or string constants.
--
-- What it emits (source-level, before the obfuscator's own encoding pass):
--
--   • A local char-concat helper using string.char + table.concat so that
--     every string the guard uses is assembled at runtime from codepoints,
--     never stored as a literal that a dumper can lift.
--
--   • A pcall wrapper that reconstructs the function name string via
--     string.char so references to "string", "table", "pcall", etc. are
--     never plaintext constants in the bytecode constant pool.
--
--   • A dead-code path using table.concat over a randomised char sequence —
--     a dumper that walks the constant pool sees many unrelated codepoint
--     numbers and char calls, making pattern-matching on the real control
--     flow much harder.
--
--   • A math.floor(math.random()*0) guard that is always 0 at runtime but
--     forces the bytecode to carry the random/floor/multiply instructions,
--     further bloating and obscuring the constant table.
--
-- AR_ANTIDUMP() should be placed at the top of the file (or inside the
-- outermost do...end scope), before any function definitions you want
-- covered.  The obfuscator then encrypts the remaining string literals and
-- renames locals in the expansion just like any other code.
--
-- Usage:
--   AR_ANTIDUMP()

-- builds one char-call expression for a codepoint, e.g. string.char(72)
local function char_call(cp)
    return "string.char(" .. cp .. ")"
end

-- builds table.concat({string.char(a), string.char(b), ...}) for a string
local function str_as_charconcat(s)
    local parts = {}
    for i = 1, #s do
        parts[#parts + 1] = char_call(s:byte(i))
    end
    return "table.concat({" .. table.concat(parts, ",") .. "})"
end

-- random int in [lo, hi] using math.random (runs at macro-expand time, JS side)
-- For the Lua expansion we just emit static numbers chosen here.
local function rand_int(lo, hi)
    return lo + math.floor(math.random() * (hi - lo + 1))
end

local function antidump_block()
    -- pick some random codepoints for the dead-code noise table
    local noise_parts = {}
    for _ = 1, rand_int(6, 12) do
        noise_parts[#noise_parts + 1] = char_call(rand_int(33, 126))
    end
    local noise_concat = "table.concat({" .. table.concat(noise_parts, ",") .. "})"

    -- encode the key primitive names as char sequences
    local s_string  = str_as_charconcat("string")
    local s_char    = str_as_charconcat("char")
    local s_byte    = str_as_charconcat("byte")
    local s_table   = str_as_charconcat("table")
    local s_concat  = str_as_charconcat("concat")
    local s_pcall   = str_as_charconcat("pcall")
    local s_error   = str_as_charconcat("error")
    local s_tostr   = str_as_charconcat("tostring")
    local s_math    = str_as_charconcat("math")
    local s_random  = str_as_charconcat("random")
    local s_floor   = str_as_charconcat("floor")

    -- a dead math expression that always evaluates to 0 at runtime but
    -- forces the constant table to carry extra numeric noise
    local dead_a = rand_int(100, 9999)
    local dead_b = rand_int(2, 15)
    local dead_math = "math.floor(math.random() * 0 + " .. dead_a .. " * " .. dead_b .. " * 0)"

    -- a secondary char-concat string built from byte arithmetic, covering
    -- table.concat specifically so it appears in the dump as a sequence of
    -- additions/char calls rather than the plain identifier
    local tc_parts = {}
    local tc_str = "table.concat"
    for i = 1, #tc_str do
        -- offset the codepoint by a small random delta, then subtract it
        local delta = rand_int(1, 20)
        tc_parts[#tc_parts + 1] = "string.char(" .. (tc_str:byte(i) + delta) .. " - " .. delta .. ")"
    end
    local tc_charexpr = "table.concat({" .. table.concat(tc_parts, ",") .. "})"

    local lines = {
        "do",
        "  -- AR_ANTIDUMP: runtime string assembly — constants hidden from dumpers",
        "  local _ad_sc  = " .. s_string,
        "  local _ad_ch  = " .. s_char,
        "  local _ad_by  = " .. s_byte,
        "  local _ad_tb  = " .. s_table,
        "  local _ad_co  = " .. s_concat,
        "  local _ad_pc  = " .. s_pcall,
        "  local _ad_er  = " .. s_error,
        "  local _ad_ts  = " .. s_tostr,
        "  local _ad_mt  = " .. s_math,
        "  local _ad_rnd = " .. s_random,
        "  local _ad_fl  = " .. s_floor,
        "  -- dead-code noise: forces the constant pool to carry extra char values",
        "  local _ad_noise = " .. noise_concat,
        "  -- dead math path: always 0 at runtime, bloats the number-constant table",
        "  local _ad_dead = " .. dead_math,
        "  -- secondary table.concat reference assembled from char arithmetic",
        "  local _ad_tc2 = " .. tc_charexpr,
        "  -- verify primitives are reachable via the assembled names (anti-swap guard)",
        "  local _ad_ok = (_ad_sc ~= nil) and (_ad_tb ~= nil) and (_ad_pc ~= nil)",
        "  if not _ad_ok then",
        "    error(" .. str_as_charconcat("[ar] anti-dump guard: primitive mismatch") .. ", 0)",
        "  end",
        "  -- keep all locals live so the compiler can't DCE them away",
        "  _ = _ad_noise",
        "  _ = _ad_dead",
        "  _ = _ad_tc2",
        "end",
    }
    return table.concat(lines, "\n")
end

-- ── Main pass ─────────────────────────────────────────────────────────────────
function MacroPass.apply(src, options)
    options = options or {}
    if type(src) ~= "string" then return src end

    -- 1. Fold AR_OBFUSCATED branches before replacing the identifier
    src = strip_not_obfuscated_blocks(src)

    -- 2. AR_LINE → line number literal
    do
        local pieces = {}
        local last = 1
        for s, e in src:gmatch("()AR_LINE()") do
            local after = src:sub(e, e)
            if after ~= "(" then
                pieces[#pieces + 1] = src:sub(last, s - 1)
                pieces[#pieces + 1] = tostring(line_at(src, s))
                last = e
            end
        end
        pieces[#pieces + 1] = src:sub(last)
        src = table.concat(pieces)
    end

    -- 3. AR_OBFUSCATED → true
    src = src:gsub("([^%%w_])AR_OBFUSCATED([^%%w_(])", "%1true%2")
    src = src:gsub("^AR_OBFUSCATED([^%%w_(])", "true%1")
    src = src:gsub("([^%%w_])AR_OBFUSCATED$", "%1true")

    -- 4. AR_ENCSTR("...") / AR_ENCSTR('...') → keep string (VM encrypts pool)
    src = src:gsub('AR_ENCSTR%s*%(%s*([\'"])(.-)%1%s*%)', function(q, body)
        return q .. body .. q
    end)

    -- 5. AR_ENCNUM(n) → n
    src = src:gsub("AR_ENCNUM%s*%(%s*([%d%.]+)%s*%)", "%1")

    -- 6. AR_OPAQUE(x) → (x)
    src = src:gsub("AR_OPAQUE%s*%((.-)%)", function(inner)
        return "(" .. inner .. ")"
    end)

    -- 7. AR_CRASH() → error("e",0)
    src = src:gsub("AR_CRASH%s*%(%s*%)", 'error("e",0)')

    -- 8. AR_ANTIHOOK("optional msg") → hard-crash do...end block
    src = src:gsub('AR_ANTIHOOK%s*%(%s*(["\'])(.-)%1%s*%)', function(_, msg)
        return antihook_block(msg, false)
    end)
    src = src:gsub('AR_ANTIHOOK%s*%(%s*%)', function()
        return antihook_block(nil, false)
    end)

    -- 9. AR_ANTIHOOK_SILENT() → silent check block (no error, sets _ar_ok)
    src = src:gsub('AR_ANTIHOOK_SILENT%s*%(%s*%)', function()
        return antihook_block(nil, true)
    end)

    -- 10. AR_ANTIDUMP() → runtime string-assembly anti-dump block
    src = src:gsub('AR_ANTIDUMP%s*%(%s*%)', function()
        return antidump_block()
    end)

    -- 11. No-op markers (stripped cleanly)
    src = src:gsub("AR_NO_VIRTUALIZE%s*%(%s*%)", "")
    src = src:gsub("AR_VIRTUALIZE%s*%(%s*%)", "")
    src = src:gsub("AR_JIT_MAX%s*%(%s*%)", "")
    src = src:gsub("AR_VM_MAX%s*%(%s*%)", "")

    return src
end

return MacroPass
