--[[
  syncwatch.lua — VLC Lua interface for AniTrack SyncWatch
  Based on Syncplay's syncplay.lua protocol.
  
  Install to VLC lua/intf folder. Launch via:
    --extraintf=luaintf --lua-intf=syncwatch
    
  Protocol (line-delimited \n):
  Commands from AniTrack:
    .                        poll state (returns playstate + position)
    set-position: <secs>     seek
    set-playstate: playing   unpause
    set-playstate: paused    pause
    set-rate: <rate>         set playback rate
    load-file: <path>        load a file
    get-duration             get media duration
    get-filepath             get current file path
    get-filename             get current filename
    close-vlc                quit VLC

  Responses to AniTrack:
    playstate: playing|paused|no-input
    position: <secs>|no-input
    duration: <secs>|no-input
    filepath: <path>|no-input
    filename: <name>|no-input
    filepath-change-notification
    inputstate-change: input|no-input
]]

-- Default port — used if --lua-config parsing fails
local port = 4123
local host = "127.0.0.1"
local running = true
local LOOPSLEEP = 2000  -- microseconds

-- Try to read port from config (passed via --lua-config=syncwatch={port="XXXXX"})
local function safe_tonumber(str)
    if str == nil then return nil end
    local s, i, d = tostring(str):match("^([+-]?)(%d*)%.?(%d*)$")
    if not s then return nil end
    if s == "-" then s = -1 else s = 1 end
    i = i == "" and 0 or tonumber(i)
    d = (d == nil or d == "") and 0 or tonumber(d)
    return s * (i + d / (10 ^ #tostring(d == 0 and "" or tostring(d))))
end

if config and config["port"] then
    local p = safe_tonumber(config["port"])
    if p and p > 0 then port = p end
end

vlc.msg.info("[AniTrack] syncwatch.lua starting on port " .. tostring(port))

-- State tracking
local oldFilepath = nil
local oldInputState = nil

local function getInput()
    return vlc.object.input()
end

local function getPlaystate()
    local input = getInput()
    if not input then return "no-input" end
    local status = vlc.playlist.status()
    return status or "no-input"
end

local function getPosition()
    local input = getInput()
    if not input then return "no-input" end
    local t = vlc.var.get(input, "time")
    if t == nil then return "no-input" end
    -- VLC 3+ uses microseconds, VLC 2 uses seconds
    local ver = tonumber(vlc.misc.version():match("^(%d+)")) or 3
    if ver >= 3 then
        return t / 1000000
    end
    return t
end

local function getDuration()
    local input = getInput()
    if not input then return "no-input" end
    local item = vlc.input.item()
    if not item then return "no-input" end
    local d = item:duration()
    if not d or d < 0 then return "no-input" end
    return d
end

local function getFilepath()
    local input = getInput()
    if not input then return "no-input" end
    local item = vlc.input.item()
    if not item then return "no-input" end
    local uri = item:uri()
    if not uri then return "no-input" end
    if uri:find("^file://") then
        return vlc.strings.decode_uri(uri:gsub("^file://", ""))
    end
    return uri
end

local function getFilename()
    local input = getInput()
    if not input then return "no-input" end
    local item = vlc.input.item()
    if not item then return "no-input" end
    local name = item:name()
    return name or "no-input"
end

local function setPosition(secs)
    local input = getInput()
    if not input then return "no-input" end
    local val = tonumber(tostring(secs):gsub(",", "."))
    if not val then return "bad-argument" end
    local ver = tonumber(vlc.misc.version():match("^(%d+)")) or 3
    if ver >= 3 then
        vlc.var.set(input, "time", val * 1000000)
    else
        vlc.var.set(input, "time", val)
    end
    return nil
end

local function setPlaystate(state)
    local input = getInput()
    if not input then return "no-input" end
    local current = vlc.playlist.status()
    if state == "playing" and current ~= "playing" then
        vlc.playlist.pause()
    elseif state == "paused" and current == "playing" then
        vlc.playlist.pause()
    end
    return nil
end

local function setRate(rate)
    local input = getInput()
    if not input then return "no-input" end
    local val = tonumber(tostring(rate):gsub(",", "."))
    if val then
        vlc.var.set(input, "rate", val)
    end
    return nil
end

local function loadFile(path)
    if not path or path == "" then return "bad-argument" end
    local uri = vlc.strings.make_uri(path)
    vlc.playlist.add({{path = uri}})
    return "load-file-attempted\n"
end

local function poll()
    local out = ""
    local input = getInput()
    local newInputState = input and "input" or "no-input"

    -- Detect filepath change
    if input then
        local fp = getFilepath()
        if fp ~= oldFilepath then
            oldFilepath = fp
            out = out .. "filepath-change-notification\n"
        end
    end

    -- Detect input state change
    if newInputState ~= oldInputState then
        oldInputState = newInputState
        out = out .. "inputstate-change: " .. newInputState .. "\n"
    end

    -- Always send playstate and position
    out = out .. "playstate: " .. getPlaystate() .. "\n"
    out = out .. "position: " .. tostring(getPosition()) .. "\n"

    return out
end

local function doCommand(cmd, arg)
    if cmd == "." then
        return poll()
    elseif cmd == "get-duration" then
        return "duration: " .. tostring(getDuration()) .. "\n"
    elseif cmd == "get-filepath" then
        return "filepath: " .. tostring(getFilepath()) .. "\n"
    elseif cmd == "get-filename" then
        return "filename: " .. tostring(getFilename()) .. "\n"
    elseif cmd == "set-position" then
        local err = setPosition(arg)
        if err then return "set-position-error: " .. err .. "\n" end
        return ""
    elseif cmd == "set-playstate" then
        local err = setPlaystate(arg)
        if err then return "set-playstate-error: " .. err .. "\n" end
        return ""
    elseif cmd == "set-rate" then
        setRate(arg)
        return ""
    elseif cmd == "load-file" then
        return loadFile(arg) or ""
    elseif cmd == "close-vlc" then
        running = false
        vlc.misc.quit()
        return ""
    else
        return cmd .. "-error: unknown-command\n"
    end
end

-- Start TCP server
local server = vlc.net.listen_tcp(host, port)
vlc.msg.info("[AniTrack] Hosting SyncWatch interface on port: " .. tostring(port))

while running do
    local fd = server:accept()
    if fd >= 0 then
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
                if line ~= "" then
                    local sep = line:find(": ")
                    local cmd, arg
                    if sep then
                        cmd = line:sub(1, sep - 1)
                        arg = line:sub(sep + 2)
                    else
                        cmd = line
                        arg = ""
                    end
                    outbuf = outbuf .. doCommand(cmd, arg)
                end
            end
            if outbuf ~= "" then
                vlc.net.send(fd, outbuf)
            end
            vlc.misc.mwait(vlc.misc.mdate() + LOOPSLEEP)
        end
    end
end
