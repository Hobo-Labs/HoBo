# Game Loop and Modules

Understanding Love2D's game loop, callbacks, and module system.

## The Game Loop

Love2D manages the main loop internally. You implement callbacks that it calls:

```text
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
    player.x = player.x + 200 * dt
end
```

### love.draw()

Called every frame after update. All rendering happens here.

**Important**: Drawing order matters. Later draws appear on top.

```lua
function love.draw()
    love.graphics.draw(backgroundImage, 0, 0)
    love.graphics.draw(player.image, player.x, player.y)
    love.graphics.print("Score: " .. score, 10, 10)
end
```

## Input Callbacks

### Keyboard

```lua
function love.keypressed(key, scancode, isrepeat)
    if key == "escape" then
        love.event.quit()
    end
end
```

**Polling vs Events**:
```lua
function love.update(dt)
    if love.keyboard.isDown("left") then
        player.x = player.x - player.speed * dt
    end
end

function love.keypressed(key)
    if key == "space" then
        player:jump()
    end
end
```

### Mouse

```lua
function love.mousepressed(x, y, button)
    if button == 1 then
        player:shoot(x, y)
    end
end
```

### Touch (Mobile)

Love2D exposes `love.touchpressed`, `love.touchmoved`, and `love.touchreleased`; the `id` identifies one touch in a multitouch gesture.

## Window Callbacks

```lua
function love.resize(w, h)
    screenW, screenH = w, h
    repositionUI()
end

function love.focus(focused)
    if not focused then
        pauseGame()
    end
end

function love.quit()
    saveGame()
    return false
end
```

## Error Handling

Override `love.errorhandler(msg)` only when the default error screen is insufficient.

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

`player.lua`:

```lua
local Player = {}
Player.__index = Player

function Player:new(x, y)
    return setmetatable({x = x, y = y}, Player)
end

function Player:update(dt) end
function Player:draw() end

return Player
```

`main.lua`:

```lua
local Player = require("player")

function love.load()
    player = Player:new(100, 100)
end
```
