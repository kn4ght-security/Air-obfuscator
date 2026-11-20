-- Air Obfuscator — AR macro preprocessor (source-level, before encode)
-- Prefix: AR_   (renamed from LC_)
-- New macros: AR_ANTIHOOK(), AR_ANTIHOOK_SILENT()
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

    -- 10. No-op markers (stripped cleanly)
    src = src:gsub("AR_NO_VIRTUALIZE%s*%(%s*%)", "")
    src = src:gsub("AR_VIRTUALIZE%s*%(%s*%)", "")
    src = src:gsub("AR_JIT_MAX%s*%(%s*%)", "")
    src = src:gsub("AR_VM_MAX%s*%(%s*%)", "")

    return src
end

return MacroPass
