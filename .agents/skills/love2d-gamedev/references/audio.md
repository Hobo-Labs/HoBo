# Audio

Sound effects, music, and audio management in Love2D.

## Loading Audio

```lua
function love.load()
    -- "static": Load entirely into memory (good for short sounds)
    jumpSound = love.audio.newSource("sounds/jump.wav", "static")

    -- "stream": Stream from disk (good for music)
    music = love.audio.newSource("music/theme.ogg", "stream")
end
```

**Formats supported**: WAV, OGG, MP3, FLAC

**Recommendations**:
- **Sound effects**: WAV (uncompressed, fast loading) or OGG (compressed)
- **Music**: OGG (good compression, quality, and seeking)

## Playing Audio

### Basic Playback

```lua
-- Play sound
jumpSound:play()

-- Play from beginning (even if already playing)
jumpSound:stop()
jumpSound:play()

-- Or use clone for overlapping sounds
jumpSound:clone():play()
```

### Stopping and Pausing

```lua
music:play()
music:pause()   -- Can be resumed
music:stop()    -- Resets to beginning
music:rewind()  -- Same as stop for most sources
```

### Checking State

```lua
if music:isPlaying() then
    -- Audio is currently playing
end

-- Get playback position (seconds)
local position = music:tell()

-- Seek to position
music:seek(30)  -- Jump to 30 seconds
```

## Volume Control

```lua
-- Per-source volume (0 to 1)
music:setVolume(0.5)

-- Global volume
love.audio.setVolume(0.8)

-- Get current volume
local vol = music:getVolume()
```

## Looping

```lua
-- Loop forever
music:setLooping(true)

-- Check if looping
if music:isLooping() then
    -- ...
end
```

## Pitch

Change playback speed (also affects pitch):

```lua
-- Normal pitch
sound:setPitch(1.0)

-- Higher pitch (faster)
sound:setPitch(1.5)

-- Lower pitch (slower)
sound:setPitch(0.8)

-- Random variation for variety
sound:setPitch(0.9 + math.random() * 0.2)
```

## Sound Manager

A centralized audio manager:

```lua
local SoundManager = {
    sounds = {},
    music = nil,
    musicVolume = 0.7,
    sfxVolume = 1.0,
    muted = false
}

function SoundManager:load(name, path, sourceType)
    sourceType = sourceType or "static"
    self.sounds[name] = love.audio.newSource(path, sourceType)
end

function SoundManager:play(name)
    if self.muted then return end

    local sound = self.sounds[name]
    if sound then
        -- Clone for overlapping playback
        local instance = sound:clone()
        instance:setVolume(self.sfxVolume)
        instance:play()
        return instance
    end
end

function SoundManager:playMusic(name, loop)
    if self.music then
        self.music:stop()
    end

    self.music = self.sounds[name]
    if self.music then
        self.music:setVolume(self.musicVolume)
        self.music:setLooping(loop ~= false)
        self.music:play()
    end
end

function SoundManager:stopMusic()
    if self.music then
        self.music:stop()
    end
end

function SoundManager:setMusicVolume(vol)
    self.musicVolume = vol
    if self.music then
        self.music:setVolume(vol)
    end
end

function SoundManager:setSFXVolume(vol)
    self.sfxVolume = vol
end

function SoundManager:mute()
    self.muted = true
    if self.music then
        self.music:pause()
    end
end

function SoundManager:unmute()
    self.muted = false
    if self.music then
        self.music:play()
    end
end

return SoundManager
```

### Usage

```lua
local Sound = require("soundmanager")

function love.load()
    Sound:load("jump", "sounds/jump.wav")
    Sound:load("shoot", "sounds/shoot.wav")
    Sound:load("music", "music/theme.ogg", "stream")

    Sound:playMusic("music")
end

function Player:jump()
    Sound:play("jump")
    -- ...
end
```

## Positional Audio (3D Sound)

For spatial audio effects:

```lua
function love.load()
    -- Set listener position (usually the player/camera)
    love.audio.setPosition(0, 0, 0)
end

function love.update(dt)
    -- Update listener to follow player
    love.audio.setPosition(player.x, player.y, 0)
end

function Enemy:playSound()
    local sound = explosionSound:clone()
    sound:setPosition(self.x, self.y, 0)
    sound:play()
end
```

### Distance Attenuation

```lua
sound:setAttenuationDistances(100, 500)
-- Sound starts fading at 100 units, silent at 500 units
```

## Audio Pools

For frequently played sounds (bullets, footsteps), pre-create instances:

```lua
local AudioPool = {}
AudioPool.__index = AudioPool

function AudioPool:new(source, size)
    local pool = setmetatable({
        source = source,
        instances = {},
        index = 1
    }, AudioPool)

    for i = 1, size do
        pool.instances[i] = source:clone()
    end

    return pool
end

function AudioPool:play()
    local instance = self.instances[self.index]

    -- Stop if still playing
    instance:stop()
    instance:play()

    -- Round-robin to next instance
    self.index = self.index % #self.instances + 1

    return instance
end

-- Usage
function love.load()
    local bulletSource = love.audio.newSource("bullet.wav", "static")
    bulletPool = AudioPool:new(bulletSource, 10)
end

function shootBullet()
    bulletPool:play()
end
```

## Fade Effects

### Fade Out

```lua
local fadeOutSound = nil
local fadeOutDuration = 1
local fadeOutTimer = 0
local fadeOutStartVolume = 0

function startFadeOut(sound, duration)
    fadeOutSound = sound
    fadeOutDuration = duration
    fadeOutTimer = 0
    fadeOutStartVolume = sound:getVolume()
end

function love.update(dt)
    if fadeOutSound then
        fadeOutTimer = fadeOutTimer + dt
        local progress = fadeOutTimer / fadeOutDuration

        if progress >= 1 then
            fadeOutSound:stop()
            fadeOutSound = nil
        else
            fadeOutSound:setVolume(fadeOutStartVolume * (1 - progress))
        end
    end
end
```

### Crossfade

```lua
function crossfade(fromMusic, toMusic, duration)
    local timer = 0
    local fromVol = fromMusic:getVolume()

    toMusic:setVolume(0)
    toMusic:play()

    -- Use a timer callback or coroutine
    -- Simplified version:
    return function(dt)
        timer = timer + dt
        local progress = math.min(timer / duration, 1)

        fromMusic:setVolume(fromVol * (1 - progress))
        toMusic:setVolume(fromVol * progress)

        if progress >= 1 then
            fromMusic:stop()
            return true  -- Done
        end
        return false
    end
end
```

## Best Practices

1. **Use "static" for short sounds**: Faster playback, more memory
2. **Use "stream" for music**: Less memory, slight CPU overhead
3. **Clone for overlapping sounds**: Same sound can play multiple times
4. **Pre-load in love.load**: Don't load during gameplay
5. **Pool frequently-used sounds**: Avoid creating garbage
6. **Normalize volume levels**: Keep sounds at similar perceived loudness
7. **Use OGG for distribution**: Good compression, wide support

## Common Issues

### Sound Not Playing

```lua
-- Check if audio module is available
if love.audio then
    sound:play()
end

-- Check source validity
if sound and sound:isPlaying() == false then
    sound:play()
end
```

### Audio Latency

Streaming sources have slight latency. For time-critical sounds (like footsteps synced to animation), use static sources.

### Too Many Sources

There's a limit to simultaneous audio sources. Use pools and stop sounds that are no longer needed:

```lua
function cleanup()
    for _, sound in pairs(activeSounds) do
        if not sound:isPlaying() then
            sound:release()
        end
    end
end
```
