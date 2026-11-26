# Project Structure

File organization, configuration, and distribution.

## Minimal Project

The absolute minimum Love2D project:

```
my-game/
└── main.lua
```

```lua
-- main.lua
function love.draw()
    love.graphics.print("Hello World", 400, 300)
end
```

## Recommended Structure

For anything beyond a prototype:

```
my-game/
├── main.lua              # Entry point
├── conf.lua              # Configuration
├── assets/
│   ├── images/           # PNG, JPG files
│   ├── sounds/           # WAV, OGG files
│   ├── fonts/            # TTF, OTF files
│   └── maps/             # Level data
├── src/
│   ├── player.lua        # Player class
│   ├── enemy.lua         # Enemy class
│   ├── level.lua         # Level management
│   └── ui.lua            # UI components
├── lib/                  # Third-party libraries
│   ├── bump.lua
│   └── anim8.lua
└── states/               # Game states (optional)
    ├── menu.lua
    ├── game.lua
    └── gameover.lua
```

## conf.lua

Configuration runs before the game starts. Set window properties, enable/disable modules.

### Basic Configuration

```lua
function love.conf(t)
    t.window.title = "My Game"
    t.window.width = 800
    t.window.height = 600
end
```

### Full Configuration

```lua
function love.conf(t)
    -- Identity (used for save directory)
    t.identity = "mygame"

    -- Love2D version
    t.version = "11.5"

    -- Console (Windows only)
    t.console = false

    -- Window settings
    t.window.title = "My Game"
    t.window.icon = nil                 -- Path to icon
    t.window.width = 800
    t.window.height = 600
    t.window.borderless = false
    t.window.resizable = false
    t.window.minwidth = 400
    t.window.minheight = 300
    t.window.fullscreen = false
    t.window.fullscreentype = "desktop" -- "desktop" or "exclusive"
    t.window.vsync = 1                  -- 1 = on, 0 = off, -1 = adaptive
    t.window.msaa = 0                   -- Anti-aliasing samples
    t.window.depth = nil
    t.window.stencil = nil
    t.window.display = 1                -- Monitor index
    t.window.highdpi = false            -- Retina/HiDPI support
    t.window.usedpiscale = true

    -- Module toggles (disable unused for faster startup)
    t.modules.audio = true
    t.modules.data = true
    t.modules.event = true
    t.modules.font = true
    t.modules.graphics = true
    t.modules.image = true
    t.modules.joystick = false          -- Disable if not using gamepads
    t.modules.keyboard = true
    t.modules.math = true
    t.modules.mouse = true
    t.modules.physics = false           -- Disable if not using Box2D
    t.modules.sound = true
    t.modules.system = true
    t.modules.thread = true
    t.modules.timer = true
    t.modules.touch = true              -- Enable for mobile
    t.modules.video = false             -- Disable if not playing video
    t.modules.window = true
end
```

## main.lua Patterns

### Simple Entry Point

```lua
function love.load()
    -- Initialize
end

function love.update(dt)
    -- Update logic
end

function love.draw()
    -- Render
end
```

### With State Management

```lua
local states = {
    menu = require("states.menu"),
    game = require("states.game"),
    gameover = require("states.gameover")
}
local currentState = "menu"

function love.load()
    for _, state in pairs(states) do
        if state.load then state.load() end
    end
end

function love.update(dt)
    local state = states[currentState]
    if state.update then state.update(dt) end
end

function love.draw()
    local state = states[currentState]
    if state.draw then state.draw() end
end

function love.keypressed(key)
    local state = states[currentState]
    if state.keypressed then state.keypressed(key) end
end

function switchState(newState)
    local oldState = states[currentState]
    if oldState.exit then oldState.exit() end

    currentState = newState

    local state = states[currentState]
    if state.enter then state.enter() end
end
```

### With Globals Module

```lua
-- globals.lua
return {
    screenW = 800,
    screenH = 600,
    debug = true,
    player = nil,
    score = 0
}

-- main.lua
local G = require("globals")

function love.load()
    G.screenW, G.screenH = love.graphics.getDimensions()
    G.player = require("src.player"):new(100, 100)
end
```

## Module Pattern

### Creating a Module

```lua
-- src/player.lua
local Player = {}
Player.__index = Player

function Player:new(x, y)
    local self = setmetatable({}, Player)
    self.x = x
    self.y = y
    self.speed = 200
    self.image = love.graphics.newImage("assets/images/player.png")
    return self
end

function Player:update(dt)
    -- Movement logic
end

function Player:draw()
    love.graphics.draw(self.image, self.x, self.y)
end

return Player
```

