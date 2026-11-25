# Core Architecture

Understanding Love2D's game loop, callbacks, and module system.

## The Game Loop

Love2D manages the main loop internally. You implement callbacks that it calls:

```
love.load() → [love.update() → love.draw()] → repeat
```

### love.load()

Called exactly once when the game starts. Use for:
- Loading images, sounds, fonts
- Initializing game state
- Setting up data structures

```lua
function love.load()
    player = {
        x = 100,
        y = 100,
        speed = 200,
        image = love.graphics.newImage("player.png")
    }

    enemies = {}
    score = 0
end
```

### love.update(dt)

Called every frame before drawing. The `dt` parameter is delta time—seconds since the last frame.

**Why dt matters**: Without dt, game speed depends on frame rate. A 60 FPS machine runs twice as fast as 30 FPS.

```lua
function love.update(dt)
    -- dt ≈ 0.016 at 60 FPS
    -- dt ≈ 0.033 at 30 FPS

    -- 200 pixels per second, regardless of frame rate
    player.x = player.x + 200 * dt
end
```

### love.draw()

Called every frame after update. All rendering happens here.

**Important**: Drawing order matters. Later draws appear on top.

```lua
function love.draw()
    -- Background first
    love.graphics.draw(backgroundImage, 0, 0)

    -- Game objects
    love.graphics.draw(player.image, player.x, player.y)

    -- UI on top
    love.graphics.print("Score: " .. score, 10, 10)
end
```

## Input Callbacks

### Keyboard

```lua
function love.keypressed(key, scancode, isrepeat)
    -- key: the key pressed (e.g., "space", "a", "return")
    -- isrepeat: true if this is a key repeat event
    if key == "escape" then
        love.event.quit()
    end
end

function love.keyreleased(key)
    -- Called when key is released
end
```

**Polling vs Events**:
```lua
-- Polling: check every frame (good for continuous actions)
function love.update(dt)
    if love.keyboard.isDown("left") then
        player.x = player.x - player.speed * dt
    end
end

-- Events: fire once per press (good for discrete actions)
function love.keypressed(key)
    if key == "space" then
        player:jump()  -- Jump once per press
    end
end
```

### Mouse

```lua
function love.mousepressed(x, y, button)
    -- button: 1 = left, 2 = right, 3 = middle
    if button == 1 then
        player:shoot(x, y)
    end
end

function love.mousereleased(x, y, button)
end

function love.mousemoved(x, y, dx, dy)
    -- dx, dy: movement since last call
end

function love.wheelmoved(x, y)
    -- y > 0: scroll up, y < 0: scroll down
end
```

### Touch (Mobile)

```lua
function love.touchpressed(id, x, y, dx, dy, pressure)
    -- id: unique identifier for this finger (multitouch)
end

function love.touchmoved(id, x, y, dx, dy, pressure)
end

function love.touchreleased(id, x, y, dx, dy, pressure)
end
```

## Window Callbacks

```lua
function love.resize(w, h)
    -- Called when window is resized
    screenW, screenH = w, h
    repositionUI()
end

function love.focus(focused)
    -- focused: true when window gains focus, false when loses
    if not focused then
        pauseGame()
    end
end

function love.visible(visible)
    -- visible: true when window is shown, false when hidden
end

function love.quit()
    -- Return true to abort quit
    saveGame()
    return false  -- Allow quit
end
```

## Error Handling

```lua
function love.errorhandler(msg)
    -- Custom error screen
    -- Default shows blue screen with error message
end
```

## The love.run Function

For advanced control, you can override the main loop:

```lua
function love.run()
    if love.load then love.load() end

    local dt = 0
    return function()
        love.event.pump()
        for name, a, b, c, d, e, f in love.event.poll() do
            if name == "quit" then
                return a or 0
            end
            love.handlers[name](a, b, c, d, e, f)
        end

        if love.update then love.update(dt) end

        if love.graphics and love.graphics.isActive() then
            love.graphics.origin()
            love.graphics.clear(love.graphics.getBackgroundColor())
            if love.draw then love.draw() end
            love.graphics.present()
        end

        dt = love.timer.step()
    end
end
```

## Module System

Love2D is organized into modules, each with a specific responsibility:

| Module | Purpose |
|--------|---------|
| `love.audio` | Sound playback and recording |
| `love.data` | Data transformation (compression, encoding) |
| `love.event` | Event queue management |
| `love.filesystem` | File read/write operations |
| `love.font` | Font rasterization |
| `love.graphics` | All drawing operations |
| `love.image` | Image decoding |
| `love.joystick` | Gamepad/joystick input |
| `love.keyboard` | Keyboard input |
| `love.math` | Math utilities (noise, random, shapes) |
| `love.mouse` | Mouse input |
| `love.physics` | Box2D physics engine |
| `love.sound` | Sound decoding |
| `love.system` | System information |
| `love.thread` | Threading support |
| `love.timer` | Timing functions |
| `love.touch` | Touch screen input |
| `love.video` | Video playback |
| `love.window` | Window management |

### Disabling Modules

Disable unused modules in conf.lua for faster startup:

```lua
function love.conf(t)
    t.modules.joystick = false
    t.modules.physics = false
    t.modules.video = false
end
```

## Lua Module Pattern

Organize code with Lua modules:

```lua
-- player.lua
local Player = {}
Player.__index = Player

function Player:new(x, y)
    return setmetatable({x = x, y = y}, Player)
end

function Player:update(dt) end
function Player:draw() end

return Player
```

```lua
-- main.lua
local Player = require("player")

function love.load()
    player = Player:new(100, 100)
end
```
