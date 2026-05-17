--[[
  syncwatch.lua — VLC Lua interface for AniTrack SyncWatch
  Installed automatically by AniTrack to VLC's lua/intf folder.
  Launched via: --extraintf=luaintf --lua-intf=syncwatch

  Protocol (line-delimited, \n terminated):
    Commands (AniTrack → VLC):
      .                          → poll state
      set-position: <secs>       → seek
      set-playstate: playing     → play
      set-playstate: paused      → pause
      set-rate: <rate>           → set speed
      load-file: <path>          → load file
      get-duration               → get duration
      get-filepath               → get filepath
      close-vlc                  → quit VLC

    Responses (VLC → AniTrack):
      playstate: playing|paused|no-input
      position: <secs>|no-input
      duration: <secs>|no-input
      filepath: <path>|no-input
      filepath-change-notification
      inputstate-change: input|no-input
      load-file-attempted
]]

local host = "127.0.0.1"
local port = 4123
local running = true
local loopsleepduration = 5000 -- microseconds per loop tick
local noinput = "no-input"

-- Parse port from config
local function safe_tonumber(str)
    if str == nil then return nil end
    str = tostring(str):gsub("[^0-9]", ".")
    local s, i, d = str:match("^([+-]?)(%d*)%.?(%d*)$")
    if not s or not i or not d then return nil end
    if s == "-" then s = -1 else s = 1 end
    if i == "" then i = "0" end
    if d == nil or d == "" then d = "0" end
    return s * (tonumber(i) + tonumber(d) / (10 ^ #d))
end

if config and config["port"] then
    local p = safe_tonumber(config["port"])
    if p and p > 0 then port = p end
end

-- State tracking for change detection
local old_filepath = nil
local old_inputstate = nil

local function get_input()
    return vlc.object.input()
end

local function get_playstate()
    if get_input() then
        return vlc.playlist.status()
    end
    return noinput
end

local function get_position()
    local input = get_input()
    if not input then return noinput end
    local t = vlc.var.get(input, "time")
    if t == nil then return noinput end
    -- VLC 3+ returns microseconds, VLC 2 returns seconds
    local vlcver = tonumber(vlc.misc.version():sub(1,1)) or 3
    if vlcver >= 3 then
        return t / 1000000
    end
    return t
end

local function get_duration()
    local input = get_input()
    if not input then return noinput end
    local item = vlc.input.item()
    if not item then return noinput end
    local d = item:duration()
    if not d or d < 0 then return noinput end
    return d
end

local function get_filepath()
    local input = get_input()
    if not input then return noinput end
    local item = vlc.input.item()
    if not item then return noinput end
    local uri = item:uri()
    if uri and uri:find("file://") then
        return vlc.strings.decode_uri(uri)
    end
    return uri or noinput
end

local function set_position(secs)
    local input = get_input()
    if not input then return noinput end
    local vlcver = tonumber(vlc.misc.version():sub(1,1)) or 3
    local val = safe_tonumber(secs)
    if not val then return "bad-argument" end
    if vlcver >= 3 then
        vlc.var.set(input, "time", val * 1000000)
    else
        vlc.var.set(input, "time", val)
    end
    return nil
end

local function set_playstate(state)
    local input = get_input()
    if not input then return noinput end
    local current = vlc.playlist.status()
    if state == "playing" and current ~= "playing" then
        vlc.playlist.pause()
    elseif state == "paused" and current == "playing" then
        vlc.playlist.pause()
    end
    return nil
end

local function load_file(filepath)
    if not filepath or filepath == "" then return "bad-argument" end
    local uri = vlc.strings.make_uri(filepath)
    vlc.playlist.add({{path=uri}})
    return "load-file-attempted\n"
end

local function poll()
    local out = ""
    local input = get_input()
    local new_inputstate = input and "input" or noinput

    -- filepath change detection
    if input then
        local fp = get_filepath()
        if fp ~= old_filepath then
            old_filepath = fp
            out = out .. "filepath-change-notification\n"
        end
    end

    -- inputstate change detection
    if new_inputstate ~= old_inputstate then
        old_inputstate = new_inputstate
        out = out .. "inputstate-change: " .. new_inputstate .. "\n"
    end

    -- always send playstate and position
    local ps = get_playstate()
    local pos = get_position()
    out = out .. "playstate: " .. tostring(ps) .. "\n"
    out = out .. "position: " .. tostring(pos) .. "\n"

    return out
end

local function do_command(cmd, arg)
    if cmd == "." then
        return poll()
    elseif cmd == "get-duration" then
        return "duration: " .. tostring(get_duration()) .. "\n"
    elseif cmd == "get-filepath" then
        return "filepath: " .. tostring(get_filepath()) .. "\n"
    elseif cmd == "set-position" then
        local err = set_position(arg)
        if err then return "set-position-error: " .. err .. "\n" end
        return ""
    elseif cmd == "set-playstate" then
        local err = set_playstate(arg)
        if err then return "set-playstate-error: " .. err .. "\n" end
        return ""
    elseif cmd == "set-rate" then
        local input = get_input()
        if input then
            local r = safe_tonumber(arg)
            if r then vlc.var.set(input, "rate", r) end
        end
        return ""
    elseif cmd == "load-file" then
        return load_file(arg) or ""
    elseif cmd == "close-vlc" then
        running = false
        vlc.misc.quit()
        return ""
    else
        return cmd .. "-error: unknown-command\n"
    end
end

-- Start TCP server
vlc.msg.info("[AniTrack] syncwatch.lua starting on port " .. port)
local server = vlc.net.listen_tcp(host, port)
vlc.msg.info("[AniTrack] Hosting SyncWatch interface on port: " .. port)

while running do
    local fd = server:accept()
    local inbuf = ""

    while fd >= 0 and running do
        local data = vlc.net.recv(fd, 4096)
        if data == nil then break end

        inbuf = inbuf .. data:gsub("\r", "")
        local outbuf = ""

        while true do
            local nl = inbuf:find("\n")
            if not nl then break end
            local line = inbuf:sub(1, nl - 1)
            inbuf = inbuf:sub(nl + 1)

            local cmd, arg
            local sep = line:find(": ")
            if sep then
                cmd = line:sub(1, sep - 1)
                arg = line:sub(sep + 2)
            else
                cmd = line
                arg = ""
            end

            if cmd ~= "" then
                outbuf = outbuf .. do_command(cmd, arg)
            end
        end

        if outbuf ~= "" then
            vlc.net.send(fd, outbuf)
        end

        vlc.misc.mwait(vlc.misc.mdate() + loopsleepduration)
    end
end