### Using a Module

```lua
local Player = require("src.player")

function love.load()
    player = Player:new(400, 300)
end
```

## Asset Loading

### Centralized Asset Manager

```lua
-- assets.lua
local Assets = {
    images = {},
    sounds = {},
    fonts = {}
}

function Assets:loadImage(name, path)
    self.images[name] = love.graphics.newImage(path)
end

function Assets:loadSound(name, path, sourceType)
    self.sounds[name] = love.audio.newSource(path, sourceType or "static")
end

function Assets:loadFont(name, path, size)
    self.fonts[name] = love.graphics.newFont(path, size)
end

function Assets:getImage(name)
    return self.images[name]
end

function Assets:getSound(name)
    return self.sounds[name]
end

function Assets:getFont(name)
    return self.fonts[name]
end

return Assets
```

### Usage

```lua
local Assets = require("assets")

function love.load()
    Assets:loadImage("player", "assets/images/player.png")
    Assets:loadImage("enemy", "assets/images/enemy.png")
    Assets:loadSound("jump", "assets/sounds/jump.wav")
    Assets:loadFont("main", "assets/fonts/pixel.ttf", 16)
end

function love.draw()
    love.graphics.draw(Assets:getImage("player"), 100, 100)
end
```

## Save Directory

Love2D has a dedicated save directory for each game:

```lua
-- Set identity in conf.lua
t.identity = "mygame"

-- Save directory locations:
-- Windows: C:\Users\user\AppData\Roaming\LOVE\mygame
-- macOS: /Users/user/Library/Application Support/LOVE/mygame
-- Linux: ~/.local/share/love/mygame
```

### Saving Data

```lua
function saveGame()
    local data = {
        score = score,
        level = currentLevel,
        playerX = player.x,
        playerY = player.y
    }

    local serialized = "return " .. serialize(data)
    love.filesystem.write("save.lua", serialized)
end

function loadGame()
    if love.filesystem.getInfo("save.lua") then
        local chunk = love.filesystem.load("save.lua")
        local data = chunk()
        score = data.score
        currentLevel = data.level
        player.x = data.playerX
        player.y = data.playerY
    end
end

-- Simple serializer
function serialize(t)
    local parts = {"{"}
    for k, v in pairs(t) do
        local key = type(k) == "string" and k or "[" .. k .. "]"
        local val
        if type(v) == "string" then
            val = string.format("%q", v)
        elseif type(v) == "table" then
            val = serialize(v)
        else
            val = tostring(v)
        end
        table.insert(parts, key .. "=" .. val .. ",")
    end
    table.insert(parts, "}")
    return table.concat(parts)
end
```

## Distribution

### Creating a .love File

A `.love` file is a ZIP containing your game:

```bash
cd my-game
zip -9 -r ../my-game.love .
```

**Important**: `main.lua` must be at the root of the ZIP.

### Running .love Files

```bash
# macOS
/Applications/love.app/Contents/MacOS/love my-game.love

# Windows
love.exe my-game.love

# Linux
love my-game.love
```

### Creating Executables

**Windows**:
```bash
# Append .love to love.exe
copy /b love.exe+my-game.love my-game.exe
```

**macOS**:
```bash
# Copy love.app, add game.love to Resources
cp -r /Applications/love.app My-Game.app
cp my-game.love My-Game.app/Contents/Resources/
```

### Tools for Distribution

- [love-release](https://github.com/MisterDA/love-release) - Build tool for multiple platforms
- [boon](https://github.com/camchenry/boon) - Another build tool
- [makelove](https://github.com/pfirsich/makelove) - Python-based builder

## Best Practices

1. **Keep main.lua thin**: Delegate to modules
2. **Use consistent naming**: `snake_case` or `camelCase`, pick one
3. **Separate concerns**: Graphics, logic, data in different files
4. **Load assets once**: In `love.load()`, not during gameplay
5. **Use relative paths**: `assets/images/player.png`, not absolute paths
6. **Version control**: Use Git, ignore generated files
7. **Document dependencies**: List required libraries

### .gitignore for Love2D

```
# Build artifacts
*.love
*.exe
*.app/

# OS files
.DS_Store
Thumbs.db

# Editor files
*.swp
*.swo
.vscode/
.idea/

# Temporary files
*.log
```
